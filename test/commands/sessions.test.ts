import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/sessions.js', () => ({
  getActiveSessions: vi.fn(),
  getSessionSummary: vi.fn(),
  cleanupStaleSessions: vi.fn(),
  getSessionHistoryStats: vi.fn(),
  getRecentSessions: vi.fn(),
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
  icons: { active: '●' },
}));

import {
  sessionsCommand,
  sessionsSummaryCommand,
  sessionsHistoryCommand,
} from '../../src/commands/sessions.js';
import {
  getActiveSessions,
  getSessionSummary,
  cleanupStaleSessions,
  getSessionHistoryStats,
  getRecentSessions,
} from '../../src/lib/sessions.js';

const mockGetActiveSessions = vi.mocked(getActiveSessions);
const mockGetSessionSummary = vi.mocked(getSessionSummary);
const mockCleanupStaleSessions = vi.mocked(cleanupStaleSessions);
const mockGetSessionHistoryStats = vi.mocked(getSessionHistoryStats);
const mockGetRecentSessions = vi.mocked(getRecentSessions);

const mockSummary = {
  totalSessions: 2,
  bySquad: { engineering: 2 },
  squadCount: 1,
};

const mockSessions = [
  {
    sessionId: 'session-abc-123',
    squad: 'engineering',
    startedAt: new Date(Date.now() - 60000).toISOString(),
    lastHeartbeat: new Date(Date.now() - 30000).toISOString(),
    cwd: '/Users/test/project',
    pid: 12345,
  },
  {
    sessionId: 'session-def-456',
    squad: 'marketing',
    startedAt: new Date(Date.now() - 120000).toISOString(),
    lastHeartbeat: new Date(Date.now() - 90000).toISOString(),
    cwd: '/Users/test/project2',
    pid: 67890,
  },
];

describe('sessionsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveSessions.mockReturnValue([]);
    mockGetSessionSummary.mockReturnValue(mockSummary);
    mockCleanupStaleSessions.mockReturnValue(0);
  });

  it('resolves with no active sessions', async () => {
    await expect(sessionsCommand()).resolves.toBeUndefined();
  });

  it('outputs JSON when json option is set and no sessions', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sessionsCommand({ json: true });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"sessions"'));
    consoleSpy.mockRestore();
  });

  it('outputs JSON when json option is set with sessions', async () => {
    mockGetActiveSessions.mockReturnValue(mockSessions as ReturnType<typeof getActiveSessions>);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sessionsCommand({ json: true });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"sessions"'));
    consoleSpy.mockRestore();
  });

  it('renders table with active sessions', async () => {
    mockGetActiveSessions.mockReturnValue(mockSessions as ReturnType<typeof getActiveSessions>);
    mockGetSessionSummary.mockReturnValue({
      totalSessions: 2,
      bySquad: { engineering: 1, marketing: 1 },
      squadCount: 2,
    });
    await expect(sessionsCommand()).resolves.toBeUndefined();
  });

  it('calls cleanupStaleSessions before showing sessions', async () => {
    await sessionsCommand();
    expect(mockCleanupStaleSessions).toHaveBeenCalled();
  });

  it('renders verbose session details', async () => {
    mockGetActiveSessions.mockReturnValue(mockSessions as ReturnType<typeof getActiveSessions>);
    await expect(sessionsCommand({ verbose: true })).resolves.toBeUndefined();
  });

  it('handles single session and squad (singular text)', async () => {
    mockGetActiveSessions.mockReturnValue([mockSessions[0]] as ReturnType<typeof getActiveSessions>);
    mockGetSessionSummary.mockReturnValue({
      totalSessions: 1,
      bySquad: { engineering: 1 },
      squadCount: 1,
    });
    await expect(sessionsCommand()).resolves.toBeUndefined();
  });

  it('handles sessions with null squad (grouped as unknown)', async () => {
    mockGetActiveSessions.mockReturnValue([
      { ...mockSessions[0], squad: null },
    ] as ReturnType<typeof getActiveSessions>);
    await expect(sessionsCommand()).resolves.toBeUndefined();
  });
});

