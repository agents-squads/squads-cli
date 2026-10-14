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

// Claude-harness rows (#1119) read the real ~/.claude/projects on this
// machine — mock so tests stay deterministic regardless of local session
// history. Individual tests override the resolved value as needed.
vi.mock('../../src/lib/claude-sessions.js', () => ({
  deriveClaudeHarnessRows: vi.fn(() => Promise.resolve([])),
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
  repriceIfNeeded,
} from '../../src/commands/board.js';
import { queryExecutions } from '../../src/lib/observability.js';
import { listDetachedRuns } from '../../src/lib/runs-inventory.js';
import { deriveClaudeHarnessRows } from '../../src/lib/claude-sessions.js';

const mockQueryExecutions = vi.mocked(queryExecutions);
const mockListDetachedRuns = vi.mocked(listDetachedRuns);
const mockDeriveClaudeHarnessRows = vi.mocked(deriveClaudeHarnessRows);

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

/** A Claude-harness row shape as `deriveClaudeHarnessRows` (#1119) returns it. */
function harnessRec(over: Partial<ObservabilityRecord>): ObservabilityRecord {
  return rec({
    id: 'claude:session-x', squad: 'cli', agent: 'issue-solver', provider: 'claude-code',
    model: 'claude-sonnet-4-6', source: 'claude-code', cost_estimated: true,
    input_tokens: 100_000, output_tokens: 20_000, cost_usd: 0.6,
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQueryExecutions.mockReturnValue([]);
  mockListDetachedRuns.mockReturnValue([]);
  mockDeriveClaudeHarnessRows.mockResolvedValue([]);
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

// ── Board repricing (#1118) ────────────────────────────────────────────────

describe('repriceIfNeeded', () => {
  afterEach(() => {
    delete process.env.SQUADS_GLM_COST_PER_MTOK_IN;
    delete process.env.SQUADS_GLM_COST_PER_MTOK_OUT;
  });

  it('leaves non-GLM records unchanged', () => {
    const anthropicRec = rec({ provider: 'anthropic', cost_usd: 0, input_tokens: 100_000 });
    expect(repriceIfNeeded(anthropicRec)).toEqual(anthropicRec);
  });

  it('leaves GLM records with existing cost unchanged', () => {
    const glmWithCost = rec({ provider: 'glm', cost_usd: 0.5, input_tokens: 100_000 });
    expect(repriceIfNeeded(glmWithCost)).toEqual(glmWithCost);
  });

  it('leaves GLM records with no tokens unchanged', () => {
    const glmNoTokens = rec({ provider: 'glm', cost_usd: 0, input_tokens: 0, output_tokens: 0 });
    expect(repriceIfNeeded(glmNoTokens)).toEqual(glmNoTokens);
  });

  it('leaves GLM records unchanged when env rates are not set', () => {
    const glmUncosted = rec({ provider: 'glm', cost_usd: 0, input_tokens: 200_000, output_tokens: 10_000 });
    expect(repriceIfNeeded(glmUncosted)).toEqual(glmUncosted);
  });

  it('reprices GLM records when env rates are set', () => {
    process.env.SQUADS_GLM_COST_PER_MTOK_IN = '0.6';
    process.env.SQUADS_GLM_COST_PER_MTOK_OUT = '2.2';
    const glmUncosted = rec({ provider: 'glm', cost_usd: 0, input_tokens: 200_000, output_tokens: 10_000 });
    const repriced = repriceIfNeeded(glmUncosted);
    expect(repriced.cost_usd).toBeCloseTo(0.6 * 0.2 + 2.2 * 0.01, 6); // 200k in + 10k out
    expect(repriced.provider).toBe('glm');
    expect(repriced.input_tokens).toBe(200_000);
    expect(repriced.output_tokens).toBe(10_000);
  });

  it('returns a new object, leaving the original unchanged', () => {
    process.env.SQUADS_GLM_COST_PER_MTOK_IN = '0.6';
    process.env.SQUADS_GLM_COST_PER_MTOK_OUT = '2.2';
    const original = rec({ provider: 'glm', cost_usd: 0, input_tokens: 100_000, output_tokens: 10_000 });
    const originalCost = original.cost_usd;
    const repriced = repriceIfNeeded(original);
    expect(original.cost_usd).toBe(originalCost); // Original unchanged
    expect(repriced.cost_usd).not.toBe(originalCost); // Repriced has new cost
    expect(repriced).not.toBe(original); // Different object
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

  // ── Claude-harness merge (#1119) ────────────────────────────────────

  it('--json merges Claude-harness rows in, each carrying its source', async () => {
    const b = dayBounds('2026-07-12')!;
    mockQueryExecutions.mockReturnValue([
      rec({ id: 'ledger-a', ts: new Date(b.start + 3600_000).toISOString(), cost_usd: 0.5, prs_created: 1 }),
    ]);
    mockDeriveClaudeHarnessRows.mockResolvedValue([
      harnessRec({ id: 'claude:s1', ts: new Date(b.start + 7200_000).toISOString() }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boardCommand({ json: true, date: '2026-07-12' });
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    logSpy.mockRestore();

    expect(parsed.executions).toHaveLength(2);
    const bySource = Object.fromEntries(parsed.executions.map((r: { id: string; source: string }) => [r.id, r.source]));
    expect(bySource['ledger-a']).toBe('ledger');
    expect(bySource['claude:s1']).toBe('claude-code');
    // Tiles roll up both sources — this is the whole point of #1119.
    expect(parsed.tiles.executions).toBe(2);
    expect(parsed.tiles.cost_usd).toBeCloseTo(1.1, 6);
  });

  it('sorts merged rows by time across both sources', async () => {
    const b = dayBounds('2026-07-12')!;
    mockQueryExecutions.mockReturnValue([
      rec({ id: 'ledger-late', ts: new Date(b.start + 10 * 3600_000).toISOString() }),
    ]);
    mockDeriveClaudeHarnessRows.mockResolvedValue([
      harnessRec({ id: 'claude:early', ts: new Date(b.start + 2 * 3600_000).toISOString() }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boardCommand({ json: true, date: '2026-07-12' });
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    logSpy.mockRestore();

    expect(parsed.executions.map((r: { id: string }) => r.id)).toEqual(['claude:early', 'ledger-late']);
  });

  it('renders claude-code in the PROVIDER column with a ~-marked notional cost', async () => {
    const b = dayBounds()!;
    mockQueryExecutions.mockReturnValue([]);
    mockDeriveClaudeHarnessRows.mockResolvedValue([
      harnessRec({ ts: new Date(b.start + 9 * 3600_000).toISOString(), squad: 'cli', agent: 'issue-solver', cost_usd: 0.6 }),
    ]);

    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      writes.push(String(s));
      return true;
    });
    await boardCommand({});
    spy.mockRestore();
    const out = writes.join('').replace(/\x1b\[[0-9;]*m/g, '');

    expect(out).toContain('claude-code');
    expect(out).toContain('cli/issue-solver');
    expect(out).toContain('~$0.60');
    expect(out).toContain('notional list-price estimate');
  });

  // ── session_id dedup (#1129) ────────────────────────────────────────

  it('--json drops a harness row whose session_id matches a ledger row (no double-count)', async () => {
    const b = dayBounds('2026-07-12')!;
    mockQueryExecutions.mockReturnValue([
      rec({
        id: 'ledger-a', ts: new Date(b.start + 3600_000).toISOString(),
        cost_usd: 0.5, prs_created: 1, session_id: 'sess-shared',
      }),
    ]);
    mockDeriveClaudeHarnessRows.mockResolvedValue([
      // Same run, seen a second time via the transcript sweep — must be dropped.
      harnessRec({ id: 'claude:sess-shared', session_id: 'sess-shared', ts: new Date(b.start + 3660_000).toISOString() }),
      // A distinct session the ledger never saw — must survive.
      harnessRec({ id: 'claude:sess-other', session_id: 'sess-other', ts: new Date(b.start + 7200_000).toISOString() }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boardCommand({ json: true, date: '2026-07-12' });
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    logSpy.mockRestore();

    expect(parsed.executions.map((r: { id: string }) => r.id)).toEqual(['ledger-a', 'claude:sess-other']);
    expect(parsed.tiles.executions).toBe(2);
  });

  it('keeps harness rows with no session_id (pre-#1129 history) — old union behavior', async () => {
    const b = dayBounds('2026-07-12')!;
    mockQueryExecutions.mockReturnValue([
      rec({ id: 'ledger-a', ts: new Date(b.start + 3600_000).toISOString() }),
    ]);
    mockDeriveClaudeHarnessRows.mockResolvedValue([
      harnessRec({ id: 'claude:no-session-id', ts: new Date(b.start + 7200_000).toISOString() }),
    ]);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await boardCommand({ json: true, date: '2026-07-12' });
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    logSpy.mockRestore();

    expect(parsed.executions.map((r: { id: string }) => r.id)).toEqual(['ledger-a', 'claude:no-session-id']);
  });

  it('degrades to ledger-only when the transcript reader throws', async () => {
    const b = dayBounds('2026-07-12')!;
    mockQueryExecutions.mockReturnValue([
      rec({ id: 'ledger-a', ts: new Date(b.start + 3600_000).toISOString() }),
    ]);
    mockDeriveClaudeHarnessRows.mockRejectedValue(new Error('boom'));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(boardCommand({ json: true, date: '2026-07-12' })).resolves.toBeUndefined();
    const parsed = JSON.parse(logSpy.mock.calls[0][0] as string);
    logSpy.mockRestore();

    expect(parsed.executions.map((r: { id: string }) => r.id)).toEqual(['ledger-a']);
  });
});
