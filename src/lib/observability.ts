/**
 * Local observability — execution logging to JSONL with token capture.
 *
 * Every squads run appends one record to .agents/observability/executions.jsonl.
 * Token/cost data is captured from Claude Code's session JSONL files after run.
 *
 * No external dependencies. Git-tracked. Readable by agents and humans.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { findProjectRoot } from './squad-parser.js';
import { parseOutcomes, emptyOutcomes, addOutcomes, type RunOutcomes, type AssistantContentBlock } from './stream-json.js';

// ── Types ────────────────────────────────────────────────────────────

export interface GoalChange {
  name: string;
  before: string; // status before run
  after: string;  // status after run
}

export interface ObservabilityRecord {
  ts: string;
  id: string;
  squad: string;
  agent: string;
  provider: string;
  model: string;
  // Claude Code session UUID this run's transcript was written under (#1129).
  // Detached runs: the id the wrapper was launched with (`--session-id`, #857).
  // Foreground runs: the basename of the session file run-capture located.
  // Absent for non-Claude providers and for rows written before this field
  // existed — no backfill; downstream mergers keep their prior heuristics.
  session_id?: string;
  trigger: 'manual' | 'scheduled' | 'event' | 'smart';
  // 'running' rows are start events (run-ledger): the jsonl is an event log,
  // and a run's current state is its LAST row (fold by id). 'orphaned' is the
  // reaper's terminal for a running row whose pid died without reporting.
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'orphaned';
  duration_ms: number;
  // OS pid of the run's process (start events) — what the orphan reaper
  // checks liveness against. Absent on rows predating the ledger.
  pid?: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  context_tokens: number;
  // What the agent DID this run (parsed from its tool_use blocks) — real output,
  // not just spend. Lets "did squad X move its backlog?" be a query, not a guess.
  actions?: number;        // total tool calls (0 ≈ noise)
  files_edited?: number;
  commits?: number;
  prs_created?: number;
  issues_created?: number;
  // Audit chain (#920): nested dispatches trace to their root so aggregate
  // cost ceilings and "what did this cascade cost" anchor at one id. Absent
  // (or = id) for top-level runs.
  root_run_id?: string;
  parent_run_id?: string;
  error?: string;
  task?: string;
  // Goal tracking
  goals_before?: Record<string, string>; // name → status before run
  goals_after?: Record<string, string>;  // name → status after run
  goals_changed?: GoalChange[];          // what moved
  // Quality scoring (from COO eval)
  grade?: string;                        // A/B/C/D/F
  grade_score?: number;                  // 0-100
  // Row provenance (#1119): squads-cli dispatches vs Claude-harness sessions
  // merged in from ~/.claude/projects transcripts at render time. Absent on
  // rows written by this module (always a squads-cli dispatch) — callers that
  // merge sources tag ledger rows 'ledger' explicitly.
  source?: 'ledger' | 'claude-code' | 'opencode';
  // True when cost_usd is a notional list-price estimate derived from raw
  // token counts (no billing signal), not what execution-log.ts recorded.
  cost_estimated?: boolean;
}

export interface QueryOptions {
  squad?: string;
  agent?: string;
  status?: string;
  since?: string;
  limit?: number;
}

export interface CostSummary {
  period: string;
  total_cost: number;
  total_runs: number;
  total_input_tokens: number;
  total_output_tokens: number;
  by_squad: Record<string, { cost: number; runs: number; avg_cost: number }>;
  by_model: Record<string, { cost: number; runs: number }>;
}

// ── Model Pricing (per 1M tokens) ────────────────────────────────────

export interface ModelPricing {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Opus tier (incl. the model ids that show up in real session files: 4-8, 4-7)
  'claude-opus-4-8': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4-7': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4-6': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-5-20250514': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0, cache_read: 0.08, cache_write: 1.0 },
  'default': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
};

/**
 * Resolve a pricing row for a model id. Prefix-matches the families above so an
 * unseen dated variant (e.g. `claude-opus-4-8-20260601`) still prices as opus
 * instead of silently falling back to the (cheaper) sonnet default.
 */
export function pricingForModel(model: string | undefined): ModelPricing {
  if (!model) return MODEL_PRICING['default'];
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  if (model.includes('opus')) return MODEL_PRICING['claude-opus-4-8'];
  if (model.includes('haiku')) return MODEL_PRICING['claude-haiku-4-5-20251001'];
  if (model.includes('sonnet')) return MODEL_PRICING['claude-sonnet-4-6'];
  return MODEL_PRICING['default'];
}

