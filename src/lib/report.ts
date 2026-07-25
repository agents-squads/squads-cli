/**
 * report.ts — the auditor evidence pack (#1207).
 *
 * The audit-trail moat's user-visible artifact. Three local, read-only data
 * sources — `.agents/observability/executions.jsonl` (runs), the inbox
 * decision ledger `reviewed.jsonl` (human-gate decisions), and `git log`
 * (merged commits) — presented as one CFO/auditor-readable document.
 *
 * Trust law: every number traces to a record. A missing source renders
 * "No data recorded for this period" — visibly absent beats plausible-looking.
 * Never fabricate, never interpolate. No network calls.
 *
 * Pure + injectable so the command file stays thin and tests drive fixtures:
 * `gatherReportData()` takes a `projectRoot` (and an injectable git runner),
 * and the renderers take a `ReportData` and return a string.
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { foldExecutions, type ObservabilityRecord } from './observability.js';
import { readDecisions } from './inbox-decisions.js';

// ── Types ────────────────────────────────────────────────────────────

export type ReportFormat = 'md' | 'html';

export interface ReportPeriod {
  start: Date;
  end: Date;
  /** Original token the user passed (`30d`, `7d`, `2026-01-01..2026-01-31`). */
  label: string;
}

export interface ReportRun {
  ts: string;
  id: string;
  squad: string;
  agent: string;
  provider: string;
  model?: string;
  status: string;
  duration_ms: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  brief?: string;
}

export interface ReportDecision {
  ts: string;
  id: string;
  kind: string;
  ref: string;
  decision: string;
  by?: string;
  reason?: string;
  result: string;
}

export interface ReportCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface ReportSources {
  /** `.agents/observability/executions.jsonl` present and parseable. */
  executions: boolean;
  /** `.agents/observability/reviewed.jsonl` present and parseable. */
  decisions: boolean;
  /** `git log` ran in the project repo. */
  git: boolean;
}

export interface ReportData {
  project: string;
  cliVersion: string;
  generatedAt: string;
  period: ReportPeriod;
  runs: ReportRun[];
  decisions: ReportDecision[];
  commits: ReportCommit[];
  sources: ReportSources;
}

/**
 * Injectable git runner so tests never shell out. Returns stdout; the default
 * implementation invokes `git` in `cwd` and returns '' on any failure (no
 * git, not a repo, bad rev — the report degrades to "no git data").
 */
export type GitRunner = (args: string[], cwd: string) => string;

export const defaultGitRunner: GitRunner = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
};

// ── Period parsing ───────────────────────────────────────────────────

/** True when `d` is a real, finite date. */
function isValidDate(d: Date): boolean {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/**
 * Parse `--period` into an inclusive [start, end] window.
 *   - `Nd`        → last N days (end = now)
 *   - `YYYY-MM-DD..YYYY-MM-DD` → explicit range, end inclusive (end of day)
 * Throws on anything else — bad input must surface, not silently widen.
 */
export function parsePeriod(input: string, now: Date): ReportPeriod {
  const trimmed = (input ?? '').trim();

  const rangeMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/);
  if (rangeMatch) {
    const start = startOfDay(new Date(rangeMatch[1] + 'T00:00:00Z'));
    const end = endOfDay(new Date(rangeMatch[2] + 'T00:00:00Z'));
    if (!isValidDate(start) || !isValidDate(end)) {
      throw new Error(`Invalid date in period range: ${trimmed}`);
    }
    if (end.getTime() < start.getTime()) {
      throw new Error(`Period range ends before it starts: ${trimmed}`);
    }
    return { start, end, label: trimmed };
  }

  const relMatch = trimmed.match(/^(\d+)d$/);
  if (trimmed && !relMatch) {
    throw new Error(
      `Invalid period '${trimmed}'. Use Nd (e.g. 30d) or YYYY-MM-DD..YYYY-MM-DD.`,
    );
  }
  const n = relMatch ? parseInt(relMatch[1], 10) : 30;
  const end = new Date(now.getTime());
  const start = new Date(now.getTime() - n * 86_400_000);
  return { start, end, label: `${n}d` };
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setUTCHours(23, 59, 59, 999);
  return x;
}

