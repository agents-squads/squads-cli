import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() - 1000 })),
  };
});

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  loadSquad: vi.fn(),
  listSquads: vi.fn(),
  listAgents: vi.fn(),
  findSimilarSquads: vi.fn(() => []),
  resolveExecutionContext: vi.fn(() => ({
    resolved: { skills: [], mcpServers: [], mcpSource: null },
  })),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(),
  getSquadState: vi.fn(),
}));

vi.mock('../../src/lib/sessions.js', () => ({
  getLiveSessionSummaryAsync: vi.fn(),
  cleanupStaleSessions: vi.fn(),
  getActiveSessions: vi.fn(),
}));

vi.mock('../../src/lib/git.js', () => ({
  fetchOperationalStatus: vi.fn(),
}));

vi.mock('../../src/lib/executions.js', () => ({
  listExecutions: vi.fn(),
  getExecutionStats: vi.fn(),
  formatDuration: vi.fn((ms: number) => `${ms}ms`),
  formatRelativeTime: vi.fn((d: Date) => 'just now'),
}));

vi.mock('../../src/lib/update.js', () => ({
  checkForUpdate: vi.fn(),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn(),
  Events: { CLI_STATUS: 'cli_status' },
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', purple: '', cyan: '', white: '' },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  box: {
    topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
    vertical: '│', horizontal: '─', teeLeft: '┤', teeRight: '├',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
  icons: { active: '●', idle: '○', error: '✗', pending: '○' },
  privacyHeader: vi.fn(),
}));

import { statusCommand } from '../../src/commands/status.js';
import { findSquadsDir, loadSquad, listSquads, listAgents } from '../../src/lib/squad-parser.js';
import { findMemoryDir, getSquadState } from '../../src/lib/memory.js';
import { getLiveSessionSummaryAsync, cleanupStaleSessions } from '../../src/lib/sessions.js';
import { fetchOperationalStatus } from '../../src/lib/git.js';
import { getExecutionStats, listExecutions } from '../../src/lib/executions.js';
import { checkForUpdate } from '../../src/lib/update.js';

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockLoadSquad = vi.mocked(loadSquad);
const mockListSquads = vi.mocked(listSquads);
const mockListAgents = vi.mocked(listAgents);
const mockFindMemoryDir = vi.mocked(findMemoryDir);
const mockGetSquadState = vi.mocked(getSquadState);
const mockGetLiveSessionSummaryAsync = vi.mocked(getLiveSessionSummaryAsync);
const mockCleanupStaleSessions = vi.mocked(cleanupStaleSessions);
const mockFetchOperationalStatus = vi.mocked(fetchOperationalStatus);
const mockGetExecutionStats = vi.mocked(getExecutionStats);
const mockListExecutions = vi.mocked(listExecutions);
const mockCheckForUpdate = vi.mocked(checkForUpdate);

const mockSessionSummary = {
  totalSessions: 1,
  bySquad: { engineering: 1 },
  squadCount: 1,
};

const sampleSquad = {
  name: 'engineering',
  mission: 'Build great software',
  goals: [{ description: 'Ship v0.7.0', metrics: [], completed: false }],
  context: {},
  agents: [],
  pipelines: [],
  routines: [],
};

describe('statusCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockListSquads.mockReturnValue(['engineering']);
    mockListAgents.mockReturnValue([
      { name: 'issue-solver', role: 'Solves GitHub issues', status: 'active' },
      { name: 'pr-reviewer', role: 'Reviews pull requests', status: 'active' },
    ] as ReturnType<typeof listAgents>);
    mockFindMemoryDir.mockReturnValue('/test/.agents/memory');
    mockGetSquadState.mockReturnValue([]);
    mockGetLiveSessionSummaryAsync.mockResolvedValue(mockSessionSummary);
    mockCleanupStaleSessions.mockReturnValue(0);
    mockFetchOperationalStatus.mockReturnValue({ openPRs: [], milestones: [], recentCommits: [] } as ReturnType<typeof fetchOperationalStatus>);
    mockGetExecutionStats.mockReturnValue({ total: 0, completed: 0, failed: 0, running: 0, totalCostUsd: 0, totalDurationMs: 0 } as ReturnType<typeof getExecutionStats>);
    mockListExecutions.mockReturnValue([]);
    mockCheckForUpdate.mockResolvedValue(null);
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
  });

  it('calls process.exit when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(statusCommand()).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('resolves without error for overall status', async () => {
    await expect(statusCommand()).resolves.toBeUndefined();
  });

  it('resolves without error for a specific squad', async () => {
    await expect(statusCommand('engineering')).resolves.toBeUndefined();
  });

  it('resolves with verbose mode for overall status', async () => {
    await expect(statusCommand(undefined, { verbose: true })).resolves.toBeUndefined();
  });

  it('resolves with verbose mode for specific squad', async () => {
    await expect(statusCommand('engineering', { verbose: true })).resolves.toBeUndefined();
  });

  it('outputs JSON for overall status', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await statusCommand(undefined, { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles no memory dir', async () => {
    mockFindMemoryDir.mockReturnValue(null);
    await expect(statusCommand()).resolves.toBeUndefined();
  });

  it('handles multiple squads', async () => {
    mockListSquads.mockReturnValue(['engineering', 'marketing', 'product']);
    await expect(statusCommand()).resolves.toBeUndefined();
  });

  it('calls process.exit when squad not found (loadSquad returns null)', async () => {
    mockLoadSquad.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(statusCommand('nonexistent')).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('handles active sessions in overall status', async () => {
    mockGetLiveSessionSummaryAsync.mockResolvedValue({
      totalSessions: 3,
      bySquad: { engineering: 2, marketing: 1 },
      squadCount: 2,
    });
    await expect(statusCommand()).resolves.toBeUndefined();
  });

  it('handles execution stats with completed executions', async () => {
    mockGetExecutionStats.mockReturnValue({
      total: 5,
      completed: 4,
      failed: 1,
      running: 0,
      totalCostUsd: 2.50,
      totalDurationMs: 3600000,
    } as ReturnType<typeof getExecutionStats>);
    await expect(statusCommand()).resolves.toBeUndefined();
  });
});
