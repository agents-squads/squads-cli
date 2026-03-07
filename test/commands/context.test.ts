import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  loadSquad: vi.fn(),
  listSquads: vi.fn(),
  resolveExecutionContext: vi.fn(),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn(),
  Events: { CLI_CONTEXT: 'cli_context' },
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
  icons: { success: '✓', active: '●', idle: '○', error: '✗', pending: '○' },
}));

import {
  contextShowCommand,
  contextListCommand,
  contextActivateCommand,
  contextPromptCommand,
} from '../../src/commands/context.js';
import { findSquadsDir, loadSquad, listSquads, resolveExecutionContext } from '../../src/lib/squad-parser.js';

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockLoadSquad = vi.mocked(loadSquad);
const mockListSquads = vi.mocked(listSquads);
const mockResolveExecutionContext = vi.mocked(resolveExecutionContext);

const sampleSquad = {
  name: 'engineering',
  mission: 'Build software',
  repo: 'agents-squads/squads-cli',
  stack: 'TypeScript',
  effort: 'medium',
  goals: [],
  context: {
    mcp: ['chrome-devtools'],
    skills: ['gh', 'gcloud'],
    model: { default: 'sonnet', expensive: 'opus', cheap: 'haiku' },
    budget: { daily: 10, weekly: 50, perExecution: 5 },
    memory: { load: ['shared/learnings'] },
  },
  agents: [],
  pipelines: [],
  routines: [],
};

const sampleExecContext = {
  resolved: {
    mcpConfigPath: '/test/.mcp.json',
    mcpSource: 'squad-local' as const,
    mcpServers: ['chrome-devtools'],
    skills: [
      { name: 'gh', path: '/test/.agents/skills/gh', source: 'project' },
      { name: 'gcloud', path: '/test/.agents/skills/gcloud', source: 'squad-local' },
    ],
    memoryPaths: ['/test/.agents/memory/shared/learnings'],
  },
};

describe('context commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
    mockListSquads.mockReturnValue(['engineering', 'marketing']);
    mockResolveExecutionContext.mockReturnValue(sampleExecContext as ReturnType<typeof resolveExecutionContext>);
  });

  describe('contextShowCommand', () => {
    it('exits when no squads dir found', async () => {
      mockFindSquadsDir.mockReturnValue(null);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      await expect(contextShowCommand('engineering')).rejects.toThrow('process.exit');
      exitSpy.mockRestore();
    });

    it('exits when squad not found', async () => {
      mockLoadSquad.mockReturnValue(null);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      await expect(contextShowCommand('nonexistent')).rejects.toThrow('process.exit');
      exitSpy.mockRestore();
    });

    it('resolves without error for valid squad', async () => {
      await expect(contextShowCommand('engineering')).resolves.toBeUndefined();
    });

    it('outputs JSON when --json flag set', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await contextShowCommand('engineering', { json: true });
      expect(consoleSpy).toHaveBeenCalled();
      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output.name).toBe('engineering');
      consoleSpy.mockRestore();
    });

    it('handles squad with no context defined', async () => {
      mockLoadSquad.mockReturnValue({
        ...sampleSquad,
        context: undefined,
      } as ReturnType<typeof loadSquad>);
      await expect(contextShowCommand('engineering')).resolves.toBeUndefined();
    });
  });

  describe('contextListCommand', () => {
    it('exits when no squads dir found', async () => {
      mockFindSquadsDir.mockReturnValue(null);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      await expect(contextListCommand()).rejects.toThrow('process.exit');
      exitSpy.mockRestore();
    });

    it('resolves without error', async () => {
      await expect(contextListCommand()).resolves.toBeUndefined();
    });

    it('outputs JSON when --json flag set', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await contextListCommand({ json: true });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('contextActivateCommand', () => {
    it('exits when no squads dir found', async () => {
      mockFindSquadsDir.mockReturnValue(null);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      await expect(contextActivateCommand('engineering')).rejects.toThrow('process.exit');
      exitSpy.mockRestore();
    });

    it('exits when squad not found', async () => {
      mockLoadSquad.mockReturnValue(null);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      await expect(contextActivateCommand('nonexistent')).rejects.toThrow('process.exit');
      exitSpy.mockRestore();
    });

    it('resolves without error', async () => {
      await expect(contextActivateCommand('engineering')).resolves.toBeUndefined();
    });

    it('handles dry run', async () => {
      await expect(contextActivateCommand('engineering', { dryRun: true })).resolves.toBeUndefined();
    });

    it('outputs JSON when --json flag set', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await contextActivateCommand('engineering', { json: true });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('contextPromptCommand', () => {
    it('exits when no squads dir found', async () => {
      mockFindSquadsDir.mockReturnValue(null);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(contextPromptCommand('engineering')).rejects.toThrow('process.exit');
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits when squad not found', async () => {
      mockLoadSquad.mockReturnValue(null);
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(contextPromptCommand('engineering')).rejects.toThrow('process.exit');
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('exits when no agent specified', async () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(contextPromptCommand('engineering', {})).rejects.toThrow('process.exit');
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('outputs prompt for valid agent', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await contextPromptCommand('engineering', { agent: 'issue-solver' });
      expect(consoleSpy).toHaveBeenCalled();
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain('issue-solver');
      expect(output).toContain('engineering');
      consoleSpy.mockRestore();
    });

    it('outputs JSON when --json flag set', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await contextPromptCommand('engineering', { agent: 'issue-solver', json: true });
      const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
      expect(output.squad).toBe('engineering');
      expect(output.agent).toBe('issue-solver');
      consoleSpy.mockRestore();
    });
  });
});
