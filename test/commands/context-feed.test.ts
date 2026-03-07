import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  loadSquad: vi.fn(),
  listSquads: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(),
  searchMemory: vi.fn(),
  getSquadState: vi.fn(),
}));

vi.mock('../../src/lib/costs.js', () => ({
  fetchBridgeStats: vi.fn(),
  fetchRateLimits: vi.fn(),
}));

vi.mock('../../src/lib/git.js', () => ({
  getMultiRepoGitStats: vi.fn(),
}));

vi.mock('../../src/lib/sessions.js', () => ({
  getLiveSessionSummaryAsync: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  colors: { dim: '', cyan: '', red: '', yellow: '', green: '', white: '', purple: '' },
  bold: '',
  RESET: '',
  gradient: (s: string) => s,
  box: { topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|', teeRight: '+', teeLeft: '+' },
  padEnd: (s: string, n: number) => s.padEnd(n),
  icons: { success: '+', error: 'x', warning: '!', active: '*', running: '>', progress: '...' },
  writeLine: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    readdirSync: vi.fn(() => []),
  };
});

import { findSquadsDir, loadSquad, listSquads, listAgents } from '../../src/lib/squad-parser.js';
import { findMemoryDir, getSquadState } from '../../src/lib/memory.js';
import { fetchBridgeStats, fetchRateLimits } from '../../src/lib/costs.js';
import { getLiveSessionSummaryAsync } from '../../src/lib/sessions.js';
import { writeLine } from '../../src/lib/terminal.js';
import { contextFeedCommand } from '../../src/commands/context-feed.js';

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockListSquads = vi.mocked(listSquads);
const mockLoadSquad = vi.mocked(loadSquad);
const mockListAgents = vi.mocked(listAgents);
const mockFindMemoryDir = vi.mocked(findMemoryDir);
const mockGetSquadState = vi.mocked(getSquadState);
const mockFetchBridgeStats = vi.mocked(fetchBridgeStats);
const mockFetchRateLimits = vi.mocked(fetchRateLimits);
const mockGetLiveSessions = vi.mocked(getLiveSessionSummaryAsync);

describe('contextFeedCommand', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    // Default mocks
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockFindMemoryDir.mockReturnValue('/fake/.agents/memory');
    mockListSquads.mockReturnValue(['cli', 'website']);
    mockLoadSquad.mockReturnValue({
      name: 'cli',
      mission: 'Build the CLI',
      agents: [],
      goals: [{ description: 'Ship v0.7', completed: false }],
    } as ReturnType<typeof loadSquad>);
    mockListAgents.mockReturnValue(['issue-solver', 'cli-lead']);
    mockGetSquadState.mockReturnValue([]);
    mockFetchBridgeStats.mockResolvedValue(null);
    mockFetchRateLimits.mockResolvedValue({ source: 'none', limits: {} } as Awaited<ReturnType<typeof fetchRateLimits>>);
    mockGetLiveSessions.mockResolvedValue({ totalSessions: 0, squadCount: 0, sessions: [] });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with error when no squads directory found', async () => {
    mockFindSquadsDir.mockReturnValue(null);

    await contextFeedCommand({});

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('shows JSON error when no squads dir and --json flag', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await contextFeedCommand({ json: true });

    const output = consoleSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('No .agents/squads directory found');
    consoleSpy.mockRestore();
  });

  it('renders human briefing by default', async () => {
    await contextFeedCommand({});

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('context-feed');
  });

  it('renders JSON when --agent flag is set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await contextFeedCommand({ agent: true });

    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.timestamp).toBeDefined();
    expect(parsed.squads).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('renders JSON when --json flag is set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await contextFeedCommand({ json: true });

    expect(consoleSpy).toHaveBeenCalled();
    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.goals).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('shows error for invalid squad name', async () => {
    await contextFeedCommand({ squad: 'nonexistent' });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('nonexistent');
    expect(calls).toContain('not found');
  });

  it('filters to single squad when --squad is provided', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await contextFeedCommand({ squad: 'cli', json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.squads).toHaveLength(1);
    expect(parsed.squads[0].name).toBe('cli');
    consoleSpy.mockRestore();
  });

  it('includes active goals in output', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await contextFeedCommand({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.goals.active).toBeGreaterThan(0);
    consoleSpy.mockRestore();
  });

  it('includes cost data when bridge stats available', async () => {
    mockFetchBridgeStats.mockResolvedValue({
      today: { generations: 10, costUsd: 5.0 },
      budget: { daily: 25, used: 5, remaining: 20, usedPct: 20 },
      bySquad: [{ squad: 'cli', costUsd: 3.0, generations: 6 }],
    } as Awaited<ReturnType<typeof fetchBridgeStats>>);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await contextFeedCommand({ json: true });

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(parsed.costs).toBeDefined();
    expect(parsed.costs.today.cost).toBe(5.0);
    consoleSpy.mockRestore();
  });

  it('shows active sessions indicator', async () => {
    mockGetLiveSessions.mockResolvedValue({
      totalSessions: 3,
      squadCount: 2,
      sessions: [],
    });

    await contextFeedCommand({});

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('3 active sessions');
  });
});
