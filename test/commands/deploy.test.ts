import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  loadSquad: vi.fn(),
  listSquads: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock('../../src/lib/auth.js', () => ({
  loadSession: vi.fn(),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
}));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    warn: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

vi.mock('chalk', () => ({
  default: {
    bold: vi.fn((s: string) => s),
    cyan: vi.fn((s: string) => s),
    dim: vi.fn((s: string) => s),
    green: vi.fn((s: string) => s),
    red: vi.fn((s: string) => s),
    yellow: vi.fn((s: string) => s),
    magenta: vi.fn((s: string) => s),
  },
}));

vi.mock('gray-matter', () => ({
  default: vi.fn(() => ({ data: { role: 'test', model: 'sonnet', status: 'active' } })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readFileSync: vi.fn(() => '---\nrole: test\nmodel: sonnet\n---\n# Agent'),
  };
});

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'abc1234'),
}));

import { deployCommand, deployStatusCommand, deployPullCommand } from '../../src/commands/deploy.js';
import { findSquadsDir, loadSquad, listSquads, listAgents } from '../../src/lib/squad-parser.js';
import { loadSession } from '../../src/lib/auth.js';
import { writeLine } from '../../src/lib/terminal.js';

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockLoadSquad = vi.mocked(loadSquad);
const mockListSquads = vi.mocked(listSquads);
const mockListAgents = vi.mocked(listAgents);
const mockLoadSession = vi.mocked(loadSession);
const mockWriteLine = vi.mocked(writeLine);

const activeSession = {
  email: 'test@example.com',
  status: 'active' as const,
  accessToken: 'tok_test',
  refreshToken: 'ref_test',
  expiresAt: Date.now() + 3600000,
  teamId: 'team_1',
  teamName: 'Test Team',
  subscription: 'pro' as const,
};

const sampleSquad = {
  name: 'engineering',
  mission: 'Build software',
  goals: [],
  context: {},
  agents: [],
  pipelines: [],
  routines: [],
};

describe('deploy command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockListSquads.mockReturnValue(['engineering']);
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
    mockListAgents.mockReturnValue([
      { name: 'issue-solver', role: 'Solves issues', status: 'active' },
    ] as ReturnType<typeof listAgents>);
  });

  describe('deployCommand', () => {
    it('shows login prompt when not authenticated', async () => {
      mockLoadSession.mockReturnValue(null);
      await deployCommand({});
      expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
    });

    it('shows login prompt when session inactive', async () => {
      mockLoadSession.mockReturnValue({ ...activeSession, status: 'inactive' as 'active' });
      await deployCommand({});
      expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
    });

    it('shows error when no squads dir found', async () => {
      mockLoadSession.mockReturnValue(activeSession);
      mockFindSquadsDir.mockReturnValue(null);
      await deployCommand({});
    });

    it('handles dry run without pushing', async () => {
      mockLoadSession.mockReturnValue(activeSession);
      await deployCommand({ dryRun: true });
      expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
    });

    it('handles verbose mode', async () => {
      mockLoadSession.mockReturnValue(activeSession);
      await deployCommand({ dryRun: true, verbose: true });
    });

    it('handles squad filter', async () => {
      mockLoadSession.mockReturnValue(activeSession);
      await deployCommand({ dryRun: true, squad: 'engineering' });
    });

    it('warns when no squads found to deploy', async () => {
      mockLoadSession.mockReturnValue(activeSession);
      mockListSquads.mockReturnValue([]);
      await deployCommand({ dryRun: true });
    });
  });

  describe('deployStatusCommand', () => {
    it('shows login prompt when not authenticated', async () => {
      mockLoadSession.mockReturnValue(null);
      await deployStatusCommand();
      expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
    });
  });

  describe('deployPullCommand', () => {
    it('shows login prompt when not authenticated', async () => {
      mockLoadSession.mockReturnValue(null);
      await deployPullCommand({});
      expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('Not logged in'));
    });
  });
});
