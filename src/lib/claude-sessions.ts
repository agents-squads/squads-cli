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
import { execSync } from 'child_process';
import { deriveCostFromTokens, type ObservabilityRecord } from './observability.js';
import { findSquadsDir, listSquads } from './squad-parser.js';

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
/** Claude Code encodes a session's cwd into its dir name (slashes → dashes). */
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[/.]/g, '-');
}

export async function readClaudeSessions(
  windowHours = 5,
  opts: { scope?: 'project' | 'all'; projectRoot?: string } = {},
): Promise<ClaudeSessionsSummary> {
  // #960: default is PROJECT-scoped — reading every session on the machine
  // (a user's unrelated private work) requires the explicit 'all' scope,
  // which `squads usage --all-claude` discloses when it engages.
  const scope = opts.scope ?? 'project';
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

  if (scope === 'project') {
    const root = opts.projectRoot || process.cwd();
    const rootEnc = encodeProjectDir(root);
    // The project itself + its run worktrees (…-worktrees-squads-run-<squad>-…,
    // which live one level above the project and carry its path prefix).
    const parentEnc = encodeProjectDir(join(root, '..'));
    projDirs = projDirs.filter(d =>
      d === rootEnc || d.startsWith(rootEnc + '-') ||
      (d.startsWith(parentEnc) && d.includes('worktrees')));
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

// ── Board rows (#1119): one row per Claude Code session ────────────────
//
// `squads board` reads .agents/observability/executions.jsonl, which only
// squads-cli dispatches write — Claude Code's own subagents (no dispatch
// hook spawns them) are invisible there. This derives a board-shaped row
// per session file with in-bounds activity, so the board can merge them in
// at render time. Provider is always 'claude-code' — the EXECUTOR, distinct
// from the anthropic/glm model-vendor values squads-cli dispatch rows carry.

const WORKTREE_MARKER = '-worktrees-';

/** The raw worktree/session dir basename (segment after the last
 * `-worktrees-`), or null for a repo-root (interactive) project dir. */
function worktreeDirName(encodedDir: string): string | null {
  const idx = encodedDir.lastIndexOf(WORKTREE_MARKER);
  if (idx === -1) return null;
  return encodedDir.slice(idx + WORKTREE_MARKER.length) || null;
}

/**
 * Best-effort squad/agent label for a Claude Code project dir, so the
 * board's SQUAD/AGENT column reads as `cli/issue-solver` instead of an
 * opaque encoded path. Matches known squad names (longest-prefix wins)
 * against the worktree naming conventions this repo uses:
 *   `<squad>-<agent>-<tsMs>`                          (execution-engine.ts createAgentWorktree)
 *   `squads-run-<squad>-<shortId>` / `squads-proposal-<squad>-<shortId>` (worktree.ts createRunWorktree)
 * Falls back to the raw slug when no known squad matches — never guesses
 * past what's actually on disk.
 */
export function attributeSquadAgent(dirName: string, knownSquads: string[] = []): { squad: string; agent: string } {
  const worktreeName = worktreeDirName(dirName);
  if (worktreeName === null) {
    const segments = dirName.split('-').filter(Boolean);
    return { squad: 'interactive', agent: segments[segments.length - 1] || 'session' };
  }

  const stripped = worktreeName.replace(/^squads-(run|proposal)-/, '');
  const base = /^(.+)-(\d{13})$/.exec(stripped)?.[1] ?? stripped;

  const match = knownSquads
    .filter((name) => base === name || base.startsWith(`${name}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (match) {
    const rest = base.slice(match.length + 1);
    return { squad: match, agent: rest || 'worktree' };
  }

  const dash = base.indexOf('-');
  if (dash === -1) return { squad: base, agent: 'worktree' };
  return { squad: base.slice(0, dash), agent: base.slice(dash + 1) };
}

/** Stream one session file and fold its in-bounds lines into a single row. */
function deriveRowForSessionFile(
  filePath: string,
  sessionId: string,
  projDir: string,
  bounds: { start: number; end: number },
  knownSquads: string[],
): Promise<ObservabilityRecord | null> {
  return new Promise((resolve) => {
    let rl: ReturnType<typeof createInterface>;
    try {
      rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    } catch {
      resolve(null);
      return;
    }

    let firstTs: number | null = null;
    let lastTs: number | null = null;
    let model = '';
    const tokens: Tokens = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

    rl.on('line', (line) => {
      const parsed = parseSessionLine(line);
      if (!parsed) return;
      const { tokens: t, model: m, tsMs } = parsed;
      if (Number.isNaN(tsMs) || tsMs < bounds.start || tsMs >= bounds.end) return;
      if (firstTs === null || tsMs < firstTs) firstTs = tsMs;
      if (lastTs === null || tsMs > lastTs) lastTs = tsMs;
      if (m) model = m;
      tokens.input_tokens += t.input_tokens;
      tokens.output_tokens += t.output_tokens;
      tokens.cache_read_tokens += t.cache_read_tokens;
      tokens.cache_write_tokens += t.cache_write_tokens;
    });
    rl.on('close', () => {
      if (firstTs === null) { resolve(null); return; }
      const { squad, agent } = attributeSquadAgent(projDir, knownSquads);
      resolve({
        ts: new Date(firstTs).toISOString(),
        id: `claude:${sessionId}`,
        squad,
        agent,
        provider: 'claude-code',
        model: model || 'unknown',
        // Same session UUID a squads-cli ledger row would carry for this run
        // (#1129) — lets the board merge dedup instead of double-counting.
        session_id: sessionId,
        trigger: 'manual',
        status: 'completed',
        duration_ms: Math.max(0, (lastTs ?? firstTs) - firstTs),
        input_tokens: tokens.input_tokens,
        output_tokens: tokens.output_tokens,
        cache_read_tokens: tokens.cache_read_tokens,
        cache_write_tokens: tokens.cache_write_tokens,
        cost_usd: deriveCostFromTokens(tokens, model),
        context_tokens: 0,
        source: 'claude-code',
        cost_estimated: true,
      });
    });
    rl.on('error', () => resolve(null));
  });
}

/**
 * One board row per Claude Code session (interactive or subagent-spawned)
 * with activity inside `bounds` — the Claude-harness half of the fleet
 * `executions.jsonl` never sees (no dispatch hook exists for Claude Code's
 * own subagents, so this is transcript-derived, not ledger-at-spawn).
 *
 * Cost is notional (list-price token proxy, `cost_estimated: true`) — same
 * caveat as `readClaudeSessions`. Streams every file line-by-line; never
 * loads a whole session into memory. Project-scoped by default (mirrors
 * `squads usage`'s #960 privacy default — reading every session on the
 * machine needs an explicit 'all' scope).
 */
export async function deriveClaudeHarnessRows(
  bounds: { start: number; end: number },
  opts: { scope?: 'project' | 'all'; projectRoot?: string } = {},
): Promise<ObservabilityRecord[]> {
  const scope = opts.scope ?? 'project';
  const projectsDir = getClaudeProjectsDir();
  if (!existsSync(projectsDir)) return [];

  let projDirs: string[];
  try {
    projDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }

  if (scope === 'project') {
    const root = opts.projectRoot || process.cwd();
    const rootEnc = encodeProjectDir(root);
    const parentEnc = encodeProjectDir(join(root, '..'));
    projDirs = projDirs.filter(d =>
      d === rootEnc || d.startsWith(rootEnc + '-') ||
      (d.startsWith(parentEnc) && d.includes('worktrees')));
  }

  let knownSquads: string[] = [];
  try {
    const squadsDir = findSquadsDir();
    if (squadsDir) knownSquads = listSquads(squadsDir);
  } catch { /* attribution degrades to raw slugs */ }

  const rows: ObservabilityRecord[] = [];
  for (const projDir of projDirs) {
    const projPath = join(projectsDir, projDir);
    try {
      if (!statSync(projPath).isDirectory()) continue;
    } catch {
      continue;
    }

    let files: string[];
    try {
      files = readdirSync(projPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = join(projPath, file);
      try {
        // Nothing written since the day started → nothing to read (cheap gate).
        if (statSync(filePath).mtimeMs < bounds.start) continue;
      } catch {
        continue;
      }
      const sessionId = file.slice(0, -'.jsonl'.length);
      const row = await deriveRowForSessionFile(filePath, sessionId, projDir, bounds, knownSquads);
      if (row) rows.push(row);
    }
  }

  return rows;
}

// ── OpenCode session reader ───────────────────────────────────────────

function getOpenCodeDbPath(): string {
  const dataDir = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(dataDir, 'opencode', 'opencode.db');
}

function parseOpenCodeModel(raw: string): string {
  if (!raw) return '';
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    return typeof m.id === 'string' ? m.id : '';
  } catch {
    return '';
  }
}

function parseOpenCodeProvider(raw: string): string {
  if (!raw) return '';
  try {
    const m = JSON.parse(raw) as Record<string, unknown>;
    return typeof m.providerID === 'string' ? m.providerID : '';
  } catch {
    return '';
  }
}

/**
 * Derive execution rows from the opencode SQLite database — the opencode
 * equivalent of `deriveClaudeHarnessRows`. opencode stores every session in
 * `~/.local/share/opencode/opencode.db` with token counts and cost already
 * aggregated per session, so we don't need to stream message-by-message.
 *
 * Cost is real (opencode tracks actual provider cost), not a notional
 * estimate — we still mark `cost_estimated: false` to distinguish from
 * Claude Code's list-price proxy.
 */
export async function deriveOpenCodeRows(
  bounds: { start: number; end: number },
  opts: { projectRoot?: string } = {},
): Promise<ObservabilityRecord[]> {
  const dbPath = getOpenCodeDbPath();
  if (!existsSync(dbPath)) return [];

  const root = opts.projectRoot || process.cwd();

  const knownSquads: string[] = [];
  try {
    const squadsDir = findSquadsDir();
    if (squadsDir) knownSquads.push(...listSquads(squadsDir));
  } catch { /* attribution degrades to raw slugs */ }

  let raw: string;
  try {
    // SQL-escape the directory (double any single quote) — a path like
    // .../jorge's-repo would otherwise terminate the SQL string literal.
    const dir = root.replace(/'/g, "''");
    const sql =
      `SELECT id, directory, time_created, time_updated, cost, ` +
      `tokens_input, tokens_output, tokens_cache_read, ` +
      `tokens_cache_write, tokens_reasoning, model, agent FROM session ` +
      `WHERE directory = '${dir}' ` +
      `AND time_updated >= ${bounds.start} AND time_created < ${bounds.end} ` +
      `ORDER BY time_created ASC`;
    raw = execSync(`sqlite3 -json "${dbPath.replace(/"/g, '\\"')}" ${JSON.stringify(sql)}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  } catch {
    return [];
  }

  if (!raw) return [];

  let rows: Array<Record<string, unknown>>;
  try {
    rows = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) return [];
  } catch {
    return [];
  }

  return rows.map((r) => {
    const directory = String(r.directory || '');
    const modelJson = String(r.model || '');
    const provider = parseOpenCodeProvider(modelJson);
    const modelId = parseOpenCodeModel(modelJson);
    const id = String(r.id || '');
    const agent = String(r.agent || '');
    const cost = Number(r.cost) || 0;
    const inputTokens = Number(r.tokens_input) || 0;
    const outputTokens = Number(r.tokens_output) || 0;
    const cacheRead = Number(r.tokens_cache_read) || 0;
    const cacheWrite = Number(r.tokens_cache_write) || 0;
    const created = Number(r.time_created);
    const updated = Number(r.time_updated);

    const dirSegments = directory.split('/').filter(Boolean);
    const lastSeg = dirSegments[dirSegments.length - 1] || 'session';
    const squad = knownSquads.includes(lastSeg) ? lastSeg : 'interactive';
    const agentTag = agent || 'opencode';

    return {
      ts: new Date(created).toISOString(),
      id: `opencode:${id}`,
      squad,
      agent: squad === 'interactive' ? lastSeg : agentTag,
      provider: provider || 'opencode',
      model: modelId || 'unknown',
      session_id: id,
      trigger: 'manual' as const,
      status: 'completed' as const,
      duration_ms: Math.max(0, updated - created),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      cost_usd: cost,
      context_tokens: 0,
      source: 'opencode' as ObservabilityRecord['source'],
      cost_estimated: false,
    };
  });
}
