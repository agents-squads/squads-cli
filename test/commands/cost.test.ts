import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  Events: { CLI_COST: 'cli_cost' },
}));

vi.mock('../../src/lib/costs.js', () => ({
  fetchBridgeStats: vi.fn(),
  detectPlan: vi.fn(),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  listSquads: vi.fn(),
  loadSquad: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', purple: '', cyan: '' },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  box: {
    topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
    vertical: '│', horizontal: '─', teeLeft: '┤', teeRight: '├',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
}));

import { costCommand, budgetCheckCommand } from '../../src/commands/cost.js';
import { fetchBridgeStats, detectPlan } from '../../src/lib/costs.js';
import { findSquadsDir, listSquads, loadSquad } from '../../src/lib/squad-parser.js';

const mockFetchBridgeStats = vi.mocked(fetchBridgeStats);
const mockDetectPlan = vi.mocked(detectPlan);
const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockListSquads = vi.mocked(listSquads);
const mockLoadSquad = vi.mocked(loadSquad);

const sampleStats = {
  today: { costUsd: 1.50, generations: 25, inputTokens: 100000, outputTokens: 20000 },
  week: { costUsd: 8.75, generations: 120, inputTokens: 500000, outputTokens: 100000 },
  budget: { used: 1.50, daily: 10, usedPct: 15 },
  bySquad: [
    { squad: 'engineering', costUsd: 0.80, generations: 15 },
    { squad: 'marketing', costUsd: 0.70, generations: 10 },
  ],
  byModel: [
    { model: 'claude-sonnet-4-5', costUsd: 1.20, generations: 20 },
    { model: 'claude-haiku-4-5', costUsd: 0.30, generations: 5 },
  ],
  source: 'bridge' as const,
};

const samplePlan = {
  plan: 'max' as const,
  reason: 'CLAUDE_MAX_SUBSCRIPTION=true',
  costPerToken: null,
};

const squadWithBudget = {
  name: 'engineering',
  goals: [],
  context: { budget: { daily: 5, weekly: 25 } },
  agents: [],
  routines: [],
};

describe('costCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectPlan.mockReturnValue(samplePlan);
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockListSquads.mockReturnValue(['engineering']);
    mockLoadSquad.mockReturnValue(squadWithBudget as ReturnType<typeof loadSquad>);
  });

  it('resolves without error with valid stats', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);

    await expect(costCommand()).resolves.toBeUndefined();
  });

  it('handles bridge unavailable (null stats)', async () => {
    mockFetchBridgeStats.mockResolvedValue(null);

    await expect(costCommand()).resolves.toBeUndefined();
  });

  it('outputs JSON when --json option is set', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await costCommand({ json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output).toHaveProperty('today');
    consoleSpy.mockRestore();
  });

  it('outputs JSON for null stats when --json is set', async () => {
    mockFetchBridgeStats.mockResolvedValue(null);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await costCommand({ json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output).toHaveProperty('error');
    consoleSpy.mockRestore();
  });

  it('shows squad detail when squad option provided', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);

    await expect(costCommand({ squad: 'engineering' })).resolves.toBeUndefined();
  });

  it('handles squad not found in stats', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);

    await expect(costCommand({ squad: 'unknown-squad' })).resolves.toBeUndefined();
  });

  it('handles budget over 100%', async () => {
    mockFetchBridgeStats.mockResolvedValue({
      ...sampleStats,
      budget: { used: 12, daily: 10, usedPct: 120 },
    });

    await expect(costCommand()).resolves.toBeUndefined();
  });

  it('handles stats without week data', async () => {
    const statsWithoutWeek = { ...sampleStats, week: undefined };
    mockFetchBridgeStats.mockResolvedValue(statsWithoutWeek as typeof sampleStats);

    await expect(costCommand()).resolves.toBeUndefined();
  });

  it('handles squad with no budget defined', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);
    mockLoadSquad.mockReturnValue({
      ...squadWithBudget,
      context: {},
    } as ReturnType<typeof loadSquad>);

    await expect(costCommand({ squad: 'engineering' })).resolves.toBeUndefined();
  });

  it('outputs squad JSON when squad + json options set', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await costCommand({ squad: 'engineering', json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });
});

describe('budgetCheckCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectPlan.mockReturnValue(samplePlan);
    mockLoadSquad.mockReturnValue(squadWithBudget as ReturnType<typeof loadSquad>);
  });

  it('resolves without error when bridge is available', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);

    await expect(budgetCheckCommand('engineering')).resolves.toBeUndefined();
  });

  it('handles bridge unavailable', async () => {
    mockFetchBridgeStats.mockResolvedValue(null);

    await expect(budgetCheckCommand('engineering')).resolves.toBeUndefined();
  });

  it('outputs JSON when bridge unavailable and json set', async () => {
    mockFetchBridgeStats.mockResolvedValue(null);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await budgetCheckCommand('engineering', { json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output).toHaveProperty('error');
    consoleSpy.mockRestore();
  });

  it('shows warning when approaching budget limit', async () => {
    mockFetchBridgeStats.mockResolvedValue({
      ...sampleStats,
      bySquad: [{ squad: 'engineering', costUsd: 4.5, generations: 50 }],
    });

    await expect(budgetCheckCommand('engineering')).resolves.toBeUndefined();
  });

  it('shows over-budget status', async () => {
    mockFetchBridgeStats.mockResolvedValue({
      ...sampleStats,
      bySquad: [{ squad: 'engineering', costUsd: 6.0, generations: 80 }],
    });

    await expect(budgetCheckCommand('engineering')).resolves.toBeUndefined();
  });

  it('shows no-budget status when squad has no budget', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);
    mockLoadSquad.mockReturnValue({
      ...squadWithBudget,
      context: {},
    } as ReturnType<typeof loadSquad>);

    await expect(budgetCheckCommand('unknown')).resolves.toBeUndefined();
  });

  it('outputs JSON with budget status', async () => {
    mockFetchBridgeStats.mockResolvedValue(sampleStats);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await budgetCheckCommand('engineering', { json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output).toHaveProperty('squad', 'engineering');
    consoleSpy.mockRestore();
  });
});
