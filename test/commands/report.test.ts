import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parsePeriod,
  summarize,
  decisionActor,
  gatherReportData,
  renderAuditorMarkdown,
  renderAuditorHtml,
  parseGitLog,
  formatUsd,
  formatTokens,
  type GitRunner,
  type ReportData,
} from '../../src/lib/report.js';

// ── Fixtures ─────────────────────────────────────────────────────────

const SEP = String.fromCharCode(0x1f); // matches the git --format delimiter

const GIT_LOG_FIXTURE = [
  ['abc1234567', 'jorge', '2026-07-20', 'feat: add report command'].join(SEP),
  ' 2 files changed, 40 insertions(+), 5 deletions(-)',
  '',
  ['def6789012', 'agent:cli-solver', '2026-07-21', 'fix(parser): handle empty'].join(SEP),
  ' 1 file changed, 3 insertions(+)',
  '',
].join('\n');

/** Fake git: answers rev-parse / remote / log from canned data. */
const fakeGit = (log = GIT_LOG_FIXTURE): GitRunner => (args) => {
  if (args[0] === 'rev-parse') return 'true\n';
  if (args[0] === 'remote') return 'git@github.com:agents-squads/squads-cli.git\n';
  if (args[0] === 'log') return log;
  return '';
};

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'squads-report-'));
  mkdirSync(join(dir, '.agents', 'observability'), { recursive: true });
  return dir;
}

function execLine(over: Partial<Record<string, unknown>> & { ts: string; id: string }): string {
  return JSON.stringify({
    ts: over.ts,
    id: over.id,
    squad: over.squad ?? 'cli',
    agent: over.agent ?? 'issue-solver',
    provider: over.provider ?? 'claude',
    model: over.model ?? 'claude-sonnet-4-6',
    trigger: 'manual',
    status: over.status ?? 'completed',
    duration_ms: over.duration_ms ?? 60_000,
    input_tokens: over.input_tokens ?? 1000,
    output_tokens: over.output_tokens ?? 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: over.cost_usd ?? 0.25,
    context_tokens: 0,
    ...over,
  });
}

function decisionLine(over: Partial<Record<string, unknown>> & { ts: string; id: string }): string {
  return JSON.stringify({
    v: 1,
    ts: over.ts,
    id: over.id,
    kind: over.kind ?? 'pr',
    ref: over.ref ?? 'squads/run-cli-abc-1',
    decision: over.decision ?? 'approve',
    result: over.result ?? 'auto-merge queued',
    by: over.by ?? 'founder@example.com',
    ...over,
  });
}

const NOW = new Date('2026-07-24T12:00:00Z');
const isoMinusDays = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

// ── parsePeriod ──────────────────────────────────────────────────────

describe('parsePeriod', () => {
  it('parses Nd as a rolling window ending at now', () => {
    const p = parsePeriod('7d', NOW);
    expect(p.label).toBe('7d');
    expect(p.end.toISOString()).toBe(NOW.toISOString());
    expect((p.end.getTime() - p.start.getTime()) / 86_400_000).toBeCloseTo(7, 5);
  });

  it('parses an explicit YYYY-MM-DD..YYYY-MM-DD range inclusive of the end day', () => {
    const p = parsePeriod('2026-07-01..2026-07-15', NOW);
    expect(p.label).toBe('2026-07-01..2026-07-15');
    expect(p.start.toISOString()).toBe('2026-07-01T00:00:00.000Z');
    // end-of-day on the 15th
    expect(p.end.toISOString()).toBe('2026-07-15T23:59:59.999Z');
  });

  it('throws on garbage input', () => {
    expect(() => parsePeriod('last month', NOW)).toThrow(/Invalid period/);
  });

  it('throws when a range ends before it starts', () => {
    expect(() => parsePeriod('2026-07-20..2026-07-01', NOW)).toThrow(/ends before it starts/);
  });
});

// ── aggregation helpers ──────────────────────────────────────────────