/** Token bundle → notional USD using per-1M-token pricing for `model`. */
export function deriveCostFromTokens(
  tokens: { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number },
  model: string | undefined,
): number {
  const p = pricingForModel(model);
  return (
    (tokens.input_tokens / 1_000_000) * p.input +
    (tokens.output_tokens / 1_000_000) * p.output +
    (tokens.cache_read_tokens / 1_000_000) * p.cache_read +
    (tokens.cache_write_tokens / 1_000_000) * p.cache_write
  );
}

// ── Paths ────────────────────────────────────────────────────────────

function getObservabilityDir(): string | null {
  const root = findProjectRoot();
  if (!root) return null;
  return join(root, '.agents', 'observability');
}

function getLogPath(): string | null {
  const dir = getObservabilityDir();
  if (!dir) return null;
  return join(dir, 'executions.jsonl');
}

// ── Claude Code Session Parsing ──────────────────────────────────────

interface SessionUsage {
  model: string;
  /** Basename of the session JSONL this usage was read from (#1129). */
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  messages: number;
  // What the session's tool_use blocks show the agent DID (#1060). Absent when
  // no tool calls were seen — consumers must treat that as unknown, not zero.
  outcomes?: RunOutcomes;
}

/**
 * Find the most recently modified Claude Code session JSONL file.
 * Claude Code writes sessions to ~/.claude/projects/<hash>/*.jsonl
 *
 * `beforeTimestamp` (optional) excludes files still being written after the
 * run ended — without it a concurrent long-lived session (e.g. interactive)
 * absorbs the attribution (#857). 2-minute grace for the final flush.
 */
