/**
 * `squads board` — day-scoped execution board (#1116).
 *
 * One screen for a day of heavy dispatching: tiles (executions · PRs ·
 * est. cost · failures), live detached runs, the day's executions from
 * .agents/observability/executions.jsonl merged with Claude-harness
 * sessions read from ~/.claude/projects (#1119 — squads-cli dispatches are
 * only half the fleet; Claude Code's own subagents have no dispatch hook to
 * write a ledger row, so they're merged in at render time instead), and
 * what's queued next (instance dispatch queue + active-milestone issues).
 *
 * Row provenance: every EXECUTIONS row (and --json `executions` entry)
 * carries `source: 'ledger' | 'claude-code'`. Claude-harness rows always
 * show provider `claude-code` (the EXECUTOR, not the underlying model) and
 * `cost_estimated: true` — their cost is a notional list-price token proxy,
 * flagged with a `~` in the COST column, never presented as a real bill.
 *
 * Cost honesty: tiles sum cost_usd; a row with cost_usd 0 but recorded
 * tokens renders its tokens (dimmed) instead of $0.00 — never a fabricated
 * price. GLM-lane rows stay $0 unless SQUADS_GLM_COST_PER_MTOK_IN/OUT env
 * rates are set (#1085 discards the CLI's Claude-rate figure by design).
 *
 * Everything degrades gracefully: no ledger → empty sections with a dim
 * hint; API unreachable → INCOMING (a) skipped with a dim note; gh
 * unavailable → INCOMING (b) skipped. Works right after `squads init`.
 */

import { execSync } from 'child_process';
import { queryExecutions, type ObservabilityRecord } from '../lib/observability.js';
import { deriveClaudeHarnessRows } from '../lib/claude-sessions.js';
import { listDetachedRuns } from '../lib/runs-inventory.js';
import { formatDuration } from '../lib/executions.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  icons,
  writeLine,
} from '../lib/terminal.js';

// ── Options ──────────────────────────────────────────────────────────

export interface BoardOptions {
  json?: boolean;
  /** YYYY-MM-DD (local time). Default: today. */
  date?: string;
}

// ── Day scoping (local time) ─────────────────────────────────────────

export interface DayBounds {
  start: number;
  end: number;
  /** YYYY-MM-DD label for headers and --json. */
  label: string;
}

/**
 * Resolve `--date YYYY-MM-DD` (or today when absent) to local-midnight
 * bounds. Returns null for an unparseable date — callers print the error.
 */
export function dayBounds(dateStr?: string): DayBounds | null {
  let base: Date;
  if (dateStr === undefined) {
    base = new Date();
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
    if (!m) return null;
    base = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    // Reject impossible dates (e.g. 2026-02-31 rolls over in JS).
    if (base.getMonth() !== parseInt(m[2], 10) - 1 || base.getDate() !== parseInt(m[3], 10)) {
      return null;
    }
  }
  base.setHours(0, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    start: base.getTime(),
    end: base.getTime() + 24 * 60 * 60 * 1000,
    label: `${base.getFullYear()}-${pad(base.getMonth() + 1)}-${pad(base.getDate())}`,
  };
}

/** Ledger records inside the day, sorted by time ascending. */
export function filterLedgerDay(records: ObservabilityRecord[], bounds: DayBounds): ObservabilityRecord[] {
  return records
    .filter((r) => {
      const t = new Date(r.ts).getTime();
      return !Number.isNaN(t) && t >= bounds.start && t < bounds.end;
    })
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
}

// ── Tiles ────────────────────────────────────────────────────────────

export interface BoardTiles {
  executions: number;
  prs_created: number;
  issues_created: number;
  commits: number;
  /** Sum of cost_usd — the only figure we can honestly price. */
  cost_usd: number;
  /** Rows with cost_usd 0 but recorded tokens (cost unknown, not free). */
  uncosted_runs: number;
  uncosted_tokens: number;
  failures: number;
}