describe('decisionActor', () => {
  it('classifies agent: actors as agent, everything else as human', () => {
    expect(decisionActor('agent:headless')).toBe('agent');
    expect(decisionActor('agent:cli-solver')).toBe('agent');
    expect(decisionActor('founder@example.com')).toBe('human');
    expect(decisionActor(undefined)).toBe('human');
  });
});

describe('summarize', () => {
  it('aggregates runs, decisions, cost, tokens, and per-model/squad breakdowns', () => {
    const data: ReportData = {
      project: 'squads-cli', cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW),
      runs: [
        { ts: isoMinusDays(1), id: 'r1', squad: 'cli', agent: 'a', provider: 'claude', model: 'claude-sonnet-4-6', status: 'completed', duration_ms: 1000, cost_usd: 1.5, input_tokens: 1000, output_tokens: 500 },
        { ts: isoMinusDays(2), id: 'r2', squad: 'cli', agent: 'b', provider: 'claude', model: 'claude-opus-4-8', status: 'completed', duration_ms: 2000, cost_usd: 4.0, input_tokens: 2000, output_tokens: 0 },
        { ts: isoMinusDays(3), id: 'r3', squad: 'data', agent: 'c', provider: 'claude', model: 'claude-sonnet-4-6', status: 'failed', duration_ms: 500, cost_usd: 0.5, input_tokens: 0, output_tokens: 500 },
      ],
      decisions: [
        { ts: isoMinusDays(1), id: 'd1', kind: 'pr', ref: 'x', decision: 'approve', by: 'founder@example.com', result: 'merged' },
        { ts: isoMinusDays(2), id: 'd2', kind: 'pr', ref: 'y', decision: 'reject', by: 'founder@example.com', result: 'closed' },
        { ts: isoMinusDays(3), id: 'd3', kind: 'pr', ref: 'z', decision: 'defer', by: 'agent:headless', result: 'snoozed' },
      ],
      commits: [
        { hash: 'abc', author: 'j', date: '2026-07-20', subject: 's', filesChanged: 1, insertions: 2, deletions: 0 },
      ],
      sources: { executions: true, decisions: true, git: true },
    };

    const s = summarize(data);
    expect(s.runs).toBe(3);
    expect(s.approvals).toBe(1);
    expect(s.rejections).toBe(1);
    expect(s.deferrals).toBe(1);
    expect(s.commits).toBe(1);
    expect(s.totalCost).toBeCloseTo(6.0, 5);
    expect(s.totalTokens).toBe(4000);
    // per-model sorted by cost desc: opus(4.0) > sonnet(2.0)
    expect(s.byModel.map(m => m.model)).toEqual(['claude-opus-4-8', 'claude-sonnet-4-6']);
    expect(s.byModel[0].cost).toBeCloseTo(4.0, 5);
    // per-squad: cli(5.5) > data(0.5)
    expect(s.bySquad.map(x => x.squad)).toEqual(['cli', 'data']);
  });

  it('formatUsd / formatTokens format compactly', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1234.5)).toBe('$1234.50');
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });
});

// ── parseGitLog ──────────────────────────────────────────────────────

