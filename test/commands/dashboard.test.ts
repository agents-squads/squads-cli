import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (must be declared before imports) ──

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() - 1000 })),
  };
});

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  listSquads: vi.fn(),
  loadSquad: vi.fn(),
  hasLocalInfraConfig: vi.fn(() => false),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(() => null),
}));

vi.mock('../../src/lib/costs.js', () => ({
  fetchCostSummary: vi.fn().mockResolvedValue(null),
  fetchInsights: vi.fn().mockResolvedValue(null),
  fetchBridgeStats: vi.fn().mockResolvedValue(null),
  isMaxPlan: vi.fn(() => false),
  getPlanType: vi.fn(() => 'unknown'),
  fetchNpmStats: vi.fn().mockResolvedValue(null),
  fetchQuotaInfo: vi.fn().mockResolvedValue(null),
  fetchClaudeCodeCapacity: vi.fn().mockResolvedValue(null),
  calculateROIMetrics: vi.fn(() => ({
    totalCostUsd: 0,
    costPerGoal: 0,
    costPerPR: 0,
    costPerCommit: 0,
    roiMultiplier: 0,
    estimatedValueUsd: 0,
    dailyProjectedCost: 0,
    weeklyProjectedCost: 0,
    monthlyProjectedCost: 0,
  })),
  calculateSquadCostProjections: vi.fn(() => []),
}));

vi.mock('../../src/lib/git.js', () => ({
  getMultiRepoGitStats: vi.fn().mockResolvedValue(null),
  getActivitySparkline: vi.fn().mockResolvedValue([]),
  getGitHubStatsOptimized: vi.fn(() => null),
}));

vi.mock('../../src/lib/db.js', () => ({
  saveDashboardSnapshot: vi.fn().mockResolvedValue(null),
  isDatabaseAvailable: vi.fn().mockResolvedValue(false),
  getDashboardHistory: vi.fn().mockResolvedValue([]),
  closeDatabase: vi.fn().mockResolvedValue(undefined),
  getLatestBaseline: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/lib/sessions.js', () => ({
  getLiveSessionSummaryAsync: vi.fn().mockResolvedValue({
    totalSessions: 0,
    bySquad: {},
    squadCount: 0,
    byTool: {},
  }),
  cleanupStaleSessions: vi.fn(),
}));

