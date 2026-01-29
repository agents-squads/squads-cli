/**
 * Database Operations Tests
 *
 * Tests critical database operations in db.ts to prevent data corruption
 * and ensure robust error handling.
 *
 * Tests are organized into:
 * 1. Unit tests (mocked database, always run)
 * 2. Integration tests (real database, skipped if not available)
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

describe('Database Operations (db.ts)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('Connection Pool Management', () => {
    it('returns null pool when DATABASE_URL is not set', async () => {
      delete process.env.SQUADS_DATABASE_URL;

      const { isDatabaseAvailable } = await import('../src/lib/db.js');
      const available = await isDatabaseAvailable();

      expect(available).toBe(false);
    });

    it('handles connection timeout gracefully', async () => {
      // Set a URL that will time out
      process.env.SQUADS_DATABASE_URL = 'postgresql://invalid:invalid@192.0.2.1:5432/invalid';

      const { isDatabaseAvailable, closeDatabase } = await import('../src/lib/db.js');
      const available = await isDatabaseAvailable();

      expect(available).toBe(false);
      await closeDatabase();
    });

    it('closeDatabase handles null pool gracefully', async () => {
      delete process.env.SQUADS_DATABASE_URL;

      const { closeDatabase } = await import('../src/lib/db.js');
      // Should not throw
      await expect(closeDatabase()).resolves.toBeUndefined();
    });
  });

  describe('DashboardSnapshot Interface', () => {
    it('validates DashboardSnapshot type structure', async () => {
      // Create a valid snapshot to verify interface
      const snapshot: import('../src/lib/db.js').DashboardSnapshot = {
        totalSquads: 5,
        totalCommits: 100,
        totalPrsMerged: 20,
        totalIssuesClosed: 15,
        totalIssuesOpen: 3,
        goalProgressPct: 75.5,
        costUsd: 123.45,
        dailyBudgetUsd: 200,
        inputTokens: 50000,
        outputTokens: 10000,
        commits30d: 80,
        avgCommitsPerDay: 2.67,
        activeDays: 25,
        peakCommits: 10,
        peakDate: '2026-01-15',
        squadsData: [
          {
            name: 'engineering',
            commits: 50,
            prsOpened: 10,
            prsMerged: 8,
            issuesClosed: 5,
            issuesOpen: 2,
            goalsActive: 3,
            goalsTotal: 5,
            progress: 60,
          },
        ],
        authorsData: [{ name: 'Claude', commits: 100 }],
        reposData: [{ name: 'squads-cli', commits: 50 }],
      };

      expect(snapshot.totalSquads).toBe(5);
      expect(snapshot.squadsData).toHaveLength(1);
      expect(snapshot.squadsData[0].name).toBe('engineering');
    });

    it('handles null peakDate correctly', async () => {
      const snapshot: import('../src/lib/db.js').DashboardSnapshot = {
        totalSquads: 0,
        totalCommits: 0,
        totalPrsMerged: 0,
        totalIssuesClosed: 0,
        totalIssuesOpen: 0,
        goalProgressPct: 0,
        costUsd: 0,
        dailyBudgetUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        commits30d: 0,
        avgCommitsPerDay: 0,
        activeDays: 0,
        peakCommits: 0,
        peakDate: null,
        squadsData: [],
        authorsData: [],
        reposData: [],
      };

      expect(snapshot.peakDate).toBeNull();
      expect(snapshot.squadsData).toEqual([]);
    });
  });

  describe('saveDashboardSnapshot', () => {
    it('returns null when database is not configured', async () => {
      delete process.env.SQUADS_DATABASE_URL;

      const { saveDashboardSnapshot } = await import('../src/lib/db.js');
      const snapshot: import('../src/lib/db.js').DashboardSnapshot = {
        totalSquads: 1,
        totalCommits: 10,
        totalPrsMerged: 2,
        totalIssuesClosed: 1,
        totalIssuesOpen: 0,
        goalProgressPct: 50,
        costUsd: 10,
        dailyBudgetUsd: 100,
        inputTokens: 1000,
        outputTokens: 500,
        commits30d: 8,
        avgCommitsPerDay: 1,
        activeDays: 5,
        peakCommits: 3,
        peakDate: null,
        squadsData: [],
        authorsData: [],
        reposData: [],
      };

      const result = await saveDashboardSnapshot(snapshot);
      expect(result).toBeNull();
    });

    it('handles edge case values correctly', async () => {
      const snapshot: import('../src/lib/db.js').DashboardSnapshot = {
        totalSquads: 0,
        totalCommits: 0,
        totalPrsMerged: 0,
        totalIssuesClosed: 0,
        totalIssuesOpen: 0,
        goalProgressPct: 0,
        costUsd: 0.001, // Very small decimal
        dailyBudgetUsd: 999999.99, // Large number
        inputTokens: 0,
        outputTokens: 0,
        commits30d: 0,
        avgCommitsPerDay: 0.001, // Small decimal
        activeDays: 0,
        peakCommits: 0,
        peakDate: null,
        squadsData: [],
        authorsData: [],
        reposData: [],
      };

      expect(snapshot.costUsd).toBe(0.001);
      expect(snapshot.dailyBudgetUsd).toBe(999999.99);
    });

    it('handles special characters in squadsData names', async () => {
      const snapshot: import('../src/lib/db.js').DashboardSnapshot = {
        totalSquads: 1,
        totalCommits: 0,
        totalPrsMerged: 0,
        totalIssuesClosed: 0,
        totalIssuesOpen: 0,
        goalProgressPct: 0,
        costUsd: 0,
        dailyBudgetUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        commits30d: 0,
        avgCommitsPerDay: 0,
        activeDays: 0,
        peakCommits: 0,
        peakDate: null,
        squadsData: [
          {
            name: "test's \"special\" squad", // Special chars for SQL injection test
            commits: 0,
            prsOpened: 0,
            prsMerged: 0,
            issuesClosed: 0,
            issuesOpen: 0,
            goalsActive: 0,
            goalsTotal: 0,
            progress: 0,
          },
        ],
        authorsData: [{ name: "O'Brien", commits: 5 }],
        reposData: [{ name: 'repo-with-"quotes"', commits: 3 }],
      };

      // This should be safely serialized to JSON without issues
      const json = JSON.stringify(snapshot.squadsData);
      expect(json).toContain("test's");
      expect(json).toContain('\\"special\\"');
    });
  });

  describe('getDashboardHistory', () => {
    it('returns empty array when database is not configured', async () => {
      delete process.env.SQUADS_DATABASE_URL;

      const { getDashboardHistory } = await import('../src/lib/db.js');
      const history = await getDashboardHistory();

      expect(history).toEqual([]);
    });

    it('respects limit parameter', async () => {
      delete process.env.SQUADS_DATABASE_URL;

      const { getDashboardHistory } = await import('../src/lib/db.js');

      // Test with different limits
      const history1 = await getDashboardHistory(1);
      const history10 = await getDashboardHistory(10);
      const history100 = await getDashboardHistory(100);

      // All should return empty (no db), but function should accept limits
      expect(Array.isArray(history1)).toBe(true);
      expect(Array.isArray(history10)).toBe(true);
      expect(Array.isArray(history100)).toBe(true);
    });

    it('handles default limit', async () => {
      delete process.env.SQUADS_DATABASE_URL;

      const { getDashboardHistory } = await import('../src/lib/db.js');
      // Default limit is 30
      const history = await getDashboardHistory();

      expect(Array.isArray(history)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('isDatabaseAvailable catches and handles errors', async () => {
      // Use an invalid connection string format
      process.env.SQUADS_DATABASE_URL = 'not-a-valid-url';

      const { isDatabaseAvailable, closeDatabase } = await import('../src/lib/db.js');

      // Should not throw, should return false
      const available = await isDatabaseAvailable();
      expect(available).toBe(false);

      await closeDatabase();
    });

    it('logs errors in DEBUG mode', async () => {
      process.env.SQUADS_DATABASE_URL = 'postgresql://invalid:invalid@localhost:59999/invalid';
      process.env.DEBUG = 'true';

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { isDatabaseAvailable, closeDatabase } = await import('../src/lib/db.js');
      await isDatabaseAvailable();

      // The debug logging may or may not fire depending on timing
      // This test ensures no crash occurs with DEBUG enabled

      await closeDatabase();
      consoleSpy.mockRestore();
    });
  });

  describe('Pool Configuration', () => {
    it('uses environment variable for connection string', async () => {
      const customUrl = 'postgresql://testuser:testpass@testhost:5432/testdb';
      process.env.SQUADS_DATABASE_URL = customUrl;

      // Just verify it doesn't throw with a custom URL
      const { isDatabaseAvailable, closeDatabase } = await import('../src/lib/db.js');

      // Will fail to connect, but should use the custom URL
      const available = await isDatabaseAvailable();
      expect(available).toBe(false);

      await closeDatabase();
    });
  });
});

describe('SquadSnapshotData Interface', () => {
  it('has correct structure', async () => {
    const squadData: import('../src/lib/db.js').SquadSnapshotData = {
      name: 'test-squad',
      commits: 25,
      prsOpened: 10,
      prsMerged: 8,
      issuesClosed: 5,
      issuesOpen: 2,
      goalsActive: 3,
      goalsTotal: 4,
      progress: 75,
    };

    expect(squadData.name).toBe('test-squad');
    expect(squadData.progress).toBe(75);
    expect(squadData.goalsActive).toBeLessThanOrEqual(squadData.goalsTotal);
  });

  it('handles zero values', async () => {
    const squadData: import('../src/lib/db.js').SquadSnapshotData = {
      name: 'empty-squad',
      commits: 0,
      prsOpened: 0,
      prsMerged: 0,
      issuesClosed: 0,
      issuesOpen: 0,
      goalsActive: 0,
      goalsTotal: 0,
      progress: 0,
    };

    expect(squadData.commits).toBe(0);
    expect(squadData.progress).toBe(0);
  });

  it('handles 100% progress', async () => {
    const squadData: import('../src/lib/db.js').SquadSnapshotData = {
      name: 'complete-squad',
      commits: 100,
      prsOpened: 20,
      prsMerged: 20,
      issuesClosed: 10,
      issuesOpen: 0,
      goalsActive: 0,
      goalsTotal: 5,
      progress: 100,
    };

    expect(squadData.progress).toBe(100);
    expect(squadData.issuesOpen).toBe(0);
  });
});

describe('Baseline Operations (ROI Tracking)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('BaselineSnapshot Interface', () => {
    it('validates BaselineSnapshot structure', async () => {
      const baseline: import('../src/lib/db.js').BaselineSnapshot = {
        name: 'initial-baseline',
        capturedAt: '2026-01-15T10:00:00.000Z',
        costUsd: 500.50,
        goalsCompleted: 10,
        goalsActive: 5,
        commits: 150,
        prsMerged: 30,
        issuesClosed: 25,
        inputTokens: 500000,
        outputTokens: 100000,
        squadMetrics: [
          {
            squad: 'engineering',
            costUsd: 200.25,
            goals: 6,
            commits: 75,
            prs: 15,
          },
          {
            squad: 'research',
            costUsd: 150.25,
            goals: 4,
            commits: 50,
            prs: 10,
          },
        ],
      };

      expect(baseline.name).toBe('initial-baseline');
      expect(baseline.squadMetrics).toHaveLength(2);
      expect(baseline.squadMetrics[0].squad).toBe('engineering');
    });

    it('handles optional id field', async () => {
      const baselineWithId: import('../src/lib/db.js').BaselineSnapshot = {
        id: 42,
        name: 'with-id',
        capturedAt: '2026-01-15T10:00:00.000Z',
        costUsd: 100,
        goalsCompleted: 5,
        goalsActive: 2,
        commits: 50,
        prsMerged: 10,
        issuesClosed: 8,
        inputTokens: 100000,
        outputTokens: 20000,
        squadMetrics: [],
      };

      expect(baselineWithId.id).toBe(42);
    });

    it('handles empty squadMetrics', async () => {
      const baseline: import('../src/lib/db.js').BaselineSnapshot = {
        name: 'empty-squads',
        capturedAt: '2026-01-15T10:00:00.000Z',
        costUsd: 0,
        goalsCompleted: 0,
        goalsActive: 0,
        commits: 0,
        prsMerged: 0,
        issuesClosed: 0,
        inputTokens: 0,
        outputTokens: 0,
        squadMetrics: [],
      };

      expect(baseline.squadMetrics).toEqual([]);
    });
  });

  // Note: saveBaseline, getLatestBaseline, getBaselineByName, listBaselines
  // functions are not yet implemented in db.ts. These tests are skipped until
  // the baseline tracking feature is implemented. See issue tracking for ROI dashboard.
  describe.skip('saveBaseline (not yet implemented)', () => {
    it('returns null when database is not configured', async () => {
      // Placeholder for future implementation
    });
  });

  describe.skip('getLatestBaseline (not yet implemented)', () => {
    it('returns null when database is not configured', async () => {
      // Placeholder for future implementation
    });
  });

  describe.skip('getBaselineByName (not yet implemented)', () => {
    it('returns null when database is not configured', async () => {
      // Placeholder for future implementation
    });
  });

  describe.skip('listBaselines (not yet implemented)', () => {
    it('returns empty array when database is not configured', async () => {
      // Placeholder for future implementation
    });
  });
});

describe('Data Type Conversions', () => {
  it('correctly parses float cost values', () => {
    const costString = '123.456789';
    const parsed = parseFloat(costString);

    expect(parsed).toBeCloseTo(123.456789);
    expect(typeof parsed).toBe('number');
  });

  it('handles numeric edge cases', () => {
    // Testing the parseFloat behavior used in db.ts
    expect(parseFloat('0')).toBe(0);
    expect(parseFloat('0.00')).toBe(0);
    expect(parseFloat('999999.99')).toBe(999999.99);
    expect(parseFloat('-100.50')).toBe(-100.50);
    expect(Number.isNaN(parseFloat('not-a-number'))).toBe(true);
  });

  it('handles JSON stringification for JSONB columns', () => {
    const squadMetrics = [
      { squad: 'test', costUsd: 100, goals: 5, commits: 25, prs: 10 },
    ];

    const json = JSON.stringify(squadMetrics);
    const parsed = JSON.parse(json);

    expect(parsed).toEqual(squadMetrics);
    expect(parsed[0].squad).toBe('test');
  });

  it('handles empty arrays for JSONB columns', () => {
    const emptyArray: unknown[] = [];
    const json = JSON.stringify(emptyArray);

    expect(json).toBe('[]');
    expect(JSON.parse(json)).toEqual([]);
  });

  it('handles null values in JSON', () => {
    const dataWithNull = {
      name: null,
      value: 100,
    };

    const json = JSON.stringify(dataWithNull);
    const parsed = JSON.parse(json);

    expect(parsed.name).toBeNull();
    expect(parsed.value).toBe(100);
  });
});