function findRecentSessionFile(afterTimestamp: number, beforeTimestamp?: number): string | null {
  const home = process.env.HOME || '';
  const projectsDir = join(home, '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;

  const GRACE_MS = 2 * 60_000;
  let newest: { path: string; mtime: number } | null = null;

  try {
    for (const projDir of readdirSync(projectsDir)) {
      const projPath = join(projectsDir, projDir);
      try {
        if (!statSync(projPath).isDirectory()) continue;
      } catch { continue; }

      for (const file of readdirSync(projPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = join(projPath, file);
        try {
          const mtime = statSync(filePath).mtimeMs;
          // Only consider files modified within the run's window
          if (mtime <= afterTimestamp) continue;
          if (beforeTimestamp !== undefined && mtime > beforeTimestamp + GRACE_MS) continue;
          if (!newest || mtime > newest.mtime) {
            newest = { path: filePath, mtime };
          }
        } catch { continue; }
      }
    }
  } catch { /* projects dir read error */ }

  return newest?.path || null;
}

/**
 * Find a session JSONL by its exact session id (the file basename), across
 * all project dirs. Used for detached runs launched with `--session-id` —
 * deterministic attribution, immune to concurrent sessions (#857).
 */
function findSessionFileById(sessionId: string): string | null {
  const home = process.env.HOME || '';
  const projectsDir = join(home, '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;
  // Defense in depth: ids are CLI-generated UUIDs, never path fragments.
  const safe = sessionId.replace(/[^A-Za-z0-9-]/g, '');
  if (!safe) return null;

  try {
    for (const projDir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, projDir, `${safe}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* projects dir read error */ }
  return null;
}

/**
 * Parse a Claude Code session JSONL file and extract usage totals.
 */
function parseSessionUsage(sessionPath: string): SessionUsage | null {
  try {
    const content = readFileSync(sessionPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const basename = sessionPath.split('/').pop() || '';
    const usage: SessionUsage = {
      model: 'unknown',
      session_id: basename.endsWith('.jsonl') ? basename.slice(0, -'.jsonl'.length) : basename,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      messages: 0,
    };

    let outcomes = emptyOutcomes();

    for (const line of lines) {
      try {
        const record = JSON.parse(line);

        if (record.type === 'assistant') {
          const msg = record.message || {};
          const u = msg.usage || {};

          if (u.input_tokens || u.output_tokens) {
            usage.messages++;
            usage.input_tokens += u.input_tokens || 0;
            usage.output_tokens += u.output_tokens || 0;
            usage.cache_read_tokens += u.cache_read_input_tokens || 0;
            usage.cache_write_tokens += u.cache_creation_input_tokens || 0;
          }

          if (Array.isArray(msg.content)) {
            outcomes = addOutcomes(outcomes, parseOutcomes(msg.content as AssistantContentBlock[]));
          }

          if (!usage.model || usage.model === 'unknown') {
            usage.model = msg.model || 'unknown';
          }
        }

        // Capture cost if directly available
        if (record.costUSD) {
          usage.cost_usd += record.costUSD;
        }
      } catch { /* skip malformed lines */ }
    }

    if (usage.messages === 0) return null;

    // Same convention as the detached path (spool.ts): zero actions is
    // indistinguishable from a parse miss, so report outcomes only when the
    // agent verifiably did something — absent means unknown, never fake zero.
    if (outcomes.actions > 0) usage.outcomes = outcomes;

    // Calculate cost from tokens if not directly available
    if (usage.cost_usd === 0) {
      usage.cost_usd = deriveCostFromTokens(usage, usage.model);
    }

    return usage;
  } catch {
    return null;
  }
}

// ── Goal Tracking ────────────────────────────────────────────────────

/**
 * Parse goals from a squad's goals.md file.
 * Returns a map of goal name → status.
 */
export function snapshotGoals(squadName: string): Record<string, string> {
  const root = findProjectRoot();
  if (!root) return {};

  const goalsPath = join(root, '.agents', 'memory', squadName, 'goals.md');
  if (!existsSync(goalsPath)) return {};

  const content = readFileSync(goalsPath, 'utf-8');
  const goals: Record<string, string> = {};

  // Parse: **Goal name** — metric: X | ... | status: Y
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/\*\*([^*]+)\*\*.*status:\s*(\S+)/);
    if (match) {
      goals[match[1].trim()] = match[2].trim();
    }
  }

  return goals;
}

/**
 * Compare two goal snapshots and return what changed.
 */
export function diffGoals(
  before: Record<string, string>,
  after: Record<string, string>
): GoalChange[] {
  const changes: GoalChange[] = [];

  for (const [name, afterStatus] of Object.entries(after)) {
    const beforeStatus = before[name] || 'new';
    if (beforeStatus !== afterStatus) {
      changes.push({ name, before: beforeStatus, after: afterStatus });
    }
  }

  // Goals that disappeared (moved to achieved/abandoned)
  for (const [name, beforeStatus] of Object.entries(before)) {
    if (!(name in after)) {
      changes.push({ name, before: beforeStatus, after: 'removed' });
    }
  }

  return changes;
}

/**
 * Capture usage from the most recent Claude Code session.
 * Call this after a foreground run completes. Pass `runEndedAt` for runs that
 * finished in the past (spool reconcile) so sessions still active after the
 * run can't absorb the attribution (#857).
 */
export function captureSessionUsage(runStartedAt: number, runEndedAt?: number): SessionUsage | null {
  const sessionFile = findRecentSessionFile(runStartedAt, runEndedAt);
  if (!sessionFile) return null;
  return parseSessionUsage(sessionFile);
}

/**
 * Capture usage for an exact session id — the run's own session JSONL,
 * recorded by the detached wrapper at launch (#857). Deterministic; never
 * picks up a concurrent session.
 */
export function captureSessionUsageById(sessionId: string): SessionUsage | null {
  const sessionFile = findSessionFileById(sessionId);
  if (!sessionFile) return null;
  return parseSessionUsage(sessionFile);
}

// ── Write ────────────────────────────────────────────────────────────

/**
 * Push record to API (Tier 2 only). Fire-and-forget.
 */
async function pushToApi(record: ObservabilityRecord): Promise<void> {
  try {
    const { isTier2, getTierSync } = await import('./tier-detect.js');
    if (!isTier2()) return;

    const apiUrl = getTierSync().urls.api;
    if (!apiUrl) return;

    await fetch(`${apiUrl}/agent-executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        execution_id: record.id,
        squad: record.squad,
        agent: record.agent,
        model: record.model,
        status: record.status,
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        cache_read_tokens: record.cache_read_tokens,
        cache_write_tokens: record.cache_write_tokens,
        cost_usd: record.cost_usd,
        duration_seconds: Math.round(record.duration_ms / 1000),
        error_message: record.error || null,
        metadata: { trigger: record.trigger, provider: record.provider },
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silent — Tier 2 API down, JSONL is the fallback
  }
}

/**
 * Best-effort push to the Bridge (HTTP gateway fronting Postgres). No-op and
 * silent if the Bridge URL is unset or unreachable — local JSONL stays the
 * source of truth, so the CLI fully works with NO Bridge. Fire-and-forget.
 */
async function pushToBridge(record: ObservabilityRecord): Promise<void> {
  try {
    const { getBridgeUrl } = await import('./env-config.js');
    const bridgeUrl = getBridgeUrl();
    if (!bridgeUrl) return; // Tier 1 / local-only — skip silently

    await fetch(`${bridgeUrl}/api/executions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        execution_id: record.id,
        ts: record.ts,
        squad: record.squad,
        agent: record.agent,
        provider: record.provider,
        model: record.model,
        trigger: record.trigger,
        status: record.status,
        duration_ms: record.duration_ms,
        input_tokens: record.input_tokens,
        output_tokens: record.output_tokens,
        cache_read_tokens: record.cache_read_tokens,
        cache_write_tokens: record.cache_write_tokens,
        cost_usd: record.cost_usd,
        error: record.error || null,
      }),
      // Short timeout — never block the local write on a slow/dead Bridge.
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Bridge down or unset — silent. Local JSONL is the base.
  }
}

/**
 * Fire-and-forget ingest trigger ping.
 *
 * After the execution record is written to JSONL, POST to
 * `${SQUADS_API_URL}/ingest/trigger` so the local squads-api defers an
 * immediate `ingest_usage` run — providing near-real-time substrate data
 * instead of waiting for the 2-minute periodic sweep.
 *
 * Safety contract:
 *   - NEVER throws or rejects — failure must never affect the run path.
 *   - Skipped silently when SQUADS_API_URL or SCHEDULER_API_KEY is unset.
 *   - 2-second AbortController timeout so a dead API doesn't stall the process.
 *   - Errors caught and discarded (debug-level: no console output in production).
 *
 * Uses process.env.SQUADS_API_URL directly (same source getApiUrl() reads) to
 * avoid pulling the env-config module into the call path and to keep the
 * function easily testable without dynamic-import mocking.
 */
async function pingIngestTrigger(): Promise<void> {
  try {
    const apiUrl = process.env.SQUADS_API_URL;
    if (!apiUrl) return; // SQUADS_API_URL unset — skip silently

    const apiKey = process.env.SCHEDULER_API_KEY;
    if (!apiKey) return; // key unset — skip silently

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      await fetch(`${apiUrl}/ingest/trigger`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify({ source: 'squads-cli' }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Silent — API down, key missing, timeout, or any other error.
    // The periodic sweep (every 2 minutes) will cover the gap.
  }
}

export function logObservability(record: ObservabilityRecord): void {
  // Audit chain (#920): when this CLI process was itself spawned by an agent
  // run, buildAgentEnv gave it the chain — stamp every record it writes.
  // Explicit fields on the record win (callers that know better).
  if (!record.root_run_id && process.env.SQUADS_ROOT_RUN_ID) {
    record.root_run_id = process.env.SQUADS_ROOT_RUN_ID;
  }
  if (!record.parent_run_id && process.env.SQUADS_PARENT_RUN_ID) {
    record.parent_run_id = process.env.SQUADS_PARENT_RUN_ID;
  }

  const logPath = getLogPath();
  if (!logPath) return;

  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Local JSONL is the source of truth — write it first, always.
  appendFileSync(logPath, JSON.stringify(record) + '\n');

  // Dual-write: also push to API when Tier 2 is active (fire-and-forget)
  pushToApi(record).catch(() => {});
  // Best-effort Bridge push (no-op/silent if Bridge unset or down).
  pushToBridge(record).catch(() => {});
  // Real-time ingest trigger: notify local squads-api immediately (fire-and-forget).
  pingIngestTrigger().catch(() => {});
}

// ── Run ledger (start events + fold + orphan reaper) ─────────────────
//
// The jsonl is an event log: a run appends a 'running' row at spawn and a
// terminal row at exit, and its current state is the LAST row for its id.
// This is what makes "what's running right now" answerable from the ledger
// instead of from unreconciled per-agent markdown (the 191-zombie bug that
// made `squads status` report 17 phantom running runs — cli#1142).

/** Append a start event. Same sinks as any other record. */
export function logRunStarted(rec: {
  id: string;
  squad: string;
  agent: string;
  provider: string;
  model: string;
  trigger: ObservabilityRecord['trigger'];
  pid?: number;
  task?: string;
}): void {
  logObservability({
    ts: new Date().toISOString(),
    id: rec.id,
    squad: rec.squad,
    agent: rec.agent,
    provider: rec.provider,
    model: rec.model,
    trigger: rec.trigger,
    status: 'running',
    pid: rec.pid,
    task: rec.task,
    duration_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0,
    context_tokens: 0,
  });
}

/** Fold the event log: one record per id. Later rows win, with one state-
 * machine rule on top: a terminal row is never overwritten by a 'running'
 * row for the same id. Timestamps have millisecond resolution, so a start
 * event and its terminal can tie — and a run never goes back to running. */
export function foldExecutions(records: ObservabilityRecord[]): ObservabilityRecord[] {
  const byId = new Map<string, ObservabilityRecord>();
  // records arrive newest-first from queryExecutions — walk oldest-first so
  // later rows naturally replace earlier ones.
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i];
    const prev = byId.get(rec.id);
    if (prev && prev.status !== 'running' && rec.status === 'running') continue;
    byId.set(rec.id, rec);
  }
  return [...byId.values()];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A pid-less running row can't be liveness-checked; give it the same grace
// the API-side sweeper gives (longest legitimate run observed ~85min).
const ORPHAN_PIDLESS_AFTER_MS = 3 * 60 * 60 * 1000;

/**
 * Reap running rows whose process is gone: append an 'orphaned' terminal
 * event locally and report it to the API (fire-and-forget). Returns the
 * folded, post-reap view so callers render truth in the same pass.
 */
export function reconcileOrphanedRuns(): ObservabilityRecord[] {
  const folded = foldExecutions(queryExecutions());
  const now = Date.now();

  for (const rec of folded) {
    if (rec.status !== 'running') continue;
    const dead = rec.pid
      ? !pidAlive(rec.pid)
      : now - new Date(rec.ts).getTime() > ORPHAN_PIDLESS_AFTER_MS;
    if (!dead) continue;

    const orphanRow: ObservabilityRecord = {
      ...rec,
      ts: new Date().toISOString(),
      status: 'orphaned',
      duration_ms: Math.max(0, now - new Date(rec.ts).getTime()),
      error: rec.pid
        ? `orphaned: pid ${rec.pid} gone without a terminal report`
        : 'orphaned: no pid and no terminal report within 3h',
    };
    logObservability(orphanRow);
    rec.status = orphanRow.status;
    rec.error = orphanRow.error;
    // Mirror to the API so Postgres converges without waiting for its own
    // 3h sweep. Lazy import avoids a cycle (api-client → auth → …).
    void import('./api-client.js')
      .then(m => m.reportExecutionComplete(rec.id, 'orphaned', { error: orphanRow.error, squad: rec.squad, agent: rec.agent }))
      .catch(() => {});
  }

  return folded;
}

// ── Read ─────────────────────────────────────────────────────────────

export function queryExecutions(opts: QueryOptions = {}): ObservabilityRecord[] {
  const logPath = getLogPath();
  if (!logPath || !existsSync(logPath)) return [];

  const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
  let records: ObservabilityRecord[] = [];

  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch { /* skip */ }
  }

  if (opts.squad) records = records.filter(r => r.squad === opts.squad);
  if (opts.agent) records = records.filter(r => r.agent === opts.agent);
  if (opts.status) records = records.filter(r => r.status === opts.status);
  if (opts.since) {
    const since = new Date(opts.since).getTime();
    records = records.filter(r => new Date(r.ts).getTime() >= since);
  }

  records.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  if (opts.limit) records = records.slice(0, opts.limit);

  return records;
}

// ── Local usage view (source: executions.jsonl, no Bridge needed) ─────

export interface UsageBucket {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  runs: number;
}

export interface LocalUsageSummary {
  /** Since local midnight (calendar day). */
  today: UsageBucket;
  /** Rolling window (last `windowHours` hours). */
  window: UsageBucket;
  windowHours: number;
  /** Per-squad totals over the wider of today / window. */
  bySquad: Array<{ squad: string } & UsageBucket>;
}

function emptyBucket(): UsageBucket {
  return { cost_usd: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, runs: 0 };
}

function addToBucket(b: UsageBucket, r: ObservabilityRecord): void {
  b.cost_usd += r.cost_usd || 0;
  b.input_tokens += r.input_tokens || 0;
  b.output_tokens += r.output_tokens || 0;
  b.cache_read_tokens += r.cache_read_tokens || 0;
  b.cache_write_tokens += r.cache_write_tokens || 0;
  b.runs += 1;
}

/**
 * Local-first usage rollup straight from executions.jsonl — no Bridge/Postgres.
 * Returns today's total, a rolling-window total, and a per-squad breakdown.
 */
export function localUsageSummary(windowHours = 5): LocalUsageSummary {
  const all = queryExecutions({});
  const now = Date.now();
  const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const windowMs = now - windowHours * 60 * 60 * 1000;

  const today = emptyBucket();
  const windowBucket = emptyBucket();
  const bySquad = new Map<string, { squad: string } & UsageBucket>();

  for (const r of all) {
    const t = new Date(r.ts).getTime();
    if (Number.isNaN(t)) continue;
    const inToday = t >= todayMs;
    const inWindow = t >= windowMs;
    if (inToday) addToBucket(today, r);
    if (inWindow) addToBucket(windowBucket, r);
    // Per-squad over the wider span (today OR window) so the breakdown is useful.
    if (inToday || inWindow) {
      let bucket = bySquad.get(r.squad);
      if (!bucket) { bucket = { squad: r.squad, ...emptyBucket() }; bySquad.set(r.squad, bucket); }
      addToBucket(bucket, r);
    }
  }

  return {
    today,
    window: windowBucket,
    windowHours,
    bySquad: [...bySquad.values()].sort((a, b) => b.cost_usd - a.cost_usd),
  };
}

/**
 * Average cost per agent run from recent local history, for pre-run estimates.
 * Returns `fallback` when there is no usable cost history (e.g. first run, or
 * all records are zero-cost). Only counts records with cost_usd > 0.
 */
export function avgCostPerRun(windowHours = 24, fallback = 0.75): number {
  const all = queryExecutions({});
  const windowMs = Date.now() - windowHours * 60 * 60 * 1000;
  let cost = 0, runs = 0;
  for (const r of all) {
    const t = new Date(r.ts).getTime();
    if (Number.isNaN(t) || t < windowMs) continue;
    if ((r.cost_usd || 0) > 0) { cost += r.cost_usd; runs += 1; }
  }
  return runs > 0 ? cost / runs : fallback;
}

/** Today's total spend (local midnight → now) from executions.jsonl. */
export function todayCostUsd(): number {
  return localUsageSummary().today.cost_usd;
}

export function calculateCostSummary(period: 'today' | '7d' | '30d' | 'all' = '7d'): CostSummary {
  const now = Date.now();
  const cutoffs: Record<string, number> = {
    'today': now - 24 * 60 * 60 * 1000,
    '7d': now - 7 * 24 * 60 * 60 * 1000,
    '30d': now - 30 * 24 * 60 * 60 * 1000,
    'all': 0,
  };

  const since = new Date(cutoffs[period] || cutoffs['7d']).toISOString();
  const records = queryExecutions({ since });

  const bySquad: Record<string, { cost: number; runs: number; avg_cost: number }> = {};
  const byModel: Record<string, { cost: number; runs: number }> = {};
  let totalCost = 0, totalInput = 0, totalOutput = 0;

  for (const r of records) {
    totalCost += r.cost_usd;
    totalInput += r.input_tokens;
    totalOutput += r.output_tokens;

    if (!bySquad[r.squad]) bySquad[r.squad] = { cost: 0, runs: 0, avg_cost: 0 };
    bySquad[r.squad].cost += r.cost_usd;
    bySquad[r.squad].runs += 1;

    if (!byModel[r.model]) byModel[r.model] = { cost: 0, runs: 0 };
    byModel[r.model].cost += r.cost_usd;
    byModel[r.model].runs += 1;
  }

  for (const squad of Object.values(bySquad)) {
    squad.avg_cost = squad.runs > 0 ? squad.cost / squad.runs : 0;
  }

  return { period, total_cost: totalCost, total_runs: records.length, total_input_tokens: totalInput, total_output_tokens: totalOutput, by_squad: bySquad, by_model: byModel };
}
