/**
 * scoreboard.ts — quality-per-cost per (task class × provider × model).
 *
 * Layer 2 of outcome-driven routing (hq spec 2026-07-04 §3.2): the referee
 * that lets an AI manager dispatch ANY executor on measured results instead
 * of vendor benchmarks or vibes. v1 is strictly READ-ONLY — it informs
 * routing, it does not perform it (hooks are v2, gated on weeks of data).
 *
 * Provenance discipline (non-negotiable):
 * - Every row renders with its n. At current volume the board is DIRECTIONAL,
 *   not statistical — the display must say so, always.
 * - Cost figures are NOTIONAL (list-price token proxy on subscription quota).
 * - Without --resolve, "activity" (commits/PRs created) is an OUTPUT proxy,
 *   not value. --resolve checks artifacts live against GitHub (landed-rate).
 * - Founder feedback is squad-level; it renders as its own section and is
 *   NEVER blended into per-model quality (misattribution guard).
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { ObservabilityRecord } from './observability.js';
import { detectTaskType } from './run-utils.js';
import { colors, RESET, bold } from './terminal.js';

// ── Aggregation ───────────────────────────────────────────────────────

export interface ScoreboardRow {
  provider: string;
  model: string;
  taskClass: string;
  n: number;
  completed: number;
  failed: number;
  timeout: number;
  totalCostUsd: number;
  avgCostUsd: number;
  outputTokens: number;
  commits: number;
  prs: number;
  issues: number;
  /** (commits + PRs) per notional dollar — output proxy, NOT value. */
  activityPerUsd: number | null;
  /** Set only under --resolve: live-checked artifact outcomes. */
  landed?: { checked: number; merged: number; rate: number };
}

export interface SquadFeedbackAvg {
  squad: string;
  n: number;
  avgRating: number;
  lastDate: string;
}

export interface Scoreboard {
  windowDays: number;
  totalRuns: number;
  rows: ScoreboardRow[];
  feedback: SquadFeedbackAvg[];
  resolved: boolean;
}

export function readExecutionRecords(projectRoot: string, windowDays: number): ObservabilityRecord[] {
  const path = join(projectRoot, '.agents', 'observability', 'executions.jsonl');
  if (!existsSync(path)) return [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const records: ObservabilityRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ObservabilityRecord;
      if (Date.parse(r.ts) >= cutoff) records.push(r);
    } catch { /* skip malformed lines */ }
  }
  return records;
}

/** Normalize a raw model id to a family label so dated variants group together. */
export function modelFamily(model: string): string {
  const m = (model || 'unknown').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('gpt')) return m.replace(/[^a-z0-9.-]/g, '').slice(0, 16);
  if (m.includes('qwen')) return 'qwen';
  if (m.includes('glm')) return 'glm';
  if (m.includes('kimi')) return 'kimi';
  if (m.includes('gemini')) return 'gemini';
  return m === 'unknown' ? 'unknown' : m.slice(0, 16);
}

export function buildScoreboard(
  records: ObservabilityRecord[],
  opts: { windowDays: number; resolved?: boolean },
): Scoreboard {
  const groups = new Map<string, ScoreboardRow>();

  for (const r of records) {
    const taskClass = detectTaskType(r.agent) || 'execution';
    const family = modelFamily(r.model || 'unknown');
    const key = `${r.provider}|${family}|${taskClass}`;
    let row = groups.get(key);
    if (!row) {
      row = {
        provider: r.provider || 'unknown', model: family, taskClass,
        n: 0, completed: 0, failed: 0, timeout: 0,
        totalCostUsd: 0, avgCostUsd: 0, outputTokens: 0,
        commits: 0, prs: 0, issues: 0, activityPerUsd: null,
      };
      groups.set(key, row);
    }
    row.n += 1;
    if (r.status === 'completed') row.completed += 1;
    else if (r.status === 'timeout') row.timeout += 1;
    else row.failed += 1;
    row.totalCostUsd += r.cost_usd || 0;
    row.outputTokens += r.output_tokens || 0;
    row.commits += r.commits || 0;
    row.prs += r.prs_created || 0;
    row.issues += r.issues_created || 0;
  }

  const rows = [...groups.values()].map((row) => ({
    ...row,
    avgCostUsd: row.n > 0 ? row.totalCostUsd / row.n : 0,
    activityPerUsd: row.totalCostUsd > 0.001 ? (row.commits + row.prs) / row.totalCostUsd : null,
  }));
  // Most-used first — the board is about where the work actually goes.
  rows.sort((a, b) => b.n - a.n || b.totalCostUsd - a.totalCostUsd);

  return {
    windowDays: opts.windowDays,
    totalRuns: records.length,
    rows,
    feedback: [],
    resolved: opts.resolved ?? false,
  };
}

