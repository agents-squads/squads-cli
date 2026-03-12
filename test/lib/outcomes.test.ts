/**
 * Tests for src/lib/outcomes.ts — outcome tracking and quality grading.
 *
 * Covers:
 * - gradeExecution: all grade paths (A, B, C, D, F)
 * - computeScorecard: filtering, rate calculations, cost per outcome
 * - computeAllScorecards: unique agent grouping, sort, persist
 * - getOutcomeScoreModifier: waste/merge/quality modifiers
 * - getAgentQualityScore: grade average, minimum threshold
 * - recordArtifacts: dedup, persist, no-repo guard
 * - pollOutcomes: PR state transitions, settle logic, age-out
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before importing the module under test
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock os to keep paths deterministic
vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/test'),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import {
  gradeExecution,
  computeScorecard,
  computeAllScorecards,
  getAgentQualityScore,
  getOutcomeScoreModifier,
  recordArtifacts,
  pollOutcomes,
  getScorecards,
  getOutcomeRecords,
  type OutcomeRecord,
  type AgentScorecard,
} from '../../src/lib/outcomes.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockExecSync = vi.mocked(execSync);

// ── Helpers ──────────────────────────────────────────────────────────

function makeOutcomes(overrides: Partial<OutcomeRecord['outcomes']> = {}): OutcomeRecord['outcomes'] {
  return {
    issuesClosed: 0,
    issuesOpen: 0,
    prsMerged: 0,
    prsClosedUnmerged: 0,
    prsOpen: 0,
    ciPassFirstPush: null,
    reviewCycleHours: null,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    executionId: 'exec-1',
    squad: 'cli',
    agent: 'issue-solver',
    completedAt: new Date().toISOString(),
    costUsd: 1.0,
    artifacts: { issuesCreated: [], prsCreated: [], commits: 0 },
    outcomes: makeOutcomes(),
    lastPolledAt: new Date().toISOString(),
    settled: false,
    ...overrides,
  };
}

function setupEmptyStore() {
  mockExistsSync.mockReturnValue(true as never);
  mockReadFileSync.mockReturnValue(
    JSON.stringify({ records: [], scorecards: [], lastUpdated: '' }) as never,
  );
}

function setupStore(records: OutcomeRecord[], scorecards: AgentScorecard[] = []) {
  mockExistsSync.mockReturnValue(true as never);
  mockReadFileSync.mockReturnValue(
    JSON.stringify({ records, scorecards, lastUpdated: '' }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMkdirSync.mockReturnValue(undefined as never);
  mockWriteFileSync.mockReturnValue(undefined as never);
});

// ── gradeExecution ───────────────────────────────────────────────────

describe('gradeExecution', () => {
  it('returns F when no artifacts produced', () => {
    const record = makeRecord();
    const result = gradeExecution(record);
    expect(result.grade).toBe('F');
    expect(result.reason).toContain('No artifacts');
  });

  it('returns A when PR is merged', () => {
    const record = makeRecord({
      artifacts: { issuesCreated: [], prsCreated: [{ repo: 'r', number: 1 }], commits: 0 },
      outcomes: makeOutcomes({ prsMerged: 1 }),
    });
    const result = gradeExecution(record);
    expect(result.grade).toBe('A');
    expect(result.reason).toContain('merged');
  });

  it('returns A with CI note when PR merged and CI passed', () => {
    const record = makeRecord({
      artifacts: { issuesCreated: [], prsCreated: [{ repo: 'r', number: 1 }], commits: 0 },
      outcomes: makeOutcomes({ prsMerged: 1, ciPassFirstPush: true }),
    });
    const result = gradeExecution(record);
    expect(result.grade).toBe('A');
    expect(result.reason).toContain('CI passed');
  });

  it('returns B when issues closed', () => {
    const record = makeRecord({
      artifacts: { issuesCreated: [{ repo: 'r', number: 10 }], prsCreated: [], commits: 0 },
      outcomes: makeOutcomes({ issuesClosed: 1 }),
    });
    const result = gradeExecution(record);
    expect(result.grade).toBe('B');
    expect(result.reason).toContain('closed');
  });

  it('returns B when PR open and awaiting review', () => {
    const record = makeRecord({
      artifacts: { issuesCreated: [], prsCreated: [{ repo: 'r', number: 2 }], commits: 0 },
      outcomes: makeOutcomes({ prsOpen: 1 }),
    });
    const result = gradeExecution(record);
    expect(result.grade).toBe('B');
    expect(result.reason).toContain('open');
  });

  it('returns D when PR closed unmerged', () => {
    const record = makeRecord({
      artifacts: { issuesCreated: [], prsCreated: [{ repo: 'r', number: 3 }], commits: 0 },
      outcomes: makeOutcomes({ prsClosedUnmerged: 1 }),
    });
    const result = gradeExecution(record);
    expect(result.grade).toBe('D');
    expect(result.reason).toContain('closed without merge');
  });

  it('returns C when only commits exist (no PRs)', () => {
    const record = makeRecord({
      artifacts: { issuesCreated: [], prsCreated: [], commits: 3 },
      outcomes: makeOutcomes(),
    });
    const result = gradeExecution(record);
    expect(result.grade).toBe('C');
    expect(result.reason).toContain('commits');
  });

  it('returns C when only issues created (no code fix)', () => {
    const record = makeRecord({
      artifacts: { issuesCreated: [{ repo: 'r', number: 5 }], prsCreated: [], commits: 0 },
      outcomes: makeOutcomes({ issuesOpen: 1 }),
    });
    const result = gradeExecution(record);
    expect(result.grade).toBe('C');
    expect(result.reason).toContain('issue(s) filed');
  });
});

// ── computeScorecard ─────────────────────────────────────────────────

describe('computeScorecard', () => {
  it('returns null when no records for agent', () => {
    setupEmptyStore();
    const result = computeScorecard('cli', 'issue-solver', '7d');
    expect(result).toBeNull();
  });

  it('returns null when records are outside the time period', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago
    const record = makeRecord({ squad: 'cli', agent: 'issue-solver', completedAt: oldDate });
    setupStore([record]);
    const result = computeScorecard('cli', 'issue-solver', '7d');
    expect(result).toBeNull();
  });

  it('calculates merge rate correctly', () => {
    const records = [
      makeRecord({ executionId: 'e1', artifacts: { prsCreated: [{ repo: 'r', number: 1 }], issuesCreated: [], commits: 0 }, outcomes: makeOutcomes({ prsMerged: 1 }) }),
      makeRecord({ executionId: 'e2', artifacts: { prsCreated: [{ repo: 'r', number: 2 }], issuesCreated: [], commits: 0 }, outcomes: makeOutcomes({ prsOpen: 1 }) }),
    ];
    setupStore(records);
    const result = computeScorecard('cli', 'issue-solver', '7d');
    expect(result).not.toBeNull();
    expect(result!.mergeRate).toBe(0.5); // 1 of 2 PRs merged
    expect(result!.executions).toBe(2);
  });

  it('calculates waste rate correctly', () => {
    const records = [
      makeRecord({ executionId: 'e1' }), // No artifacts = waste
      makeRecord({ executionId: 'e2', artifacts: { prsCreated: [{ repo: 'r', number: 1 }], issuesCreated: [], commits: 0 } }),
    ];
    setupStore(records);
    const result = computeScorecard('cli', 'issue-solver', '7d');
    expect(result).not.toBeNull();
    expect(result!.wasteRate).toBe(0.5); // 1 of 2 runs wasted
  });

  it('calculates cost per outcome', () => {
    const records = [
      makeRecord({ executionId: 'e1', costUsd: 2.0, artifacts: { prsCreated: [{ repo: 'r', number: 1 }], issuesCreated: [], commits: 0 }, outcomes: makeOutcomes({ prsMerged: 1 }) }),
    ];
    setupStore(records);
    const result = computeScorecard('cli', 'issue-solver', '7d');
    expect(result).not.toBeNull();
    expect(result!.costPerOutcome).toBe(2.0); // $2 / 1 outcome
  });

  it('handles 30d period', () => {
    const oldDate = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    const record = makeRecord({ completedAt: oldDate });
    setupStore([record]);
    const result = computeScorecard('cli', 'issue-solver', '30d');
    expect(result).not.toBeNull(); // 15 days ago is within 30d window
    expect(result!.executions).toBe(1);
  });
});

// ── computeAllScorecards ─────────────────────────────────────────────

describe('computeAllScorecards', () => {
  it('returns empty array when no records', () => {
    setupEmptyStore();
    const result = computeAllScorecards();
    expect(result).toEqual([]);
  });

  it('groups by unique squad/agent', () => {
    const records = [
      makeRecord({ executionId: 'e1', squad: 'cli', agent: 'issue-solver' }),
      makeRecord({ executionId: 'e2', squad: 'cli', agent: 'code-eval' }),
      makeRecord({ executionId: 'e3', squad: 'cli', agent: 'issue-solver' }),
    ];
    setupStore(records);
    const result = computeAllScorecards('7d');
    expect(result).toHaveLength(2);
    const agents = result.map(r => r.agent).sort();
    expect(agents).toEqual(['code-eval', 'issue-solver']);
  });

  it('persists scorecards to store', () => {
    const records = [makeRecord({ executionId: 'e1' })];
    setupStore(records);
    computeAllScorecards();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });
});

// ── getAgentQualityScore ─────────────────────────────────────────────

describe('getAgentQualityScore', () => {
  it('returns null when fewer than 2 settled records', () => {
    const record = makeRecord({ settled: true });
    setupStore([record]);
    const result = getAgentQualityScore('cli', 'issue-solver');
    expect(result).toBeNull();
  });

  it('returns null when no settled records', () => {
    const record = makeRecord({ settled: false });
    setupStore([record]);
    const result = getAgentQualityScore('cli', 'issue-solver');
    expect(result).toBeNull();
  });

  it('averages grade values for settled records', () => {
    const merged = makeRecord({
      executionId: 'e1',
      settled: true,
      artifacts: { prsCreated: [{ repo: 'r', number: 1 }], issuesCreated: [], commits: 0 },
      outcomes: makeOutcomes({ prsMerged: 1 }),
    });
    const waste = makeRecord({ executionId: 'e2', settled: true }); // F grade
    setupStore([merged, waste]);
    const result = getAgentQualityScore('cli', 'issue-solver');
    expect(result).not.toBeNull();
    // A=4, F=0 → average = 2.0
    expect(result).toBe(2.0);
  });

  it('only considers records in the last 7 days', () => {
    const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const records = [
      makeRecord({ executionId: 'e1', settled: true, completedAt: oldDate }),
      makeRecord({ executionId: 'e2', settled: true, completedAt: oldDate }),
    ];
    setupStore(records);
    const result = getAgentQualityScore('cli', 'issue-solver');
    expect(result).toBeNull(); // old records excluded
  });
});

// ── getOutcomeScoreModifier ──────────────────────────────────────────

describe('getOutcomeScoreModifier', () => {
  it('returns 0 when no scorecard data', () => {
    setupStore([], []);
    const result = getOutcomeScoreModifier('cli', 'issue-solver');
    expect(result).toBe(0);
  });

  it('returns 0 when fewer than 3 executions', () => {
    const card: AgentScorecard = {
      squad: 'cli', agent: 'issue-solver', period: '7d',
      executions: 2, wasteRate: 0.8, mergeRate: 0.1,
      issueResolutionRate: 0, ciPassRate: 0,
      avgReviewCycleHours: 0, costPerOutcome: 10,
    };
    setupStore([], [card]);
    const result = getOutcomeScoreModifier('cli', 'issue-solver');
    expect(result).toBe(0);
  });

  it('applies waste rate penalty when > 50%', () => {
    const card: AgentScorecard = {
      squad: 'cli', agent: 'issue-solver', period: '7d',
      executions: 5, wasteRate: 0.6, mergeRate: 0.5,
      issueResolutionRate: 0.5, ciPassRate: 0.5,
      avgReviewCycleHours: 2, costPerOutcome: 1,
    };
    setupStore([], [card]);
    const result = getOutcomeScoreModifier('cli', 'issue-solver');
    expect(result).toBeLessThan(0); // penalty applied
  });

  it('applies bonus when high merge rate and issue resolution rate', () => {
    const card: AgentScorecard = {
      squad: 'cli', agent: 'issue-solver', period: '7d',
      executions: 5, wasteRate: 0.1, mergeRate: 0.8,
      issueResolutionRate: 0.6, ciPassRate: 0.9,
      avgReviewCycleHours: 1, costPerOutcome: 0.5,
    };
    setupStore([], [card]);
    const result = getOutcomeScoreModifier('cli', 'issue-solver');
    expect(result).toBeGreaterThan(0); // bonus applied
  });
});

// ── recordArtifacts ──────────────────────────────────────────────────

describe('recordArtifacts', () => {
  it('returns null when no repo provided', () => {
    setupEmptyStore();
    const result = recordArtifacts({ executionId: 'e1', squad: 'cli', agent: 'issue-solver', completedAt: new Date().toISOString(), costUsd: 1.0 });
    expect(result).toBeNull();
  });

  it('returns null for duplicate executionId', () => {
    const existing = makeRecord({ executionId: 'e1' });
    setupStore([existing]);
    mockExecSync.mockReturnValue('[]' as never);
    const result = recordArtifacts({
      executionId: 'e1',
      squad: 'cli',
      agent: 'issue-solver',
      completedAt: new Date().toISOString(),
      costUsd: 1.0,
      repo: 'owner/repo',
    });
    expect(result).toBeNull();
  });

  it('records artifacts and saves to disk', () => {
    setupEmptyStore();
    mockExecSync.mockReturnValue('[]' as never); // gh returns empty PRs/issues
    const result = recordArtifacts({
      executionId: 'e2',
      squad: 'cli',
      agent: 'issue-solver',
      completedAt: new Date().toISOString(),
      costUsd: 2.5,
      repo: 'owner/repo',
    });
    expect(result).not.toBeNull();
    expect(result!.executionId).toBe('e2');
    expect(result!.costUsd).toBe(2.5);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('creates outcomes dir if it does not exist', () => {
    mockExistsSync.mockReturnValue(false as never);
    mockExecSync.mockReturnValue('[]' as never);
    recordArtifacts({
      executionId: 'e3',
      squad: 'cli',
      agent: 'issue-solver',
      completedAt: new Date().toISOString(),
      costUsd: 0,
      repo: 'owner/repo',
    });
    expect(mockMkdirSync).toHaveBeenCalled();
  });
});

// ── pollOutcomes ─────────────────────────────────────────────────────

describe('pollOutcomes', () => {
  it('returns zero counts when no unsettled records', () => {
    const record = makeRecord({ settled: true });
    setupStore([record]);
    const result = pollOutcomes();
    expect(result.polled).toBe(0);
    expect(result.settled).toBe(0);
  });

  it('polls PR state and settles when merged', () => {
    const record = makeRecord({
      executionId: 'e1',
      artifacts: { prsCreated: [{ repo: 'owner/repo', number: 42 }], issuesCreated: [], commits: 0 },
      outcomes: makeOutcomes({ prsOpen: 1 }),
    });
    setupStore([record]);

    // Mock gh pr view response: PR is merged
    const prData = JSON.stringify({
      state: 'MERGED',
      mergedAt: new Date().toISOString(),
      createdAt: new Date(Date.now() - 3600000).toISOString(),
      statusCheckRollup: [{ conclusion: 'SUCCESS' }],
    });
    mockExecSync.mockReturnValue(prData as never);

    const result = pollOutcomes();
    expect(result.polled).toBe(1);
    expect(result.settled).toBe(1);
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('polls issue state and settles when closed', () => {
    const record = makeRecord({
      executionId: 'e1',
      artifacts: { prsCreated: [], issuesCreated: [{ repo: 'owner/repo', number: 10 }], commits: 0 },
      outcomes: makeOutcomes({ issuesOpen: 1 }),
    });
    setupStore([record]);
    mockExecSync.mockReturnValue(JSON.stringify({ state: 'CLOSED' }) as never);

    const result = pollOutcomes();
    expect(result.polled).toBe(1);
    expect(result.settled).toBe(1);
  });

  it('does not settle when PR is still open', () => {
    const record = makeRecord({
      executionId: 'e1',
      artifacts: { prsCreated: [{ repo: 'owner/repo', number: 1 }], issuesCreated: [], commits: 0 },
      outcomes: makeOutcomes({ prsOpen: 1 }),
    });
    setupStore([record]);
    mockExecSync.mockReturnValue(JSON.stringify({ state: 'OPEN', mergedAt: null, createdAt: new Date().toISOString(), statusCheckRollup: null }) as never);

    const result = pollOutcomes();
    expect(result.settled).toBe(0);
  });

  it('handles gh CLI failure gracefully', () => {
    const record = makeRecord({
      executionId: 'e1',
      artifacts: { prsCreated: [{ repo: 'owner/repo', number: 1 }], issuesCreated: [], commits: 0 },
      outcomes: makeOutcomes({ prsOpen: 1 }),
    });
    setupStore([record]);
    mockExecSync.mockImplementation(() => { throw new Error('gh: command not found'); });

    const result = pollOutcomes();
    expect(result.settled).toBe(0); // Graceful failure
  });

  it('age-out records older than 30 days', () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const record = makeRecord({
      executionId: 'e1',
      completedAt: oldDate,
      artifacts: { prsCreated: [{ repo: 'owner/repo', number: 1 }], issuesCreated: [], commits: 0 },
      outcomes: makeOutcomes({ prsOpen: 1 }),
    });
    setupStore([record]);
    mockExecSync.mockReturnValue(JSON.stringify({ state: 'OPEN', mergedAt: null, createdAt: oldDate, statusCheckRollup: null }) as never);

    const result = pollOutcomes();
    expect(result.settled).toBeGreaterThan(0); // aged out
  });
});

// ── getScorecards / getOutcomeRecords ─────────────────────────────────

describe('getScorecards', () => {
  it('returns cached scorecards from store', () => {
    const card: AgentScorecard = {
      squad: 'cli', agent: 'issue-solver', period: '7d',
      executions: 5, wasteRate: 0.2, mergeRate: 0.8,
      issueResolutionRate: 0.5, ciPassRate: 0.9,
      avgReviewCycleHours: 2, costPerOutcome: 1,
    };
    setupStore([], [card]);
    const result = getScorecards();
    expect(result).toHaveLength(1);
    expect(result[0].agent).toBe('issue-solver');
  });
});

describe('getOutcomeRecords', () => {
  it('returns all outcome records', () => {
    const records = [makeRecord({ executionId: 'e1' }), makeRecord({ executionId: 'e2' })];
    setupStore(records);
    const result = getOutcomeRecords();
    expect(result).toHaveLength(2);
  });
});
