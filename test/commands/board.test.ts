/**
 * `squads board` (#1116) — day-scoped execution board.
 *
 * Covers: ledger day filtering, tile aggregation, the cost-vs-tokens
 * rendering decision (cost honesty), empty-everything (fresh `squads init`)
 * rendering without a crash, and the --json shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ObservabilityRecord } from '../../src/lib/observability.js';

vi.mock('../../src/lib/observability.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/observability.js')>();
  return { ...actual, queryExecutions: vi.fn(() => []) };
});

vi.mock('../../src/lib/runs-inventory.js', () => ({
  listDetachedRuns: vi.fn(() => []),
}));

vi.mock('../../src/lib/run-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/run-utils.js')>();
  return { ...actual, getProjectRoot: vi.fn(() => '/tmp/board-test-root') };
});

vi.mock('../../src/lib/spool.js', () => ({
  reconcileDetachedRuns: vi.fn(() => 0),
}));

// Fresh-init posture: no API configured, no git remote → both INCOMING legs skip.
vi.mock('../../src/lib/env-config.js', () => ({
  getApiUrl: vi.fn(() => ''),
}));
vi.mock('../../src/lib/github.js', () => ({
  detectGitHubRepo: vi.fn(() => undefined),
}));

import {
  boardCommand,
  dayBounds,
  filterLedgerDay,
  buildTiles,
  costCell,
  outcomesCell,
} from '../../src/commands/board.js';
import { queryExecutions } from '../../src/lib/observability.js';
import { listDetachedRuns } from '../../src/lib/runs-inventory.js';

const mockQueryExecutions = vi.mocked(queryExecutions);
const mockListDetachedRuns = vi.mocked(listDetachedRuns);

function rec(over: Partial<ObservabilityRecord>): ObservabilityRecord {
  return {
    ts: new Date().toISOString(),
    id: 'exec_x', squad: 'cli', agent: 'cli-lead', provider: 'anthropic', model: 'sonnet',
    trigger: 'manual', status: 'completed', duration_ms: 60_000,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    cost_usd: 0, context_tokens: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryExecutions.mockReturnValue([]);
  mockListDetachedRuns.mockReturnValue([]);
});

// ── Day scoping ──────────────────────────────────────────────────────

describe('dayBounds', () => {
  it('defaults to today (local midnight, 24h span)', () => {
    const b = dayBounds()!;
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    expect(b.start).toBe(midnight.getTime());
    expect(b.end - b.start).toBe(24 * 60 * 60 * 1000);
    expect(b.label).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('parses an explicit YYYY-MM-DD as a local day', () => {
    const b = dayBounds('2026-07-12')!;
    expect(b.label).toBe('2026-07-12');
    const d = new Date(b.start);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours()]).toEqual([2026, 7, 12, 0]);
  });

  it('rejects malformed and impossible dates', () => {
    expect(dayBounds('yesterday')).toBeNull();
    expect(dayBounds('2026-7-12')).toBeNull();
    expect(dayBounds('2026-02-31')).toBeNull(); // JS Date would roll this over
  });
});

describe('filterLedgerDay', () => {
  it('keeps only the requested day and sorts ascending by time', () => {
    const b = dayBounds('2026-07-12')!;
    const inDayLate = rec({ id: 'late', ts: new Date(b.start + 20 * 3600_000).toISOString() });
    const inDayEarly = rec({ id: 'early', ts: new Date(b.start + 2 * 3600_000).toISOString() });
    const dayBefore = rec({ id: 'before', ts: new Date(b.start - 1000).toISOString() });
    const dayAfter = rec({ id: 'after', ts: new Date(b.end).toISOString() });
    const badTs = rec({ id: 'bad', ts: 'not-a-date' });

    const out = filterLedgerDay([inDayLate, dayBefore, inDayEarly, dayAfter, badTs], b);
    expect(out.map((r) => r.id)).toEqual(['early', 'late']);
  });
});

// ── Tiles ────────────────────────────────────────────────────────────

describe('buildTiles', () => {
  it('sums cost, outcomes, and failures; tracks uncosted token-bearing runs', () => {
    const tiles = buildTiles([
      rec({ cost_usd: 0.5, prs_created: 1, commits: 2 }),
      rec({ cost_usd: 1.25, prs_created: 1 }),
      // GLM-lane shape: tokens recorded, cost_usd 0 (#1085) — uncosted, not free
      rec({ cost_usd: 0, input_tokens: 100_000, output_tokens: 20_000 }),
      rec({ status: 'failed', cost_usd: 0 }),
      rec({ status: 'timeout', cost_usd: 0.1 }),
    ]);
    expect(tiles.executions).toBe(5);
    expect(tiles.prs_created).toBe(2);
    expect(tiles.commits).toBe(2);
    expect(tiles.cost_usd).toBeCloseTo(1.85, 6);
    expect(tiles.failures).toBe(2); // failed + timeout
    expect(tiles.uncosted_runs).toBe(1);
    expect(tiles.uncosted_tokens).toBe(120_000);
  });

  it('is all-zero for an empty ledger', () => {
    const tiles = buildTiles([]);
    expect(tiles).toEqual({
      executions: 0, prs_created: 0, issues_created: 0, commits: 0,
      cost_usd: 0, uncosted_runs: 0, uncosted_tokens: 0, failures: 0,
    });
  });
});

// ── Cost honesty (the #1085 seam) ────────────────────────────────────

describe('costCell', () => {
  it('renders a real cost when cost_usd > 0', () => {
    expect(costCell(rec({ cost_usd: 0.42 }))).toEqual({ kind: 'cost', text: '$0.42' });
  });

  it('renders sub-cent costs with more precision instead of $0.00', () => {
    expect(costCell(rec({ cost_usd: 0.0042 }))).toEqual({ kind: 'cost', text: '$0.0042' });
  });

  it('renders tokens — never $0.00 — for a 0-cost row that burned tokens', () => {
    const cell = costCell(rec({ cost_usd: 0, input_tokens: 100_000, output_tokens: 20_000 }));
    expect(cell.kind).toBe('tokens');
    expect(cell.text).toBe('120.0k tok');
    expect(cell.text).not.toContain('$');
  });

  it('counts cache tokens toward the tokens fallback', () => {
    const cell = costCell(rec({ cost_usd: 0, cache_read_tokens: 2_000_000 }));
    expect(cell).toEqual({ kind: 'tokens', text: '2.0M tok' });
  });

  it('renders an em-dash when there is neither cost nor tokens', () => {
    expect(costCell(rec({}))).toEqual({ kind: 'none', text: '—' });
  });
});

describe('outcomesCell', () => {
  it('summarizes prs/commits/issues compactly', () => {
    expect(outcomesCell(rec({ prs_created: 1, commits: 3, issues_created: 2 }))).toBe('1pr 3c 2iss');
  });
  it('is empty when the run reported no outcomes', () => {
    expect(outcomesCell(rec({}))).toBe('');
  });
});

// ── Command behavior ─────────────────────────────────────────────────

describe('boardCommand', () => {
  it('renders empty-everything (fresh `squads init`) without crashing', async () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    await expect(boardCommand({})).resolves.toBeUndefined();
    const out = writes.join('').replace(/\x1b\[[0-9;]*m/g, '');
    expect(out).toContain('board');
    expect(out).toContain('0 executions');
    expect(out).toContain('RUNNING');
    expect(out).toContain('EXECUTIONS');
    expect(out).toContain('INCOMING');
    expect(out).toContain('No executions recorded');
    spy.mockRestore();
  });

  it('rejects an invalid --date without throwing', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await expect(boardCommand({ date: 'nope' })).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
    spy.mockRestore();
  });

  it('--json emits the full board as one object with the documented shape', async () => {
    const b = dayBounds('2026-07-12')!;
    mockQueryExecutions.mockReturnValue([
      rec({ id: 'a', ts: new Date(b.start + 3600_000).toISOString(), cost_usd: 0.5, prs_created: 1 }),
      rec({ id: 'b', ts: new Date(b.start + 7200_000).toISOString(), cost_usd: 0, input_tokens: 5000 }),
      rec({ id: 'off-day', ts: new Date(b.start - 3600_000).toISOString(), cost_usd: 99 }),
    ]);
    mockListDetachedRuns.mockReturnValue([
      {
        squad: 'cli', agent: 'solver', startedAt: Date.now() - 60_000, pid: 4242,
        pidFile: '/x/solver-1.pid', logFile: '/x/solver-1.log', repoRoot: '/x', alive: true,
      },
      {
        squad: 'cli', agent: 'dead', startedAt: Date.now() - 60_000, pid: 4243,
        pidFile: '/x/dead-1.pid', logFile: '/x/dead-1.log', repoRoot: '/x', alive: false,
      },
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boardCommand({ json: true, date: '2026-07-12' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    logSpy.mockRestore();

    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('board');
    expect(parsed.date).toBe('2026-07-12');
    // Day filter applied: the off-day record is excluded everywhere.
    expect(parsed.executions.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(parsed.tiles.executions).toBe(2);
    expect(parsed.tiles.cost_usd).toBeCloseTo(0.5, 6);
    expect(parsed.tiles.uncosted_runs).toBe(1);
    // Only ALIVE detached runs surface as running.
    expect(parsed.running).toEqual([
      expect.objectContaining({ squad: 'cli', agent: 'solver', pid: 4242 }),
    ]);
    // Both INCOMING legs degraded to null (no API, no gh repo).
    expect(parsed.incoming).toEqual({ dispatches: null, milestone: null });
  });

  it('renders a day with executions: table rows, tokens-instead-of-$0, uncosted note', async () => {
    const b = dayBounds()!;
    mockQueryExecutions.mockReturnValue([
      rec({ id: 'a', squad: 'cli', agent: 'issue-solver', ts: new Date(b.start + 9 * 3600_000).toISOString(), cost_usd: 1.2, prs_created: 1, provider: 'anthropic' }),
      rec({ id: 'b', squad: 'cli', agent: 'solver-lane-glm', ts: new Date(b.start + 10 * 3600_000).toISOString(), cost_usd: 0, input_tokens: 250_000, output_tokens: 30_000, provider: 'glm' }),
    ]);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    await boardCommand({});
    spy.mockRestore();
    const out = writes.join('').replace(/\x1b\[[0-9;]*m/g, '');

    expect(out).toContain('2 executions');
    expect(out).toContain('1 PRs created');
    expect(out).toContain('$1.20');
    expect(out).toContain('cli/issue-solver');
    expect(out).toContain('cli/solver-lane-glm');
    // GLM row: tokens shown, no fabricated price
    expect(out).toContain('280.0k tok');
    // Cost-honesty hint names the env rates
    expect(out).toContain('SQUADS_GLM_COST_PER_MTOK_IN/OUT');
  });
});