// ── Data gathering (all local, read-only) ────────────────────────────

function executionsPath(projectRoot: string): string {
  return join(projectRoot, '.agents', 'observability', 'executions.jsonl');
}

/** Read + fold executions.jsonl pinned to `projectRoot` (one record per run id). */
function readExecutions(projectRoot: string): ObservabilityRecord[] {
  const path = executionsPath(projectRoot);
  if (!existsSync(path)) return [];
  const records: ObservabilityRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ObservabilityRecord;
      if (rec && rec.id && rec.ts) records.push(rec);
    } catch {
      // a corrupt line never takes the report down
    }
  }
  // The jsonl is an event log (running + terminal rows); fold to one-per-run.
  return foldExecutions(records);
}

/** 0x1f unit separator: git emits it via `%x1f`; it can't appear in normal
 *  author names or subjects, so it's a safe field delimiter. */
const GIT_SEP = String.fromCharCode(0x1f);
const GIT_FORMAT = ['%H', '%aN', '%ad', '%s'].join(GIT_SEP);

/** Parse `git log --shortstat` output into one ReportCommit per commit. */
export function parseGitLog(stdout: string): ReportCommit[] {
  const commits: ReportCommit[] = [];
  let current: ReportCommit | null = null;
  for (const line of stdout.split('\n')) {
    // Commit header lines carry our 0x1f field separator.
    if (line.includes(GIT_SEP)) {
      const [hash, author, date, subject] = line.split(GIT_SEP);
      current = {
        hash: hash || '',
        author: author || '',
        date: date || '',
        subject: subject || '',
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      };
      commits.push(current);
      continue;
    }
    if (!current) continue;
    const stat = line.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (stat) {
      current.filesChanged = parseInt(stat[1], 10) || 0;
      current.insertions = stat[2] ? parseInt(stat[2], 10) : 0;
      current.deletions = stat[3] ? parseInt(stat[3], 10) : 0;
    }
  }
  return commits;
}

/** Commits landed in the period (non-merge — squads lands via squash commits). */
function readCommits(projectRoot: string, period: ReportPeriod, gitRunner: GitRunner): ReportCommit[] {
  const out = gitRunner(
    [
      'log',
      `--since=${period.start.toISOString()}`,
      `--until=${period.end.toISOString()}`,
      '--no-merges',
      '--date=short',
      `--format=${GIT_FORMAT}`,
      '--shortstat',
    ],
    projectRoot,
  );
  return parseGitLog(out);
}

/** Project name: `org/repo` from the origin remote, else the dir basename. */
export function resolveProjectName(projectRoot: string, gitRunner: GitRunner = defaultGitRunner): string {
  const url = gitRunner(['remote', 'get-url', 'origin'], projectRoot).trim();
  const match = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (match) return match[1];
  return basename(projectRoot);
}

function inPeriod(ts: string, period: ReportPeriod): boolean {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return false;
  return t >= period.start.getTime() && t <= period.end.getTime();
}

export interface GatherOptions {
  projectRoot: string;
  project?: string;
  cliVersion: string;
  generatedAt: string;
  period: ReportPeriod;
  gitRunner?: GitRunner;
}

/**
 * Gather all three sources for the period. Never throws on missing data — a
 * source's absence is recorded in `sources` and renders as "no data". The
 * period filter is applied to each record's timestamp.
 */