vi.mock('../../src/lib/update.js', () => ({
  checkForUpdate: vi.fn(() => ({ updateAvailable: false })),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  Events: { CLI_DASHBOARD: 'cli_dashboard' },
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', purple: '', cyan: '', white: '' },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  progressBar: vi.fn((_pct: number, _w: number) => '[====]'),
  box: {
    topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+',
    vertical: '|', horizontal: '-', teeLeft: '+', teeRight: '+',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
  truncate: vi.fn((s: string, n: number) => s.length > n ? s.slice(0, n - 1) + '~' : s),
  icons: { active: '*', idle: 'o', error: 'x', pending: 'o', progress: '>', empty: '-', warning: '!' },
  sparkline: vi.fn(() => '|____|'),
  barChart: vi.fn(() => '[===]'),
}));

// ── Imports (after mocks) ──

import { dashboardCommand } from '../../src/commands/dashboard.js';
import { findSquadsDir, listSquads, loadSquad, hasLocalInfraConfig } from '../../src/lib/squad-parser.js';
import { findMemoryDir } from '../../src/lib/memory.js';
import { getLiveSessionSummaryAsync } from '../../src/lib/sessions.js';
import { getMultiRepoGitStats, getActivitySparkline, getGitHubStatsOptimized } from '../../src/lib/git.js';
import {
  fetchCostSummary, fetchBridgeStats, fetchInsights,
  getPlanType, isMaxPlan,
  fetchNpmStats, fetchQuotaInfo, fetchClaudeCodeCapacity,
  calculateROIMetrics, calculateSquadCostProjections,
} from '../../src/lib/costs.js';
import { isDatabaseAvailable, getDashboardHistory, closeDatabase, getLatestBaseline } from '../../src/lib/db.js';
import { checkForUpdate } from '../../src/lib/update.js';
import { writeLine } from '../../src/lib/terminal.js';
import { existsSync, readdirSync } from 'fs';

// ── Typed mocks ──

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockListSquads = vi.mocked(listSquads);
const mockLoadSquad = vi.mocked(loadSquad);
const mockHasLocalInfraConfig = vi.mocked(hasLocalInfraConfig);
const mockFindMemoryDir = vi.mocked(findMemoryDir);
const mockGetLiveSessionSummaryAsync = vi.mocked(getLiveSessionSummaryAsync);
const mockGetMultiRepoGitStats = vi.mocked(getMultiRepoGitStats);
const mockGetActivitySparkline = vi.mocked(getActivitySparkline);
const mockGetGitHubStatsOptimized = vi.mocked(getGitHubStatsOptimized);
const mockFetchCostSummary = vi.mocked(fetchCostSummary);
const mockFetchBridgeStats = vi.mocked(fetchBridgeStats);
const mockFetchInsights = vi.mocked(fetchInsights);
const mockGetPlanType = vi.mocked(getPlanType);
const mockIsMaxPlan = vi.mocked(isMaxPlan);
const mockFetchNpmStats = vi.mocked(fetchNpmStats);
const mockFetchQuotaInfo = vi.mocked(fetchQuotaInfo);
const mockFetchClaudeCodeCapacity = vi.mocked(fetchClaudeCodeCapacity);
const mockCalculateROIMetrics = vi.mocked(calculateROIMetrics);
const mockCalculateSquadCostProjections = vi.mocked(calculateSquadCostProjections);
const mockIsDatabaseAvailable = vi.mocked(isDatabaseAvailable);
const mockGetDashboardHistory = vi.mocked(getDashboardHistory);
const mockCloseDatabase = vi.mocked(closeDatabase);
const mockGetLatestBaseline = vi.mocked(getLatestBaseline);
const mockCheckForUpdate = vi.mocked(checkForUpdate);
const mockWriteLine = vi.mocked(writeLine);
const mockExistsSync = vi.mocked(existsSync);
const mockReaddirSync = vi.mocked(readdirSync);

// ── Test helpers ──

function makeSquad(overrides: Record<string, unknown> = {}) {
  return {
    name: 'engineering',
    mission: 'Build great software',
    goals: [
      { description: 'Ship v1.0', metrics: [], completed: false },
      { description: 'Fix critical bug', metrics: [], completed: true },
    ],
    context: {},
    agents: [],
    pipelines: [],
    routines: [],
    ...overrides,
  } as ReturnType<typeof loadSquad>;
}

function allWriteLineOutput(): string {
  return mockWriteLine.mock.calls.map(c => String(c[0] ?? '')).join('\n');
}

// ── Tests ──

describe('dashboardCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default: squads dir exists with one squad
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockListSquads.mockReturnValue(['engineering']);
    mockLoadSquad.mockReturnValue(makeSquad());
    mockFindMemoryDir.mockReturnValue(null);
    mockHasLocalInfraConfig.mockReturnValue(false);

    // Defaults for async data fetchers (all return "no data")
    mockGetLiveSessionSummaryAsync.mockResolvedValue({
      totalSessions: 0,
      bySquad: {},
      squadCount: 0,
      byTool: {},
    });
    mockGetMultiRepoGitStats.mockResolvedValue(null);
    mockGetActivitySparkline.mockResolvedValue([]);
    mockGetGitHubStatsOptimized.mockReturnValue(null);
    mockFetchCostSummary.mockResolvedValue(null);
    mockFetchBridgeStats.mockResolvedValue(null);
    mockFetchInsights.mockResolvedValue(null);
    mockFetchNpmStats.mockResolvedValue(null);
    mockFetchQuotaInfo.mockResolvedValue(null);
    mockFetchClaudeCodeCapacity.mockResolvedValue(null);
    mockCalculateROIMetrics.mockReturnValue({
      totalCostUsd: 0, costPerGoal: 0, costPerPR: 0, costPerCommit: 0,
      roiMultiplier: 0, estimatedValueUsd: 0,
      dailyProjectedCost: 0, weeklyProjectedCost: 0, monthlyProjectedCost: 0,
    } as ReturnType<typeof calculateROIMetrics>);
    mockCalculateSquadCostProjections.mockReturnValue([]);
    mockIsDatabaseAvailable.mockResolvedValue(false);
    mockGetDashboardHistory.mockResolvedValue([]);
    mockCloseDatabase.mockResolvedValue(undefined);
    mockGetLatestBaseline.mockResolvedValue(null);
    mockCheckForUpdate.mockReturnValue({ updateAvailable: false } as ReturnType<typeof checkForUpdate>);
    mockGetPlanType.mockReturnValue('unknown');
    mockIsMaxPlan.mockReturnValue(false);

    // fs defaults: findAgentsSquadsDir returns null (no hq dir, no .git)
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
  });

  // ── Basic rendering ──

  it('renders dashboard without errors for a single squad', async () => {
    await expect(dashboardCommand()).resolves.toBeUndefined();
    expect(mockCloseDatabase).toHaveBeenCalled();
  });

  it('returns early when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('No .agents/squads directory found');
    // Should not call closeDatabase since we return early
    expect(mockCloseDatabase).not.toHaveBeenCalled();
  });

  it('renders header with squad gradient title', async () => {
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('squads');
    expect(output).toContain('dashboard');
  });

  it('renders squads table with squad name', async () => {
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('SQUAD');
    expect(output).toContain('engineering');
  });

  it('renders footer with command hints', async () => {
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('squads run');
    expect(output).toContain('squads goal set');
  });

  it('tracks telemetry event', async () => {
    const { track } = await import('../../src/lib/telemetry.js');
    await dashboardCommand({ verbose: true });
    expect(track).toHaveBeenCalledWith('cli_dashboard', expect.objectContaining({ verbose: true }));
  });

  // ── Multiple squads ──

  it('renders multiple squads in the table', async () => {
    mockListSquads.mockReturnValue(['engineering', 'marketing', 'product']);
    mockLoadSquad.mockImplementation((name: string) =>
      makeSquad({ name, mission: `${name} mission` }),
    );

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('engineering');
    expect(output).toContain('marketing');
    expect(output).toContain('product');
  });

  // ── Empty / edge cases ──

  it('handles zero squads', async () => {
    mockListSquads.mockReturnValue([]);
    await expect(dashboardCommand()).resolves.toBeUndefined();
  });

  it('handles squad with no goals', async () => {
    mockLoadSquad.mockReturnValue(makeSquad({ goals: [] }));
    await expect(dashboardCommand()).resolves.toBeUndefined();
  });

  it('handles squad with all goals completed', async () => {
    mockLoadSquad.mockReturnValue(makeSquad({
      goals: [
        { description: 'Done A', metrics: [], completed: true },
        { description: 'Done B', metrics: [], completed: true },
      ],
    }));
    await expect(dashboardCommand()).resolves.toBeUndefined();
  });

  it('skips a squad when loadSquad returns null', async () => {
    mockListSquads.mockReturnValue(['engineering', 'missing']);
    mockLoadSquad.mockImplementation((name: string) => {
      if (name === 'missing') return null;
      return makeSquad({ name });
    });
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('engineering');
    expect(output).not.toContain('missing');
  });

  // ── JSON output ──

  it('outputs valid JSON with --json flag', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dashboardCommand({ json: true });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('dash');
    expect(parsed.data).toBeDefined();
    expect(parsed.data.squads).toBeInstanceOf(Array);
    expect(parsed.data.stats).toBeDefined();
    expect(parsed.data.goals).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('JSON output includes squad data', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dashboardCommand({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    const squad = parsed.data.squads[0];
    expect(squad.name).toBe('engineering');
    expect(squad.mission).toBe('Build great software');
    expect(squad.goals).toBeInstanceOf(Array);
    consoleSpy.mockRestore();
  });

  it('JSON output includes goal counts', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dashboardCommand({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.data.goals.active).toBe(1);
    expect(parsed.data.goals.completed).toBe(1);
    consoleSpy.mockRestore();
  });

  it('JSON output includes stats aggregation', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockListSquads.mockReturnValue(['engineering', 'marketing']);
    mockLoadSquad.mockImplementation((name: string) =>
      makeSquad({ name, goals: [{ description: 'A goal', metrics: [], completed: false }] }),
    );
    await dashboardCommand({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.data.stats.totalSquads).toBe(2);
    consoleSpy.mockRestore();
  });

  // ── Session display ──

  it('shows active sessions when present', async () => {
    mockGetLiveSessionSummaryAsync.mockResolvedValue({
      totalSessions: 3,
      bySquad: { engineering: 2, marketing: 1 },
      squadCount: 2,
      byTool: { claude: 2, cursor: 1 },
    });
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('3');
    expect(output).toContain('session');
  });

  it('does not show session line when no active sessions', async () => {
    await dashboardCommand();
    const output = allWriteLineOutput();
    // writeLine calls should not include "active session" text
    expect(output).not.toContain('active session');
  });

  // ── Update available ──

  it('shows update notice when update available', async () => {
    mockCheckForUpdate.mockReturnValue({
      updateAvailable: true,
      currentVersion: '0.7.0',
      latestVersion: '0.8.0',
    } as ReturnType<typeof checkForUpdate>);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Update available');
    expect(output).toContain('0.8.0');
  });

  // ── CEO mode ──

  it('renders CEO report with --ceo flag', async () => {
    await dashboardCommand({ ceo: true });
    const output = allWriteLineOutput();
    expect(output).toContain('CEO Report');
    expect(output).toContain('METRIC');
    expect(output).toContain('Active Squads');
  });

  it('CEO report shows blockers for squads with no active goals', async () => {
    mockLoadSquad.mockReturnValue(makeSquad({
      goals: [{ description: 'All done', metrics: [], completed: true }],
    }));
    await dashboardCommand({ ceo: true });
    const output = allWriteLineOutput();
    expect(output).toContain('Blockers');
    expect(output).toContain('No active goals');
  });

  it('CEO report shows P0 and P1 goals', async () => {
    mockLoadSquad.mockReturnValue(makeSquad({
      goals: [
        { description: 'Build revenue pipeline', metrics: [], completed: false },
        { description: 'Fix deploy script', metrics: [], completed: false },
      ],
    }));
    await dashboardCommand({ ceo: true });
    const output = allWriteLineOutput();
    expect(output).toContain('P0');
    expect(output).toContain('P1');
  });

  it('CEO report shows Next Steps section', async () => {
    await dashboardCommand({ ceo: true });
    const output = allWriteLineOutput();
    expect(output).toContain('Next Steps');
  });

  // ── Goals section ──

  it('renders goals section with tactical/strategic sorting', async () => {
    mockLoadSquad.mockReturnValue(makeSquad({
      goals: [
        { description: 'Build revenue pipeline', metrics: [], completed: false },
        { description: 'Fix login bug', metrics: [], completed: false },
        { description: 'Improve performance', metrics: [], completed: false },
      ],
    }));
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Goals');
    expect(output).toContain('tactical');
  });

  it('renders goal progress when available', async () => {
    mockLoadSquad.mockReturnValue(makeSquad({
      goals: [
        { description: 'Fix login bug', metrics: [], completed: false, progress: '70% done' },
      ],
    }));
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('70% done');
  });

  it('shows +N more when goals exceed limit', async () => {
    const manyGoals = Array.from({ length: 8 }, (_, i) => ({
      description: `Fix bug ${i + 1}`,
      metrics: [],
      completed: false,
    }));
    mockLoadSquad.mockReturnValue(makeSquad({ goals: manyGoals }));
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('+');
    expect(output).toContain('more');
  });

  // ── Git activity section ──

  it('renders git performance when stats available', async () => {
    mockExistsSync.mockReturnValue(true); // findAgentsSquadsDir will find .git
    mockGetMultiRepoGitStats.mockResolvedValue({
      totalCommits: 42,
      avgCommitsPerDay: 3,
      activeDays: 14,
      peakDay: { date: '2026-03-15', count: 8 },
      commitsByRepo: new Map([['squads-cli', 30], ['hq', 12]]),
      commitsByAuthor: new Map([['alice', 25], ['bob', 17]]),
      repos: [
        { name: 'squads-cli', commits: 30, branch: 'main', latestCommit: 'abc' },
        { name: 'hq', commits: 12, branch: 'main', latestCommit: 'def' },
      ],
      recentCommits: [
        { hash: 'abc1234', message: 'feat: add dashboard tests', repo: 'squads-cli', date: '2026-03-27', author: 'alice' },
      ],
    } as Awaited<ReturnType<typeof getMultiRepoGitStats>>);
    mockGetActivitySparkline.mockResolvedValue([1, 3, 5, 2, 0, 4, 7, 3, 2, 1, 5, 6, 4, 3]);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Git Activity');
    expect(output).toContain('42');
    expect(output).toContain('commits');
  });

  it('shows "no commits" when git stats empty', async () => {
    mockExistsSync.mockReturnValue(true);
    mockGetMultiRepoGitStats.mockResolvedValue({
      totalCommits: 0,
      avgCommitsPerDay: 0,
      activeDays: 0,
      peakDay: null,
      commitsByRepo: new Map(),
      commitsByAuthor: new Map(),
      repos: [],
      recentCommits: [],
    } as unknown as Awaited<ReturnType<typeof getMultiRepoGitStats>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('no commits');
  });

  // ── Working On section ──

  it('renders working on section with recent commits', async () => {
    mockExistsSync.mockReturnValue(true);
    mockGetMultiRepoGitStats.mockResolvedValue({
      totalCommits: 5,
      avgCommitsPerDay: 1,
      activeDays: 5,
      peakDay: null,
      commitsByRepo: new Map([['squads-cli', 5]]),
      commitsByAuthor: new Map([['alice', 5]]),
      repos: [{ name: 'squads-cli', commits: 5, branch: 'main', latestCommit: 'abc' }],
      recentCommits: [
        { hash: 'abc1234567', message: 'feat: something cool', repo: 'squads-cli', date: '2026-03-27', author: 'alice' },
        { hash: 'def5678901', message: 'fix: another thing', repo: 'hq', date: '2026-03-26', author: 'bob' },
      ],
    } as Awaited<ReturnType<typeof getMultiRepoGitStats>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Working On');
    expect(output).toContain('abc1234'); // short hash
  });

  // ── Token economics / costs ──

  it('renders token economics with cost data', async () => {
    mockHasLocalInfraConfig.mockReturnValue(true);
    mockFetchBridgeStats.mockResolvedValue({
      today: { costUsd: 1.5, generations: 25, inputTokens: 100000, outputTokens: 20000 },
      week: { costUsd: 8.0, generations: 100, inputTokens: 500000, outputTokens: 100000, byModel: [] },
      budget: { used: 1.5, daily: 10, usedPct: 15 },
      bySquad: [],
      byModel: [],
      health: { postgres: 'connected', redis: 'disabled' },
      source: 'bridge',
    } as unknown as Awaited<ReturnType<typeof fetchBridgeStats>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Token Economics');
  });

  it('renders plan info when getPlanType returns max', async () => {
    mockGetPlanType.mockReturnValue('max');
    mockHasLocalInfraConfig.mockReturnValue(true);
    mockFetchBridgeStats.mockResolvedValue({
      today: { costUsd: 0, generations: 0, inputTokens: 0, outputTokens: 0 },
      week: null,
      budget: { used: 0, daily: 10, usedPct: 0 },
      bySquad: [],
      byModel: [],
      health: { postgres: 'disconnected', redis: 'disabled' },
      source: 'bridge',
    } as unknown as Awaited<ReturnType<typeof fetchBridgeStats>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Claude Max');
  });

  it('renders setup hint when no infra configured', async () => {
    mockHasLocalInfraConfig.mockReturnValue(false);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Token Economics');
    expect(output).toContain('Track costs');
  });

  // ── Infrastructure section ──

  it('renders infrastructure as local-only when no infra', async () => {
    mockHasLocalInfraConfig.mockReturnValue(false);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Infrastructure');
    expect(output).toContain('local only');
  });

  it('renders infrastructure health when bridge stats available', async () => {
    mockHasLocalInfraConfig.mockReturnValue(true);
    mockFetchBridgeStats.mockResolvedValue({
      today: { costUsd: 0, generations: 0, inputTokens: 0, outputTokens: 0 },
      week: null,
      budget: { used: 0, daily: 10, usedPct: 0 },
      bySquad: [],
      byModel: [],
      health: { postgres: 'connected', redis: 'connected' },
      source: 'bridge',
    } as unknown as Awaited<ReturnType<typeof fetchBridgeStats>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('postgres');
    expect(output).toContain('redis');
  });

  // ── Quota / subscription ROI ──

  it('renders subscription ROI section when quota data available', async () => {
    mockFetchQuotaInfo.mockResolvedValue({
      monthlyQuota: 200,
      monthlyUsed: 450,
      autonomyScore: 80,
      confidenceLevel: 'high',
      learningCount: 5,
    } as Awaited<ReturnType<typeof fetchQuotaInfo>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Subscription ROI');
    expect(output).toContain('Excellent value');
  });

  it('skips quota section when no quota data', async () => {
    mockFetchQuotaInfo.mockResolvedValue(null);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).not.toContain('Subscription ROI');
  });

  // ── Capacity section ──

  it('renders capacity section when Claude Code capacity available', async () => {
    mockFetchClaudeCodeCapacity.mockResolvedValue({
      weeklyCapacityPct: 45,
      weeklyResetDate: 'Mon Apr 1',
      weeklyTokensUsed: 500000,
      weeklyTokensLimit: 1100000,
      opusTokensUsed: 300000,
      sonnetTokensUsed: 200000,
      sessionCapacityPct: 5,
      sessionResetTime: '3:00 PM',
    } as Awaited<ReturnType<typeof fetchClaudeCodeCapacity>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Subscription Capacity');
    expect(output).toContain('headroom');
  });

  it('skips capacity section when no capacity data', async () => {
    mockFetchClaudeCodeCapacity.mockResolvedValue(null);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).not.toContain('Subscription Capacity');
  });

  // ── Historical trends ──

  it('renders historical trends when db has history', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(true);
    mockGetDashboardHistory.mockResolvedValue([
      { costUsd: 1.5, inputTokens: 50000, outputTokens: 10000, goalProgressPct: 30, totalSquads: 3, totalCommits: 10, totalPrsMerged: 2, totalIssuesClosed: 5, totalIssuesOpen: 3, dailyBudgetUsd: 10, commits30d: 10, avgCommitsPerDay: 2, activeDays: 5, peakCommits: 4, peakDate: null, squadsData: [], authorsData: [], reposData: [] },
      { costUsd: 2.0, inputTokens: 60000, outputTokens: 12000, goalProgressPct: 35, totalSquads: 3, totalCommits: 15, totalPrsMerged: 3, totalIssuesClosed: 7, totalIssuesOpen: 2, dailyBudgetUsd: 10, commits30d: 15, avgCommitsPerDay: 3, activeDays: 6, peakCommits: 5, peakDate: null, squadsData: [], authorsData: [], reposData: [] },
      { costUsd: 1.8, inputTokens: 55000, outputTokens: 11000, goalProgressPct: 40, totalSquads: 3, totalCommits: 12, totalPrsMerged: 2, totalIssuesClosed: 6, totalIssuesOpen: 2, dailyBudgetUsd: 10, commits30d: 12, avgCommitsPerDay: 2, activeDays: 5, peakCommits: 4, peakDate: null, squadsData: [], authorsData: [], reposData: [] },
    ] as Awaited<ReturnType<typeof getDashboardHistory>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Usage Trends');
  });

  it('skips trends when db not available', async () => {
    mockIsDatabaseAvailable.mockResolvedValue(false);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).not.toContain('Usage Trends');
  });

  // ── Insights section ──

  it('renders agent insights when insights available', async () => {
    mockFetchInsights.mockResolvedValue({
      source: 'bridge',
      days: 7,
      taskMetrics: [
        { agent: 'solver', tasksTotal: 10, tasksCompleted: 8, tasksFailed: 2, totalRetries: 3, tasksWithRetries: 2, avgDurationMs: 5000 },
      ],
      toolMetrics: [],
      qualityMetrics: { avgFirstTrySuccess: 0.8, avgRetryRate: 0.2 },
    } as Awaited<ReturnType<typeof fetchInsights>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Agent Insights');
    expect(output).toContain('completed');
  });

  it('skips insights when source is none', async () => {
    mockFetchInsights.mockResolvedValue({
      source: 'none',
      days: 7,
      taskMetrics: [],
      toolMetrics: [],
      qualityMetrics: { avgFirstTrySuccess: 0, avgRetryRate: 0 },
    } as Awaited<ReturnType<typeof fetchInsights>>);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).not.toContain('Agent Insights');
  });

  // ── ROI section ──

  it('renders ROI section when costs available', async () => {
    mockFetchCostSummary.mockResolvedValue({
      totalCost: 5.0,
      dailyBudget: 10,
      totalCalls: 50,
      bySquad: [],
    } as unknown as Awaited<ReturnType<typeof fetchCostSummary>>);
    mockCalculateROIMetrics.mockReturnValue({
      totalCostUsd: 5.0,
      costPerGoal: 2.5,
      costPerPR: 1.0,
      costPerCommit: 0.5,
      roiMultiplier: 3.0,
      estimatedValueUsd: 15.0,
      dailyProjectedCost: 5.0,
      weeklyProjectedCost: 35.0,
      monthlyProjectedCost: 150.0,
    } as ReturnType<typeof calculateROIMetrics>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('ROI & Projections');
  });

  it('skips ROI when no cost data', async () => {
    mockFetchCostSummary.mockResolvedValue(null);
    mockFetchBridgeStats.mockResolvedValue(null);
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).not.toContain('ROI & Projections');
  });

  // ── Baseline comparison ──

  it('renders baseline comparison when baseline exists', async () => {
    mockFetchCostSummary.mockResolvedValue({
      totalCost: 5.0,
      dailyBudget: 10,
      totalCalls: 50,
      bySquad: [],
    } as unknown as Awaited<ReturnType<typeof fetchCostSummary>>);
    mockGetLatestBaseline.mockResolvedValue({
      name: 'v0.7',
      costUsd: 3.0,
      goalsCompleted: 2,
      commits: 10,
      prsMerged: 5,
      snapshotDate: '2026-03-20',
    } as Awaited<ReturnType<typeof getLatestBaseline>>);
    mockCalculateROIMetrics.mockReturnValue({
      totalCostUsd: 5.0, costPerGoal: 2.5, costPerPR: 1.0, costPerCommit: 0.5,
      roiMultiplier: 3.0, estimatedValueUsd: 15.0,
      dailyProjectedCost: 5.0, weeklyProjectedCost: 35.0, monthlyProjectedCost: 150.0,
    } as ReturnType<typeof calculateROIMetrics>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('vs Baseline');
  });

  it('shows baseline capture hint when no baseline', async () => {
    mockFetchCostSummary.mockResolvedValue({
      totalCost: 1.0,
      dailyBudget: 10,
      totalCalls: 5,
      bySquad: [],
    } as unknown as Awaited<ReturnType<typeof fetchCostSummary>>);
    mockCalculateROIMetrics.mockReturnValue({
      totalCostUsd: 1.0, costPerGoal: 0, costPerPR: 0, costPerCommit: 0,
      roiMultiplier: 0, estimatedValueUsd: 0,
      dailyProjectedCost: 1.0, weeklyProjectedCost: 7.0, monthlyProjectedCost: 30.0,
    } as ReturnType<typeof calculateROIMetrics>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('No baseline set');
    expect(output).toContain('squads baseline');
  });

  // ── Squad status classification ──

  it('classifies squad as needs-goal when no active goals', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockLoadSquad.mockReturnValue(makeSquad({
      goals: [{ description: 'Done', metrics: [], completed: true }],
    }));
    await dashboardCommand({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.data.squads[0].status).toBe('needs-goal');
    consoleSpy.mockRestore();
  });

  it('classifies squad as stale when memory dir unavailable (lastActivity contains "w")', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // findMemoryDir returns null -> getLastActivityDate returns 'unknown'
    // 'unknown' contains 'w', so the squad is classified as 'stale'
    mockLoadSquad.mockReturnValue(makeSquad({
      goals: [{ description: 'Ship it', metrics: [], completed: false }],
    }));
    await dashboardCommand({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.data.squads[0].status).toBe('stale');
    consoleSpy.mockRestore();
  });

  it('classifies squad with dash lastActivity as stale', async () => {
    // When memory dir exists but squad memory subdir does not, lastActivity = '—'
    // '—' === '—' triggers stale status
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockFindMemoryDir.mockReturnValue('/test/.agents/memory');
    // existsSync returns false for the squad memory subdir
    mockExistsSync.mockReturnValue(false);
    mockLoadSquad.mockReturnValue(makeSquad({
      goals: [{ description: 'Ship it', metrics: [], completed: false }],
    }));
    await dashboardCommand({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.data.squads[0].status).toBe('stale');
    consoleSpy.mockRestore();
  });

  // ── fast mode ──

  it('defaults to fast mode (skips GitHub API)', async () => {
    await dashboardCommand();
    // getGitHubStatsOptimized should not be called in fast mode (default)
    expect(mockGetGitHubStatsOptimized).not.toHaveBeenCalled();
  });

  // ── Database snapshot saving ──

  it('saves snapshot when database is available', async () => {
    const { saveDashboardSnapshot } = await import('../../src/lib/db.js');
    mockIsDatabaseAvailable.mockResolvedValue(true);
    await dashboardCommand();
    expect(saveDashboardSnapshot).toHaveBeenCalled();
  });

  it('does not save snapshot when database unavailable', async () => {
    const { saveDashboardSnapshot } = await import('../../src/lib/db.js');
    mockIsDatabaseAvailable.mockResolvedValue(false);
    await dashboardCommand();
    expect(saveDashboardSnapshot).not.toHaveBeenCalled();
  });

  // ── closeDatabase always called ──

  it('calls closeDatabase after rendering', async () => {
    await dashboardCommand();
    expect(mockCloseDatabase).toHaveBeenCalledTimes(1);
  });

  it('calls closeDatabase after JSON output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await dashboardCommand({ json: true });
    expect(mockCloseDatabase).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  // ── Acquisition section ──

  it('skips acquisition when SQUADS_NPM_PACKAGE not set', async () => {
    delete process.env.SQUADS_NPM_PACKAGE;
    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).not.toContain('Acquisition');
  });

  it('renders acquisition when npm stats available and env set', async () => {
    process.env.SQUADS_NPM_PACKAGE = 'squads-cli';
    mockFetchNpmStats.mockResolvedValue({
      downloads: { lastDay: 50, lastWeek: 300, lastMonth: 1200 },
      weekOverWeek: 15,
    } as Awaited<ReturnType<typeof fetchNpmStats>>);

    await dashboardCommand();
    const output = allWriteLineOutput();
    expect(output).toContain('Acquisition');
    expect(output).toContain('installs/week');
    delete process.env.SQUADS_NPM_PACKAGE;
  });

  // ── Dashboard stats aggregation ──

  it('calculates overall progress as average of squad progress', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    mockListSquads.mockReturnValue(['a', 'b']);
    mockLoadSquad.mockImplementation((name: string) => {
      if (name === 'a') return makeSquad({
        name: 'a',
        goals: [{ description: 'G1', metrics: [], completed: true }, { description: 'G2', metrics: [], completed: false }],
      });
      return makeSquad({
        name: 'b',
        goals: [{ description: 'G3', metrics: [], completed: true }],
      });
    });

    await dashboardCommand({ json: true });
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.data.stats.overallProgress).toBeGreaterThanOrEqual(0);
    expect(parsed.data.stats.overallProgress).toBeLessThanOrEqual(100);
    consoleSpy.mockRestore();
  });
});