function recordTokens(r: ObservabilityRecord): number {
  return (r.input_tokens || 0) + (r.output_tokens || 0)
    + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
}

export function buildTiles(records: ObservabilityRecord[]): BoardTiles {
  const tiles: BoardTiles = {
    executions: records.length,
    prs_created: 0,
    issues_created: 0,
    commits: 0,
    cost_usd: 0,
    uncosted_runs: 0,
    uncosted_tokens: 0,
    failures: 0,
  };
  for (const r of records) {
    tiles.prs_created += r.prs_created || 0;
    tiles.issues_created += r.issues_created || 0;
    tiles.commits += r.commits || 0;
    tiles.cost_usd += r.cost_usd || 0;
    if (r.status === 'failed' || r.status === 'timeout') tiles.failures += 1;
    const tokens = recordTokens(r);
    if (!(r.cost_usd > 0) && tokens > 0) {
      tiles.uncosted_runs += 1;
      tiles.uncosted_tokens += tokens;
    }
  }
  return tiles;
}

// ── Per-row cost honesty ─────────────────────────────────────────────

export interface CostCell {
  kind: 'cost' | 'tokens' | 'none';
  text: string;
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Reprice GLM runs at display time when env rates are now set.
 * GLM runs recorded with cost_usd=0 (because env rates weren't set at run time)
 * are re-priced using current SQUADS_GLM_COST_PER_MTOK_IN/OUT values.
 * This is display-only; the ledger is not modified.
 */
export function repriceIfNeeded(r: ObservabilityRecord): ObservabilityRecord {
  // Only reprice GLM provider records with cost_usd=0 but tokens>0
  if (r.provider !== 'glm' || r.cost_usd > 0) return r;
  const tokens = (r.input_tokens || 0) + (r.output_tokens || 0);
  if (tokens === 0) return r;

  const inRate = parseFloat(process.env.SQUADS_GLM_COST_PER_MTOK_IN || '');
  const outRate = parseFloat(process.env.SQUADS_GLM_COST_PER_MTOK_OUT || '');
  if (!Number.isFinite(inRate) || !Number.isFinite(outRate)) return r;

  const recost = ((r.input_tokens || 0) * inRate + (r.output_tokens || 0) * outRate) / 1_000_000;
  return { ...r, cost_usd: recost };
}

/**
 * The rendering decision the issue mandates: cost when we have one, tokens
 * (dimmed by the renderer) when the row is 0-cost but burned tokens, an
 * em-dash when there is neither. Never prints $0.00 for real work.
 */
export function costCell(r: Pick<ObservabilityRecord, 'cost_usd' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>): CostCell {
  if (r.cost_usd > 0) return { kind: 'cost', text: formatCost(r.cost_usd) };
  const tokens = (r.input_tokens || 0) + (r.output_tokens || 0)
    + (r.cache_read_tokens || 0) + (r.cache_write_tokens || 0);
  if (tokens > 0) return { kind: 'tokens', text: `${formatTokens(tokens)} tok` };
  return { kind: 'none', text: '—' };
}

/** Compact outcomes summary for a row: "2pr 3c 1iss" (empty when unknown). */
export function outcomesCell(r: ObservabilityRecord): string {
  const parts: string[] = [];
  if (r.prs_created) parts.push(`${r.prs_created}pr`);
  if (r.commits) parts.push(`${r.commits}c`);
  if (r.issues_created) parts.push(`${r.issues_created}iss`);
  return parts.join(' ');
}

// ── INCOMING (a): instance dispatch queue ────────────────────────────

export interface IncomingDispatch {
  id: number;
  squad: string;
  agent: string;
  trigger_type?: string;
  created_at?: string;
}

/**
 * Unprocessed agent_dispatch_queue rows from the instance API. Returns null
 * on ANY miss (no API configured, no key, unreachable, non-200) — the board
 * renders a dim note instead of crashing (code rule: graceful degradation).
 */
async function fetchIncomingDispatches(): Promise<IncomingDispatch[] | null> {
  try {
    const { getApiUrl } = await import('../lib/env-config.js');
    const apiUrl = getApiUrl();
    if (!apiUrl) return null;
    const apiKey = process.env.SCHEDULER_API_KEY;
    if (!apiKey) return null; // pending endpoint is scheduler-key gated
    const res = await fetch(`${apiUrl}/agent-dispatch/pending?limit=10`, {
      headers: { 'X-API-Key': apiKey },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    return Array.isArray(data) ? (data as IncomingDispatch[]) : null;
  } catch {
    return null;
  }
}

// ── INCOMING (b): active-milestone issues via gh ─────────────────────

export interface MilestoneQueue {
  milestone: string;
  issues: Array<{ number: number; title: string }>;
}

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * Open issues in the repo's nearest-due open milestone. Repo comes from the
 * git remote (never hardcoded); returns null when gh/network/remote is
 * unavailable — the board renders a dim note.
 */
async function fetchMilestoneQueue(): Promise<MilestoneQueue | null> {
  try {
    const { detectGitHubRepo } = await import('../lib/github.js');
    const repo = detectGitHubRepo();
    if (!repo) return null;
    const title = execSync(
      `gh api ${sq(`repos/${repo}/milestones?state=open&sort=due_on&direction=asc`)} --jq '.[0].title' 2>/dev/null`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 },
    ).trim();
    if (!title) return null;
    const out = execSync(
      `gh issue list --repo ${sq(repo)} --milestone ${sq(title)} --state open --json number,title --limit 10 2>/dev/null`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 8000 },
    );
    const issues = JSON.parse(out) as Array<{ number: number; title: string }>;
    if (!Array.isArray(issues)) return null;
    return { milestone: title, issues };
  } catch {
    return null;
  }
}

// ── Command ──────────────────────────────────────────────────────────

export async function boardCommand(options: BoardOptions = {}): Promise<void> {
  const bounds = dayBounds(options.date);
  if (!bounds) {
    writeLine(`  ${colors.red}Invalid --date '${options.date}' — expected YYYY-MM-DD${RESET}`);
    process.exitCode = 1;
    return;
  }

  // hq#450 D2: ingest done-files from detached runs before reading the ledger.
  try {
    const { getProjectRoot } = await import('../lib/run-utils.js');
    const { reconcileDetachedRuns } = await import('../lib/spool.js');
    reconcileDetachedRuns(getProjectRoot());
  } catch { /* read paths never break on spool issues */ }

  // Ledger (never crashes: queryExecutions returns [] without a file) —
  // tagged 'ledger' so every merged row carries a source (#1119).
  const ledgerRecords: ObservabilityRecord[] = filterLedgerDay(queryExecutions({}), bounds)
    .map((r) => ({ ...r, source: r.source ?? 'ledger' }));

  // Claude-harness sessions (#1119): squads-cli never dispatched these, so
  // there's no ledger row — derive them from ~/.claude/projects transcripts
  // instead. Degrades to [] on any read failure (never breaks the board).
  let harnessRecords: ObservabilityRecord[] = [];
  try {
    const { getProjectRoot } = await import('../lib/run-utils.js');
    harnessRecords = await deriveClaudeHarnessRows(bounds, { projectRoot: getProjectRoot() });
  } catch { /* transcript reads never break the board */ }

  const dayRecords = [...ledgerRecords, ...harnessRecords]
    .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    .map(repriceIfNeeded); // #1118: reprice GLM runs when env rates now set
  const tiles = buildTiles(dayRecords);

  // Live detached runs — same source as `squads runs`.
  let running: ReturnType<typeof listDetachedRuns> = [];
  try {
    const { getProjectRoot } = await import('../lib/run-utils.js');
    running = listDetachedRuns(getProjectRoot()).filter((r) => r.alive);
  } catch { /* outside a project — leave empty */ }

  // Incoming — both legs degrade to null, fetched in parallel.
  const [dispatches, milestoneQueue] = await Promise.all([
    fetchIncomingDispatches(),
    fetchMilestoneQueue(),
  ]);

  if (options.json) {
    console.log(JSON.stringify({
      ok: true,
      command: 'board',
      date: bounds.label,
      tiles,
      running: running.map((r) => ({
        squad: r.squad, agent: r.agent, pid: r.pid, startedAt: r.startedAt, logFile: r.logFile,
      })),
      executions: dayRecords,
      incoming: {
        dispatches,
        milestone: milestoneQueue,
      },
    }, null, 2));
    return;
  }

  renderBoard(bounds, tiles, dayRecords, running, dispatches, milestoneQueue);
}

// ── Rendering ────────────────────────────────────────────────────────

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function elapsed(startedAt: number): string {
  const ms = Date.now() - startedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function renderBoard(
  bounds: DayBounds,
  tiles: BoardTiles,
  records: ObservabilityRecord[],
  running: ReturnType<typeof listDetachedRuns>,
  dispatches: IncomingDispatch[] | null,
  milestoneQueue: MilestoneQueue | null,
): void {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}board${RESET} ${colors.dim}·${RESET} ${colors.white}${bounds.label}${RESET}`);
  writeLine();

  // ── Tiles ──
  const costTile = tiles.cost_usd > 0
    ? `${colors.green}${formatCost(tiles.cost_usd)}${RESET} est. cost`
    : `${colors.dim}$0.00 est. cost${RESET}`;
  const tileParts = [
    `${colors.cyan}${tiles.executions}${RESET} executions`,
    `${colors.green}${tiles.prs_created}${RESET} PRs created`,
    costTile,
    tiles.failures > 0
      ? `${colors.red}${tiles.failures}${RESET} failed`
      : `${colors.dim}0 failed${RESET}`,
  ];
  writeLine(`  ${tileParts.join(`  ${colors.dim}│${RESET}  `)}`);
  if (tiles.uncosted_runs > 0) {
    writeLine(`  ${colors.dim}${tiles.uncosted_runs} run(s) uncosted — ${formatTokens(tiles.uncosted_tokens)} tokens with no price (set SQUADS_GLM_COST_PER_MTOK_IN/OUT for GLM lanes)${RESET}`);
  }
  writeLine();

  // ── RUNNING ──
  writeLine(`  ${bold}RUNNING${RESET}`);
  if (running.length === 0) {
    writeLine(`  ${colors.dim}No live background runs${RESET}`);
  } else {
    for (const r of running) {
      writeLine(`  ${colors.green}●${RESET} ${colors.cyan}${r.squad}/${r.agent}${RESET}  ${colors.dim}pid ${r.pid} · up ${elapsed(r.startedAt)}${RESET}`);
    }
  }
  writeLine();

  // ── EXECUTIONS ──
  writeLine(`  ${bold}EXECUTIONS${RESET} ${colors.dim}(${bounds.label})${RESET}`);
  if (records.length === 0) {
    writeLine(`  ${colors.dim}No executions recorded — runs land here after \`squads run <squad>\`${RESET}`);
    writeLine();
  } else {
    writeLine();
    // prov: 12 fits 'claude-code' (11 chars) untruncated — the #1119 executor tag.
    const w = { time: 7, agent: 24, prov: 12, status: 12, dur: 8, tokens: 13, cost: 11, out: 9 };
    const tableWidth = w.time + w.agent + w.prov + w.status + w.dur + w.tokens + w.cost + w.out + 1;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
    writeLine(
      `  ${colors.purple}${box.vertical}${RESET} ` +
      `${bold}${padEnd('TIME', w.time)}${RESET}` +
      `${bold}${padEnd('SQUAD/AGENT', w.agent)}${RESET}` +
      `${bold}${padEnd('PROVIDER', w.prov)}${RESET}` +
      `${bold}${padEnd('STATUS', w.status)}${RESET}` +
      `${bold}${padEnd('DUR', w.dur)}${RESET}` +
      `${bold}${padEnd('TOKENS I/O', w.tokens)}${RESET}` +
      `${bold}${padEnd('COST', w.cost)}${RESET}` +
      `${bold}${padEnd('OUT', w.out)}${RESET}` +
      `${colors.purple}${box.vertical}${RESET}`,
    );
    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const r of records) {
      const agentLabel = `${r.squad}/${r.agent}`;
      const shortAgent = agentLabel.length > w.agent - 1 ? agentLabel.slice(0, w.agent - 2) + '…' : agentLabel;
      const shortProv = (r.provider || '—').length > w.prov - 1 ? r.provider.slice(0, w.prov - 2) + '…' : (r.provider || '—');

      const statusIcon = r.status === 'completed' ? icons.success : r.status === 'failed' ? icons.error : icons.warning;
      const statusColor = r.status === 'completed' ? colors.green : r.status === 'failed' ? colors.red : colors.yellow;

      const cell = costCell(r);
      const costStr = cell.kind === 'cost'
        ? `${colors.green}${r.cost_estimated ? '~' : ''}${cell.text}${RESET}`
        : `${colors.dim}${cell.text}${RESET}`;

      const outStr = outcomesCell(r);

      writeLine(
        `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.dim}${padEnd(formatClock(r.ts), w.time)}${RESET}` +
        `${colors.cyan}${padEnd(shortAgent, w.agent)}${RESET}` +
        `${padEnd(shortProv, w.prov)}` +
        `${padEnd(`${statusIcon} ${statusColor}${r.status}${RESET}`, w.status)}` +
        `${padEnd(formatDuration(r.duration_ms), w.dur)}` +
        `${colors.dim}${padEnd(`${formatTokens(r.input_tokens || 0)}/${formatTokens(r.output_tokens || 0)}`, w.tokens)}${RESET}` +
        `${padEnd(costStr, w.cost)}` +
        `${outStr ? colors.green : colors.dim}${padEnd(outStr || '—', w.out)}${RESET}` +
        `${colors.purple}${box.vertical}${RESET}`,
      );
    }
    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
    if (records.some((r) => r.cost_estimated)) {
      writeLine(`  ${colors.dim}~ = notional list-price estimate (Claude Code session, not a bill)${RESET}`);
    }
    writeLine();
  }

  // ── INCOMING ──
  writeLine(`  ${bold}INCOMING${RESET}`);
  if (dispatches === null) {
    writeLine(`  ${colors.dim}dispatch queue: no instance API reachable — skipped${RESET}`);
  } else if (dispatches.length === 0) {
    writeLine(`  ${colors.dim}dispatch queue: empty${RESET}`);
  } else {
    for (const d of dispatches) {
      writeLine(`  ${icons.pending} ${colors.cyan}${d.squad}/${d.agent}${RESET} ${colors.dim}${d.trigger_type || 'queued'} · #${d.id}${RESET}`);
    }
  }
  if (milestoneQueue === null) {
    writeLine(`  ${colors.dim}milestone queue: gh unavailable or no open milestone — skipped${RESET}`);
  } else if (milestoneQueue.issues.length === 0) {
    writeLine(`  ${colors.dim}milestone '${milestoneQueue.milestone}': no open issues${RESET}`);
  } else {
    writeLine(`  ${colors.dim}milestone${RESET} ${colors.purple}${milestoneQueue.milestone}${RESET}`);
    for (const issue of milestoneQueue.issues) {
      const title = issue.title.length > 60 ? issue.title.slice(0, 57) + '...' : issue.title;
      writeLine(`  ${icons.pending} ${colors.cyan}#${issue.number}${RESET} ${title}`);
    }
  }
  writeLine();
}