export function gatherReportData(opts: GatherOptions): ReportData {
  const gitRunner = opts.gitRunner ?? defaultGitRunner;

  const execFileExists = existsSync(executionsPath(opts.projectRoot));
  const rawRuns = readExecutions(opts.projectRoot)
    .filter(r => inPeriod(r.ts, opts.period))
    .map<ReportRun>(r => ({
      ts: r.ts,
      id: r.id,
      squad: r.squad,
      agent: r.agent,
      provider: r.provider,
      model: r.model,
      status: r.status,
      duration_ms: r.duration_ms,
      cost_usd: r.cost_usd || 0,
      input_tokens: r.input_tokens || 0,
      output_tokens: r.output_tokens || 0,
      brief: r.brief,
    }))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  const ledgerFileExists = existsSync(join(opts.projectRoot, '.agents', 'observability', 'reviewed.jsonl'));
  const decisions = readDecisions(opts.projectRoot)
    .filter(d => inPeriod(d.ts, opts.period))
    .map<ReportDecision>(d => ({
      ts: d.ts,
      id: d.id,
      kind: d.kind,
      ref: d.ref,
      decision: d.decision,
      by: d.by,
      reason: d.reason,
      result: d.result,
    }))
    .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

  let commits: ReportCommit[] = [];
  let gitOk = false;
  try {
    commits = readCommits(opts.projectRoot, opts.period, gitRunner);
    // An empty window over a real repo is "no data in period", not "git
    // unavailable" — distinguish so the footer is honest.
    gitOk = gitRunner(['rev-parse', '--is-inside-work-tree'], opts.projectRoot).trim() === 'true';
  } catch {
    gitOk = false;
  }

  return {
    project: opts.project ?? resolveProjectName(opts.projectRoot, gitRunner),
    cliVersion: opts.cliVersion,
    generatedAt: opts.generatedAt,
    period: opts.period,
    runs: rawRuns,
    decisions,
    commits,
    sources: {
      executions: execFileExists,
      decisions: ledgerFileExists,
      git: gitOk,
    },
  };
}

// ── Aggregations ─────────────────────────────────────────────────────

export type DecisionType = 'human' | 'agent';

/** `agent:`-stamped actors are autonomous; anything else is a human actor. */
export function decisionActor(by: string | undefined): DecisionType {
  return by && by.startsWith('agent:') ? 'agent' : 'human';
}

export interface ModelCost {
  model: string;
  runs: number;
  cost: number;
}

export interface SquadCost {
  squad: string;
  runs: number;
  cost: number;
}

export interface ReportSummary {
  runs: number;
  approvals: number;
  rejections: number;
  deferrals: number;
  commits: number;
  totalTokens: number;
  totalCost: number;
  byModel: ModelCost[];
  bySquad: SquadCost[];
}

export function summarize(data: ReportData): ReportSummary {
  const approvals = data.decisions.filter(d => d.decision === 'approve').length;
  const rejections = data.decisions.filter(d => d.decision === 'reject').length;
  const deferrals = data.decisions.filter(d => d.decision === 'defer').length;

  let totalCost = 0;
  let totalTokens = 0;
  const modelMap = new Map<string, ModelCost>();
  const squadMap = new Map<string, SquadCost>();

  for (const r of data.runs) {
    totalCost += r.cost_usd;
    totalTokens += r.input_tokens + r.output_tokens;

    const modelKey = r.model || 'unknown';
    const m = modelMap.get(modelKey) ?? { model: modelKey, runs: 0, cost: 0 };
    m.runs += 1; m.cost += r.cost_usd;
    modelMap.set(modelKey, m);

    const s = squadMap.get(r.squad) ?? { squad: r.squad, runs: 0, cost: 0 };
    s.runs += 1; s.cost += r.cost_usd;
    squadMap.set(r.squad, s);
  }

  return {
    runs: data.runs.length,
    approvals,
    rejections,
    deferrals,
    commits: data.commits.length,
    totalTokens,
    totalCost,
    byModel: [...modelMap.values()].sort((a, b) => b.cost - a.cost),
    bySquad: [...squadMap.values()].sort((a, b) => b.cost - a.cost),
  };
}

// ── Formatting helpers ───────────────────────────────────────────────

export function formatUsd(n: number): string {
  return `$${(n || 0).toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n || 0);
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h${rm}m` : `${h}h`;
}