describe('parseGitLog', () => {
  it('parses commit headers + shortstat into ReportCommit rows', () => {
    const commits = parseGitLog(GIT_LOG_FIXTURE);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: 'abc1234567', author: 'jorge', date: '2026-07-20',
      subject: 'feat: add report command', filesChanged: 2, insertions: 40, deletions: 5,
    });
    // insertions-only line (no deletions) parses to 0 deletions
    expect(commits[1]).toMatchObject({ hash: 'def6789012', filesChanged: 1, insertions: 3, deletions: 0 });
  });

  it('returns [] for empty git output', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

// ── gatherReportData ─────────────────────────────────────────────────

describe('gatherReportData', () => {
  let dir: string;
  beforeEach(() => { dir = makeProject(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('records all sources absent on an empty project (fresh init)', () => {
    const data = gatherReportData({
      projectRoot: dir, cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW), gitRunner: () => '',
    });
    expect(data.runs).toEqual([]);
    expect(data.decisions).toEqual([]);
    expect(data.commits).toEqual([]);
    expect(data.sources).toEqual({ executions: false, decisions: false, git: false });
  });

  it('folds the event log to one record per run and filters by period', () => {
    writeFileSync(join(dir, '.agents', 'observability', 'executions.jsonl'), [
      execLine({ ts: isoMinusDays(1), id: 'run-A', status: 'running', cost_usd: 0 }),
      execLine({ ts: isoMinusDays(1), id: 'run-A', status: 'completed', cost_usd: 0.8 }),
      execLine({ ts: isoMinusDays(40), id: 'run-B', status: 'completed', cost_usd: 99 }), // out of window
    ].join('\n') + '\n');

    const data = gatherReportData({
      projectRoot: dir, cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW), gitRunner: () => '',
    });

    expect(data.sources.executions).toBe(true);
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].id).toBe('run-A');
    expect(data.runs[0].status).toBe('completed'); // terminal wins over 'running'
    expect(data.runs[0].cost_usd).toBeCloseTo(0.8, 5);
  });

  it('reads decisions from reviewed.jsonl and keeps only those in period', () => {
    writeFileSync(join(dir, '.agents', 'observability', 'reviewed.jsonl'), [
      decisionLine({ ts: isoMinusDays(2), id: 'd1', decision: 'approve', by: 'founder@example.com' }),
      decisionLine({ ts: isoMinusDays(3), id: 'd2', decision: 'reject', by: 'agent:headless', reason: 'bad' }),
      decisionLine({ ts: isoMinusDays(60), id: 'd3', decision: 'approve', by: 'old' }), // out of window
    ].join('\n') + '\n');

    const data = gatherReportData({
      projectRoot: dir, cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW), gitRunner: () => '',
    });

    expect(data.sources.decisions).toBe(true);
    expect(data.decisions).toHaveLength(2);
    expect(data.decisions.map(d => d.id)).toEqual(['d1', 'd2']);
  });

  it('parses git log via the injected runner and resolves the project name from origin', () => {
    const data = gatherReportData({
      projectRoot: dir, cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW), gitRunner: fakeGit(),
    });
    expect(data.sources.git).toBe(true);
    expect(data.commits).toHaveLength(2);
    expect(data.commits[0].subject).toBe('feat: add report command');
    expect(data.project).toBe('agents-squads/squads-cli');
  });
});

// ── renderAuditorMarkdown ────────────────────────────────────────────

describe('renderAuditorMarkdown', () => {
  it('renders every section as "No data" on an empty project', () => {
    const data: ReportData = {
      project: 'demo', cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW),
      runs: [], decisions: [], commits: [],
      sources: { executions: false, decisions: false, git: false },
    };
    const md = renderAuditorMarkdown(data);
    // Three "No data" lines: Actions, Decisions, Diffs (Cost detail collapses to no-data too)
    expect(md.match(/No data recorded for this period\./g)?.length).toBeGreaterThanOrEqual(3);
    expect(md).toContain('# Auditor Evidence Pack');
    expect(md).toContain('| Runs | 0 |');
    expect(md).toContain('| executions.jsonl | no | 0 |');
  });

  it('renders populated sections and escapes pipe characters in cells', () => {
    const data: ReportData = {
      project: 'demo', cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW),
      runs: [
        { ts: isoMinusDays(1), id: 'r1', squad: 'cli', agent: 'a|b', provider: 'claude', model: 'sonnet', status: 'completed', duration_ms: 65_000, cost_usd: 1.234, input_tokens: 1000, output_tokens: 500, brief: 'did thing' },
      ],
      decisions: [
        { ts: isoMinusDays(1), id: 'd1', kind: 'pr', ref: 'squads/x|y', decision: 'approve', by: 'founder@example.com', result: 'merged' },
        { ts: isoMinusDays(2), id: 'd2', kind: 'pr', ref: 'z', decision: 'reject', by: 'agent:headless', result: 'closed' },
      ],
      commits: [
        { hash: 'abc1234567', author: 'j', date: '2026-07-20', subject: 'feat', filesChanged: 2, insertions: 10, deletions: 1 },
      ],
      sources: { executions: true, decisions: true, git: true },
    };
    const md = renderAuditorMarkdown(data);
    expect(md).toContain('### cli');
    expect(md).toContain('a\\|b');            // pipe escaped in agent cell
    expect(md).toContain('squads/x\\|y');     // pipe escaped in ref cell
    expect(md).toContain('founder@example.com (human)');
    expect(md).toContain('agent:headless (agent)');
    expect(md).toContain('$1.23');            // cost rounded to 2dp
    expect(md).toContain('1m5s');             // duration formatted
    expect(md).toContain('`abc12345`');       // commit short hash
    expect(md).not.toContain('No data recorded for this period.');
  });
});