describe('sessionsSummaryCommand', () => {
  const minimalData = {
    squads: [{ name: 'Engineering', actions: 'Built features', outputs: 'PR #42 merged' }],
  };

  it('outputs JSON when json option is set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sessionsSummaryCommand(minimalData, { json: true });
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(minimalData, null, 2));
    consoleSpy.mockRestore();
  });

  it('renders squads table', async () => {
    await expect(sessionsSummaryCommand(minimalData)).resolves.toBeUndefined();
  });

  it('renders with no squads', async () => {
    await expect(sessionsSummaryCommand({ squads: [] })).resolves.toBeUndefined();
  });

  it('renders decisions table when provided', async () => {
    const data = {
      ...minimalData,
      decisions: [{ question: 'API style?', answer: 'REST' }],
    };
    await expect(sessionsSummaryCommand(data)).resolves.toBeUndefined();
  });

  it('renders customer section when provided', async () => {
    const data = {
      ...minimalData,
      customer: {
        vertical: 'Mining',
        persona: 'CTO',
        painPoints: ['slow onboarding', 'high cost'],
      },
    };
    await expect(sessionsSummaryCommand(data)).resolves.toBeUndefined();
  });

  it('renders next actions when provided', async () => {
    const data = {
      ...minimalData,
      nextActions: [{ squad: 'engineering', action: 'Ship feature X' }],
    };
    await expect(sessionsSummaryCommand(data)).resolves.toBeUndefined();
  });

  it('renders targets when provided', async () => {
    const data = {
      ...minimalData,
      targets: [{ metric: 'Revenue', value: '$10K' }],
    };
    await expect(sessionsSummaryCommand(data)).resolves.toBeUndefined();
  });

  it('renders filesUpdated when provided', async () => {
    const data = {
      ...minimalData,
      filesUpdated: ['cli/state.md', 'engineering/issue-solver/state.md'],
    };
    await expect(sessionsSummaryCommand(data)).resolves.toBeUndefined();
  });

  it('renders model and duration in footer', async () => {
    const data = { ...minimalData, model: 'Claude Opus 4.6', duration: '45m' };
    await expect(sessionsSummaryCommand(data)).resolves.toBeUndefined();
  });

  it('truncates long squad actions and outputs', async () => {
    const data = {
      squads: [{
        name: 'Engineering',
        actions: 'A'.repeat(100),
        outputs: 'B'.repeat(100),
      }],
    };
    await expect(sessionsSummaryCommand(data)).resolves.toBeUndefined();
  });
});

describe('sessionsHistoryCommand', () => {
  const mockStats = {
    totalSessions: 10,
    totalDurationMs: 3600000,
    avgDurationMs: 360000,
    peakConcurrent: 3,
    bySquad: {
      engineering: { count: 6, durationMs: 2160000 },
      marketing: { count: 4, durationMs: 1440000 },
    },
    byDate: {
      '2026-03-06': 3,
      '2026-03-05': 4,
      '2026-03-04': 3,
    },
  };

  const mockRecentSessions = [
    {
      type: 'start' as const,
      sessionId: 'abc-123',
      squad: 'engineering',
      ts: new Date(Date.now() - 3600000).toISOString(),
      cwd: '/project',
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSessionHistoryStats.mockResolvedValue(mockStats);
    mockGetRecentSessions.mockResolvedValue(mockRecentSessions);
  });

  it('resolves without error with default options', async () => {
    await expect(sessionsHistoryCommand()).resolves.toBeUndefined();
  });

  it('outputs JSON when json option is set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await sessionsHistoryCommand({ json: true });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"stats"'));
    consoleSpy.mockRestore();
  });

  it('renders empty state when no sessions', async () => {
    mockGetSessionHistoryStats.mockResolvedValue({
      ...mockStats,
      totalSessions: 0,
    });
    await expect(sessionsHistoryCommand()).resolves.toBeUndefined();
  });

  it('accepts custom days option', async () => {
    await expect(sessionsHistoryCommand({ days: 30 })).resolves.toBeUndefined();
    expect(mockGetSessionHistoryStats).toHaveBeenCalledWith(
      expect.objectContaining({ since: expect.any(Date) })
    );
  });

  it('filters by squad when squad option provided', async () => {
    await sessionsHistoryCommand({ squad: 'engineering' });
    expect(mockGetSessionHistoryStats).toHaveBeenCalledWith(
      expect.objectContaining({ squad: 'engineering' })
    );
  });

  it('renders by-squad table', async () => {
    await expect(sessionsHistoryCommand()).resolves.toBeUndefined();
  });

  it('handles stats with single date (no daily chart)', async () => {
    mockGetSessionHistoryStats.mockResolvedValue({
      ...mockStats,
      byDate: { '2026-03-06': 3 },
    });
    await expect(sessionsHistoryCommand()).resolves.toBeUndefined();
  });

  it('handles no recent sessions', async () => {
    mockGetRecentSessions.mockResolvedValue([]);
    await expect(sessionsHistoryCommand()).resolves.toBeUndefined();
  });
});