// ── Founder feedback (squad-level, separate section) ──────────────────

const RATING_RE = /\*\*Rating\*\*:\s*(\d)\/5/g;
const DATE_RE = /_Date:\s*(\d{4}-\d{2}-\d{2})_/g;

export function readSquadFeedback(memoryDir: string): SquadFeedbackAvg[] {
  const out: SquadFeedbackAvg[] = [];
  if (!existsSync(memoryDir)) return out;
  let squads: string[];
  try {
    squads = readdirSync(memoryDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  for (const squad of squads) {
    const path = join(memoryDir, squad, 'feedback.md');
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8');
      const ratings = [...text.matchAll(RATING_RE)].map((m) => parseInt(m[1], 10)).filter((v) => v >= 1 && v <= 5);
      if (ratings.length === 0) continue;
      const dates = [...text.matchAll(DATE_RE)].map((m) => m[1]).sort();
      out.push({
        squad,
        n: ratings.length,
        avgRating: ratings.reduce((a, b) => a + b, 0) / ratings.length,
        lastDate: dates[dates.length - 1] || '',
      });
    } catch { /* unreadable file — skip squad */ }
  }
  return out.sort((a, b) => b.n - a.n);
}

// ── Rendering ─────────────────────────────────────────────────────────

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

export function renderScoreboard(board: Scoreboard): string[] {
  const out: string[] = [];
  const dim = (s: string) => `${colors.dim}${s}${RESET}`;

  out.push('');
  out.push(`  ${bold}Executor scoreboard${RESET} ${dim(`— last ${board.windowDays}d · ${board.totalRuns} runs · quality-per-cost, provenance-labeled`)}`);
  out.push(`  ${dim('Cost is NOTIONAL (list-price proxy). Small n = directional, not statistical.')}`);
  if (!board.resolved) {
    out.push(`  ${dim('Activity (commits+PRs created) is an output PROXY — run with --resolve to check landed-rate against GitHub.')}`);
  }
  out.push('');

  if (board.rows.length === 0) {
    out.push(dim('    no execution records in the window — dispatch some runs first'));
    out.push('');
    return out;
  }

  for (const row of board.rows) {
    const nBadge = row.n < 5 ? `${colors.yellow}n=${row.n}${RESET}` : `${colors.green}n=${row.n}${RESET}`;
    const head = `    ${colors.cyan}${row.provider}/${row.model}${RESET} ${dim('·')} ${row.taskClass}  ${nBadge}`;
    out.push(head);
    const done = pct(row.completed, row.n);
    const activity = row.commits + row.prs > 0
      ? `${row.commits}c/${row.prs}pr${row.activityPerUsd !== null ? ` · ${row.activityPerUsd.toFixed(1)} per $` : ''}`
      : 'no artifacts';
    const landed = row.landed
      ? ` · ${colors.green}landed ${Math.round(row.landed.rate * 100)}%${RESET} ${dim(`(${row.landed.merged}/${row.landed.checked} checked)`)}`
      : '';
    out.push(`      ${dim(`ok ${done} · fail ${pct(row.failed, row.n)} · timeout ${pct(row.timeout, row.n)} · $${row.totalCostUsd.toFixed(2)} total ($${row.avgCostUsd.toFixed(2)}/run) · ${activity}`)}${landed}`);
  }
  out.push('');

  if (board.feedback.length > 0) {
    out.push(`  ${bold}Founder feedback${RESET} ${dim('(squad-level — separate on purpose; never blended into per-model rows)')}`);
    for (const f of board.feedback) {
      out.push(`    ${f.squad.padEnd(16)} ${colors.yellow}${f.avgRating.toFixed(1)}/5${RESET} ${colors.dim}(n=${f.n}, last ${f.lastDate})${RESET}`);
    }
    out.push('');
  }

  return out;
}