// ── renderAuditorHtml ────────────────────────────────────────────────

describe('renderAuditorHtml', () => {
  it('produces a self-contained document with no external assets', () => {
    const data: ReportData = {
      project: 'demo', cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW),
      runs: [], decisions: [], commits: [],
      sources: { executions: false, decisions: false, git: false },
    };
    const html = renderAuditorHtml(data);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<style>');         // inline CSS
    // No <link>, <script src>, or http(s) asset references.
    expect(html).not.toMatch(/<link /);
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/src="https?:/);
    expect(html).toMatch(/@media print/);
  });

  it('escapes HTML-significant characters in dynamic content', () => {
    const data: ReportData = {
      project: 'demo', cliVersion: '0.9.0', generatedAt: NOW.toISOString(),
      period: parsePeriod('30d', NOW),
      runs: [
        { ts: isoMinusDays(1), id: 'r1', squad: 'cli', agent: '<x>', provider: 'claude', model: 'm', status: 'completed', duration_ms: 1000, cost_usd: 0, input_tokens: 0, output_tokens: 0, brief: 'a & b' },
      ],
      decisions: [], commits: [],
      sources: { executions: true, decisions: false, git: false },
    };
    const html = renderAuditorHtml(data);
    expect(html).toContain('&lt;x&gt;');
    expect(html).toContain('a &amp; b');
    expect(html).not.toContain('<x>');
  });
});

// ── reportCommand (end-to-end, no real git) ──────────────────────────

describe('reportCommand', () => {
  let dir: string;
  let origCwd: string;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = makeProject();
    origCwd = process.cwd();
    process.chdir(dir);
    process.exitCode = undefined as unknown as number;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // getProjectRoot() falls back to process.cwd() when no .agents/squads exists,
    // which is exactly the fresh-init case we want to exercise.
  });
  afterEach(() => {
    process.chdir(origCwd);
    writeSpy.mockRestore();
    process.exitCode = undefined as unknown as number;
    rmSync(dir, { recursive: true, force: true });
  });

  it('md to stdout: empty data → exit 0, no "ready" preamble', async () => {
    const { reportCommand } = await import('../../src/commands/report.js');
    await reportCommand({ for: 'auditor', period: '30d', format: 'md' });
    const out = writeSpy.mock.calls.map(c => String(c[0])).join('');
    expect(out).toContain('# Auditor Evidence Pack');
    expect(out).toContain('No data recorded for this period.');
    expect(process.exitCode).toBeUndefined();
  });

  it('html default-out: writes a self-contained file under .agents/reports/', async () => {
    const { reportCommand } = await import('../../src/commands/report.js');
    await reportCommand({ for: 'auditor', period: '7d', format: 'html' });
    expect(process.exitCode).toBeUndefined();
    const expected = join(dir, '.agents', 'reports', 'auditor-7d.html');
    expect(existsSync(expected)).toBe(true);
    const file = readFileSync(expected, 'utf8');
    expect(file).toContain('<!DOCTYPE html>');
    expect(file).toContain('<style>');
  });

  it('rejects an unsupported audience with a non-zero exit', async () => {
    const { reportCommand } = await import('../../src/commands/report.js');
    await reportCommand({ for: 'ceo', period: '30d' });
    expect(process.exitCode).toBe(1);
  });
});