function shortDate(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts || '—';
  return d.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const it of items) {
    const k = key(it);
    (out[k] ||= []).push(it);
  }
  return out;
}

// ── Markdown rendering ───────────────────────────────────────────────

/** Escape a string for a markdown table cell (pipes, newlines). */
function mdCell(s: unknown): string {
  const str = s === undefined || s === null ? '' : String(s);
  return str.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const NO_DATA = 'No data recorded for this period.';

export function renderAuditorMarkdown(data: ReportData): string {
  const summary = summarize(data);
  const p = data.period;
  const lines: string[] = [];

  lines.push('# Auditor Evidence Pack');
  lines.push('');
  lines.push(`- **Project:** ${data.project}`);
  lines.push(`- **Period:** ${p.label} (${fmtDate(p.start)} → ${fmtDate(p.end)})`);
  lines.push(`- **Generated:** ${data.generatedAt}`);
  lines.push(`- **CLI version:** squads-cli v${data.cliVersion}`);
  lines.push('');

  // ── Summary ──
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---|');
  lines.push(`| Runs | ${summary.runs} |`);
  lines.push(`| Approvals | ${summary.approvals} |`);
  lines.push(`| Rejections | ${summary.rejections} |`);
  lines.push(`| Deferrals | ${summary.deferrals} |`);
  lines.push(`| Commits | ${summary.commits} |`);
  lines.push(`| Total tokens (in+out) | ${formatTokens(summary.totalTokens)} |`);
  lines.push(`| Total cost (USD) | ${formatUsd(summary.totalCost)} |`);
  lines.push('');
  if (summary.byModel.length > 0) {
    lines.push('### Cost by model');
    lines.push('');
    lines.push('| Model | Runs | Cost (USD) |');
    lines.push('|---|---:|---:|');
    for (const m of summary.byModel) {
      lines.push(`| ${mdCell(m.model)} | ${m.runs} | ${formatUsd(m.cost)} |`);
    }
    lines.push('');
  }

  // ── Actions ──
  lines.push('## Actions');
  lines.push('');
  lines.push('_Source: `.agents/observability/executions.jsonl` — one row per run (folded)._');
  lines.push('');
  if (data.runs.length === 0) {
    lines.push(`_${NO_DATA}_`);
    lines.push('');
  } else {
    const bySquad = groupBy(data.runs, r => r.squad);
    for (const squad of Object.keys(bySquad).sort()) {
      lines.push(`### ${squad}`);
      lines.push('');
      lines.push('| Time | Agent | Status | Model | Duration | Cost | Brief |');
      lines.push('|---|---|---|---|---|---:|---|');
      for (const r of bySquad[squad]) {
        lines.push(
          `| ${mdCell(shortDate(r.ts))} | ${mdCell(r.agent)} | ${mdCell(r.status)} | ${mdCell(r.model || 'unknown')} | ${formatDuration(r.duration_ms)} | ${formatUsd(r.cost_usd)} | ${mdCell(r.brief || '')} |`,
        );
      }
      lines.push('');
    }
  }

  // ── Decisions ──
  lines.push('## Decisions');
  lines.push('');
  lines.push('_Source: `.agents/observability/reviewed.jsonl` — human-gate decisions (who decided what, when)._');
  lines.push('');
  if (data.decisions.length === 0) {
    lines.push(`_${NO_DATA}_`);
    lines.push('');
  } else {
    lines.push('| Time | Decision | Actor | Kind | Ref | Reason / result |');
    lines.push('|---|---|---|---|---|---|');
    for (const d of data.decisions) {
      const actor = `${d.by || 'unknown'} (${decisionActor(d.by)})`;
      const detail = d.reason || d.result || '';
      lines.push(
        `| ${mdCell(shortDate(d.ts))} | ${mdCell(d.decision)} | ${mdCell(actor)} | ${mdCell(d.kind)} | ${mdCell(d.ref)} | ${mdCell(detail)} |`,
      );
    }
    lines.push('');
  }

  // ── Diffs ──
  lines.push('## Diffs');
  lines.push('');
  lines.push('_Source: `git log` (project repo) — non-merge commits in the period._');
  lines.push('');
  if (data.commits.length === 0) {
    lines.push(`_${NO_DATA}_`);
    lines.push('');
  } else {
    for (const c of data.commits) {
      lines.push(`- \`${c.hash.slice(0, 8)}\` (${c.date}) **${mdCell(c.author)}**: ${mdCell(c.subject)}`);
      lines.push(`  - ${c.filesChanged} files changed, ${c.insertions} insertions(+), ${c.deletions} deletions(-)`);
    }
    lines.push('');
  }

  // ── Cost detail ──
  lines.push('## Cost detail');
  lines.push('');
  if (summary.byModel.length === 0 && summary.bySquad.length === 0) {
    lines.push(`_${NO_DATA}_`);
    lines.push('');
  } else {
    lines.push('### By model');
    lines.push('');
    lines.push('| Model | Runs | Cost (USD) |');
    lines.push('|---|---:|---:|');
    for (const m of summary.byModel) lines.push(`| ${mdCell(m.model)} | ${m.runs} | ${formatUsd(m.cost)} |`);
    if (summary.byModel.length === 0) lines.push('| _no runs_ | 0 | $0.00 |');
    lines.push('');
    lines.push('### By squad');
    lines.push('');
    lines.push('| Squad | Runs | Cost (USD) |');
    lines.push('|---|---:|---:|');
    for (const s of summary.bySquad) lines.push(`| ${mdCell(s.squad)} | ${s.runs} | ${formatUsd(s.cost)} |`);
    if (summary.bySquad.length === 0) lines.push('| _no runs_ | 0 | $0.00 |');
    lines.push('');
  }

  // ── Data-completeness footer ──
  lines.push('## Data completeness');
  lines.push('');
  lines.push('| Source | Present | Records in period |');
  lines.push('|---|---|---:|');
  lines.push(`| executions.jsonl | ${data.sources.executions ? 'yes' : 'no'} | ${data.runs.length} |`);
  lines.push(`| reviewed.jsonl | ${data.sources.decisions ? 'yes' : 'no'} | ${data.decisions.length} |`);
  lines.push(`| git log | ${data.sources.git ? 'yes' : 'no'} | ${data.commits.length} |`);
  lines.push('');
  lines.push('_Every figure above traces to a record in these sources. Empty sections mean the source had no records for this period — not that data was inferred._');
  lines.push('');

  return lines.join('\n');
}

// ── HTML rendering (self-contained, print-to-PDF friendly) ───────────

function escHtml(s: unknown): string {
  const str = s === undefined || s === null ? '' : String(s);
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAuditorHtml(data: ReportData): string {
  const summary = summarize(data);
  const p = data.period;

  const tr = (cells: string[]): string =>
    `      <tr>\n${cells.map(c => `        <td>${c}</td>`).join('\n')}\n      </tr>`;

  // Summary table
  const summaryRows = [
    ['Runs', String(summary.runs)],
    ['Approvals', String(summary.approvals)],
    ['Rejections', String(summary.rejections)],
    ['Deferrals', String(summary.deferrals)],
    ['Commits', String(summary.commits)],
    ['Total tokens (in+out)', formatTokens(summary.totalTokens)],
    ['Total cost (USD)', formatUsd(summary.totalCost)],
  ];

  // Actions
  let actionsHtml: string;
  if (data.runs.length === 0) {
    actionsHtml = `    <p class="nodata">${NO_DATA}</p>`;
  } else {
    const bySquad = groupBy(data.runs, r => r.squad);
    actionsHtml = Object.keys(bySquad).sort().map(squad => {
      const head = `      <h3 class="squad">${escHtml(squad)}</h3>\n      <table>\n        <thead><tr><th>Time</th><th>Agent</th><th>Status</th><th>Model</th><th>Duration</th><th class="num">Cost</th><th>Brief</th></tr></thead>\n        <tbody>\n`;
      const body = bySquad[squad].map(r => tr([
        escHtml(shortDate(r.ts)),
        escHtml(r.agent),
        escHtml(r.status),
        escHtml(r.model || 'unknown'),
        escHtml(formatDuration(r.duration_ms)),
        `<span class="num">${escHtml(formatUsd(r.cost_usd))}</span>`,
        escHtml(r.brief || ''),
      ])).join('\n');
      return `${head}${body}\n        </tbody>\n      </table>`;
    }).join('\n');
  }

  // Decisions
  let decisionsHtml: string;
  if (data.decisions.length === 0) {
    decisionsHtml = `    <p class="nodata">${NO_DATA}</p>`;
  } else {
    decisionsHtml = `      <table>\n        <thead><tr><th>Time</th><th>Decision</th><th>Actor</th><th>Kind</th><th>Ref</th><th>Reason / result</th></tr></thead>\n        <tbody>\n` +
      data.decisions.map(d => tr([
        escHtml(shortDate(d.ts)),
        `<span class="decision ${escHtml(d.decision)}">${escHtml(d.decision)}</span>`,
        escHtml(`${d.by || 'unknown'} (${decisionActor(d.by)})`),
        escHtml(d.kind),
        escHtml(d.ref),
        escHtml(d.reason || d.result || ''),
      ])).join('\n') +
      `\n        </tbody>\n      </table>`;
  }

  // Diffs
  let diffsHtml: string;
  if (data.commits.length === 0) {
    diffsHtml = `    <p class="nodata">${NO_DATA}</p>`;
  } else {
    diffsHtml = '      <ul class="commits">\n' +
      data.commits.map(c =>
        `        <li><code>${escHtml(c.hash.slice(0, 8))}</code> <span class="date">${escHtml(c.date)}</span> <strong>${escHtml(c.author)}</strong>: ${escHtml(c.subject)}<br><span class="stat">${c.filesChanged} files changed, ${c.insertions} insertions(+), ${c.deletions} deletions(-)</span></li>`,
      ).join('\n') +
      '\n      </ul>';
  }

  // Cost detail
  const modelRows = summary.byModel.length
    ? summary.byModel.map(m => tr([escHtml(m.model), String(m.runs), formatUsd(m.cost)])).join('\n')
    : tr(['<em>no runs</em>', '0', '$0.00']);
  const squadRows = summary.bySquad.length
    ? summary.bySquad.map(s => tr([escHtml(s.squad), String(s.runs), formatUsd(s.cost)])).join('\n')
    : tr(['<em>no runs</em>', '0', '$0.00']);

  const completenessRows = ([
    ['executions.jsonl', data.sources.executions, data.runs.length],
    ['reviewed.jsonl', data.sources.decisions, data.decisions.length],
    ['git log', data.sources.git, data.commits.length],
  ] as const).map(([name, present, count]) =>
    tr([escHtml(name), present ? 'yes' : 'no', String(count)]),
  ).join('\n');

  const costByModelBlock = summary.byModel.length ? `
  <h3>Cost by model</h3>
  <table>
    <thead><tr><th>Model</th><th class="num">Runs</th><th class="num">Cost (USD)</th></tr></thead>
    <tbody>
${summary.byModel.map(m => tr([escHtml(m.model), String(m.runs), formatUsd(m.cost)])).join('\n')}
    </tbody>
  </table>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Auditor Evidence Pack — ${escHtml(data.project)}</title>
  <style>
    :root {
      --fg: #1a1a1a; --muted: #666; --line: #d0d4da;
      --bg: #fff; --alt: #f6f7f9;
      --green: #1a7f37; --red: #cf222e; --amber: #9a6700;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      color: var(--fg); background: var(--bg); margin: 0; padding: 32px;
      font-size: 13px; line-height: 1.5;
    }
    h1 { font-size: 22px; margin: 0 0 4px; }
    h2 { font-size: 17px; margin: 28px 0 10px; padding-bottom: 4px; border-bottom: 1px solid var(--line); page-break-after: avoid; }
    h3 { font-size: 14px; margin: 16px 0 6px; }
    .meta { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .meta div { margin: 2px 0; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0 14px; page-break-inside: avoid; }
    th, td { text-align: left; padding: 5px 8px; border: 1px solid var(--line); vertical-align: top; }
    th { background: var(--alt); font-weight: 600; font-size: 12px; }
    td.num, th.num, .num { text-align: right; font-variant-numeric: tabular-nums; }
    tbody tr:nth-child(even) { background: var(--alt); }
    .nodata { color: var(--muted); font-style: italic; padding: 8px 0; }
    .source { color: var(--muted); font-size: 12px; font-style: italic; margin: 4px 0 2px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; background: var(--alt); padding: 1px 4px; border-radius: 3px; }
    .commits { list-style: none; padding: 0; margin: 8px 0; }
    .commits li { padding: 6px 0; border-bottom: 1px solid var(--line); }
    .stat { color: var(--muted); font-size: 12px; }
    .date { color: var(--muted); }
    .decision { font-weight: 600; text-transform: capitalize; }
    .decision.approve { color: var(--green); }
    .decision.reject { color: var(--red); }
    .decision.defer { color: var(--amber); }
    .footer { color: var(--muted); font-size: 12px; font-style: italic; margin-top: 8px; }
    @media print {
      body { padding: 0; font-size: 11px; }
      h1, .meta { page-break-after: avoid; }
    }
  </style>
</head>
<body>
  <h1>Auditor Evidence Pack</h1>
  <div class="meta">
    <div><strong>Project:</strong> ${escHtml(data.project)}</div>
    <div><strong>Period:</strong> ${escHtml(p.label)} (${escHtml(fmtDate(p.start))} → ${escHtml(fmtDate(p.end))})</div>
    <div><strong>Generated:</strong> ${escHtml(data.generatedAt)}</div>
    <div><strong>CLI version:</strong> squads-cli v${escHtml(data.cliVersion)}</div>
  </div>

  <h2 id="summary">Summary</h2>
  <table>
    <thead><tr><th>Metric</th><th class="num">Value</th></tr></thead>
    <tbody>
${summaryRows.map(r => tr([escHtml(r[0]), `<span class="num">${escHtml(r[1])}</span>`])).join('\n')}
    </tbody>
  </table>${costByModelBlock}

  <h2 id="actions">Actions</h2>
  <p class="source">Source: <code>.agents/observability/executions.jsonl</code> — one row per run (folded).</p>
${actionsHtml}

  <h2 id="decisions">Decisions</h2>
  <p class="source">Source: <code>.agents/observability/reviewed.jsonl</code> — human-gate decisions.</p>
${decisionsHtml}

  <h2 id="diffs">Diffs</h2>
  <p class="source">Source: <code>git log</code> (project repo) — non-merge commits in the period.</p>
${diffsHtml}

  <h2 id="cost-detail">Cost detail</h2>
  <h3>By model</h3>
  <table>
    <thead><tr><th>Model</th><th class="num">Runs</th><th class="num">Cost (USD)</th></tr></thead>
    <tbody>
${modelRows}
    </tbody>
  </table>
  <h3>By squad</h3>
  <table>
    <thead><tr><th>Squad</th><th class="num">Runs</th><th class="num">Cost (USD)</th></tr></thead>
    <tbody>
${squadRows}
    </tbody>
  </table>

  <h2 id="completeness">Data completeness</h2>
  <table>
    <thead><tr><th>Source</th><th>Present</th><th class="num">Records in period</th></tr></thead>
    <tbody>
${completenessRows}
    </tbody>
  </table>
  <p class="footer">Every figure above traces to a record in these sources. Empty sections mean the source had no records for this period — not that data was inferred.</p>
</body>
</html>`;
}
