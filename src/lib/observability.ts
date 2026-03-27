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
  trigger: 'manual' | 'scheduled' | 'event' | 'smart';
  status: 'completed' | 'failed' | 'timeout';
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  context_tokens: number;
  error?: string;
  task?: string;
  // Goal tracking
  goals_before?: Record<string, string>; // name → status before run
  goals_after?: Record<string, string>;  // name → status after run
  goals_changed?: GoalChange[];          // what moved
  // Quality scoring (from COO eval)
  grade?: string;                        // A/B/C/D/F
  grade_score?: number;                  // 0-100
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

const MODEL_PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  'claude-opus-4-6': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-5-20250514': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0, cache_read: 0.08, cache_write: 1.0 },
  'default': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
};

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
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  messages: number;
}

/**
 * Find the most recently modified Claude Code session JSONL file.
 * Claude Code writes sessions to ~/.claude/projects/<hash>/*.jsonl
 */
function findRecentSessionFile(afterTimestamp: number): string | null {
  const home = process.env.HOME || '';
  const projectsDir = join(home, '.claude', 'projects');
  if (!existsSync(projectsDir)) return null;

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
          // Only consider files modified after the run started
          if (mtime > afterTimestamp && (!newest || mtime > newest.mtime)) {
            newest = { path: filePath, mtime };
          }
        } catch { continue; }
      }
    }
  } catch { /* projects dir read error */ }

  return newest?.path || null;
}

/**
 * Parse a Claude Code session JSONL file and extract usage totals.
 */
function parseSessionUsage(sessionPath: string): SessionUsage | null {
  try {
    const content = readFileSync(sessionPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);

    const usage: SessionUsage = {
      model: 'unknown',
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      messages: 0,
    };

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

    // Calculate cost from tokens if not directly available
    if (usage.cost_usd === 0) {
      const pricing = MODEL_PRICING[usage.model] || MODEL_PRICING['default'];
      usage.cost_usd = (
        (usage.input_tokens / 1_000_000) * pricing.input +
        (usage.output_tokens / 1_000_000) * pricing.output +
        (usage.cache_read_tokens / 1_000_000) * pricing.cache_read +
        (usage.cache_write_tokens / 1_000_000) * pricing.cache_write
      );
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
 * Call this after a foreground run completes.
 */
export function captureSessionUsage(runStartedAt: number): SessionUsage | null {
  const sessionFile = findRecentSessionFile(runStartedAt);
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

export function logObservability(record: ObservabilityRecord): void {
  const logPath = getLogPath();
  if (!logPath) return;

  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  appendFileSync(logPath, JSON.stringify(record) + '\n');

  // Dual-write: also push to API when Tier 2 is active (fire-and-forget)
  pushToApi(record).catch(() => {});
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
