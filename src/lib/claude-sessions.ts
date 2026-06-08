/**
 * Claude Code session reader — the REAL usage window, not just what squads-cli
 * spawns.
 *
 * Claude Code logs EVERY session (interactive + agent-spawned) to
 *   ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl
 * one JSON object per line. The interactive sessions (a human driving Claude
 * Code) are usually the bigger token consumer, and they're invisible to the
 * executions.jsonl capture in observability.ts (which only sees squad runs).
 *
 * This module streams those session files line-by-line (some are >4000 lines /
 * ~1M tokens — we never load a whole file into memory), sums `message.usage`
 * off `assistant` events, prices it via MODEL_PRICING, and attributes each
 * session to `interactive` vs `squad` by its project dir name.
 *
 * On a Max subscription the dollar figure is NOTIONAL — a usage proxy derived
 * from published per-token list prices, NOT what's billed. Tokens are the real
 * quota unit; cost is shown alongside for intuition.
 *
 * Read-only, local-first. No new dependencies (node:fs + node:readline only).
 * Graceful if ~/.claude/projects is missing/empty.
 */

import { existsSync, readdirSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { deriveCostFromTokens } from './observability.js';

export type Attribution = 'interactive' | 'squad';

export interface SessionBucket {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Number of assistant messages summed into this bucket. */
  messages: number;
}

export interface SessionSplit {
  interactive: SessionBucket;
  squad: SessionBucket;
  total: SessionBucket;
}

export interface ClaudeSessionsSummary {
  /** Since local midnight (calendar day). */
  today: SessionSplit;
  /** Rolling window (last `windowHours` hours). */
  window: SessionSplit;
  windowHours: number;
  /** Number of session files scanned. */
  filesScanned: number;
  /** True when ~/.claude/projects was found. */
  available: boolean;
}

function emptyBucket(): SessionBucket {
  return { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, messages: 0 };
}

function emptySplit(): SessionSplit {
  return { interactive: emptyBucket(), squad: emptyBucket(), total: emptyBucket() };
}

export function totalTokens(b: SessionBucket): number {
  return b.input_tokens + b.output_tokens + b.cache_read_tokens + b.cache_write_tokens;
}

/** Default location of Claude Code's per-project session logs. */
export function getClaudeProjectsDir(): string {
  return join(process.env.HOME || homedir(), '.claude', 'projects');
}

/**
 * Attribute a session by its encoded project-dir name. Claude Code encodes the
 * session's cwd into the dir name (slashes → dashes). squads-cli runs each squad
 * inside a per-run git worktree under `.worktrees/squads-run-<squad>-<id>` (and
 * older per-agent worktrees under `.worktrees/<squad>-<agent>-<ts>`), so any dir
 * whose name carries a worktree segment is a SQUAD session; everything else
 * (the repo roots a human opens — hq, squads-cli, …) is INTERACTIVE.
 */
export function attributeProjectDir(dirName: string): Attribution {
  if (dirName.includes('squads-run') || dirName.includes('-worktrees-') || dirName.includes('worktrees')) {
    return 'squad';
  }
  return 'interactive';
}

interface Tokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

/**
 * Parse one session-log line. Returns the tokens + model + timestamp for an
 * `assistant` message that carries usage, else null. Pure + exported so the
 * line attribution / accumulation is unit-testable against a fixture.
 */
export function parseSessionLine(line: string): { tokens: Tokens; model: string; tsMs: number } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let rec: Record<string, unknown>;
  try {
    rec = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (rec.type !== 'assistant') return null;
  const msg = (rec.message as Record<string, unknown>) || {};
  const u = (msg.usage as Record<string, number>) || {};
  const tokens: Tokens = {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    cache_read_tokens: u.cache_read_input_tokens || 0,
    cache_write_tokens: u.cache_creation_input_tokens || 0,
  };
  if (!tokens.input_tokens && !tokens.output_tokens && !tokens.cache_read_tokens && !tokens.cache_write_tokens) {
    return null;
  }
  const model = typeof msg.model === 'string' ? msg.model : '';
  // Top-level `timestamp` is an ISO string on Claude Code session lines.
  const tsMs = typeof rec.timestamp === 'string' ? new Date(rec.timestamp).getTime() : NaN;
  return { tokens, model, tsMs };
}

function addToBucket(b: SessionBucket, t: Tokens, model: string): void {
  b.input_tokens += t.input_tokens;
  b.output_tokens += t.output_tokens;
  b.cache_read_tokens += t.cache_read_tokens;
  b.cache_write_tokens += t.cache_write_tokens;
  b.cost_usd += deriveCostFromTokens(t, model);
  b.messages += 1;
}

/** Stream one session file, folding each qualifying assistant line into the summary. */
function streamSessionFile(
  filePath: string,
  attribution: Attribution,
  todayMs: number,
  windowMs: number,
  summary: ClaudeSessionsSummary,
): Promise<void> {
  return new Promise((resolve) => {
    let rl: ReturnType<typeof createInterface>;
    try {
      rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    } catch {
      resolve();
      return;
    }
    rl.on('line', (line) => {
      const parsed = parseSessionLine(line);
      if (!parsed) return;
      const { tokens, model, tsMs } = parsed;
      // Cost-per-message is the same regardless of which window it lands in, so
      // bucket by timestamp. A line with no/invalid timestamp can't be windowed
      // — skip it from the time-bounded views (rare; only affects malformed lines).
      if (Number.isNaN(tsMs)) return;
      if (tsMs >= todayMs) {
        addToBucket(summary.today[attribution], tokens, model);
        addToBucket(summary.today.total, tokens, model);
      }
      if (tsMs >= windowMs) {
        addToBucket(summary.window[attribution], tokens, model);
        addToBucket(summary.window.total, tokens, model);
      }
    });
    rl.on('close', () => resolve());
    rl.on('error', () => resolve()); // unreadable file — skip, never crash
  });
}

/**
 * Read ALL Claude Code sessions and roll up tokens + notional cost, split by
 * interactive vs squad attribution, for both today and the rolling window.
 *
 * Streams every file; never loads a whole session into memory. Returns a
 * zeroed-but-`available:false` summary when ~/.claude/projects is missing.
 */
export async function readClaudeSessions(windowHours = 5): Promise<ClaudeSessionsSummary> {
  const projectsDir = getClaudeProjectsDir();
  const summary: ClaudeSessionsSummary = {
    today: emptySplit(),
    window: emptySplit(),
    windowHours,
    filesScanned: 0,
    available: existsSync(projectsDir),
  };
  if (!summary.available) return summary;

  const now = Date.now();
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const windowMs = now - windowHours * 60 * 60 * 1000;

  let projDirs: string[];
  try {
    projDirs = readdirSync(projectsDir);
  } catch {
    return summary;
  }

  for (const projDir of projDirs) {
    const projPath = join(projectsDir, projDir);
    try {
      if (!statSync(projPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const attribution = attributeProjectDir(projDir);

    let files: string[];
    try {
      files = readdirSync(projPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(projPath, file);
      // Skip files untouched since before the window AND before today — their
      // newest line can't fall inside either view, so there's nothing to read.
      // (Cheap mtime gate to avoid streaming cold history.)
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime < todayMs && mtime < windowMs) continue;
      } catch {
        continue;
      }
      summary.filesScanned += 1;
      await streamSessionFile(filePath, attribution, todayMs, windowMs, summary);
    }
  }

  return summary;
}
