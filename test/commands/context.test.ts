import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
  icons: { success: '✓', error: '✗', warning: '!', progress: '›' },
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

const mockExecContext = {
  resolved: {
    mcpServers: [],
    mcpSource: null as string | null,
    mcpConfigPath: '/test/.mcp.json',
    skills: [] as Array<{ name: string; source: string; path: string }>,
    memoryPaths: [],
  },
};

const mockSquad = {
  name: 'engineering',
  mission: 'Build great software',
  repo: 'agents-squads/squads-cli',
  stack: 'TypeScript, Node.js',
  effort: 'high' as const,
  context: {
    mcp: ['chrome-devtools'],
    skills: ['gh'],
    model: { default: 'claude-sonnet-4', expensive: 'claude-opus-4' },
    budget: { daily: 10 },
    memory: { load: ['state.md'] },
  },
  goals: [],
  agents: [],
  pipelines: [],
  routines: [],
};

describe('contextShowCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockLoadSquad.mockReturnValue(mockSquad as ReturnType<typeof loadSquad>);
    mockResolveExecutionContext.mockReturnValue(mockExecContext as ReturnType<typeof resolveExecutionContext>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(contextShowCommand('engineering')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('exits when squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(contextShowCommand('unknown')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('resolves for a squad with full context', async () => {
    await expect(contextShowCommand('engineering')).resolves.toBeUndefined();
  });

  it('resolves for a squad with no context defined', async () => {
    mockLoadSquad.mockReturnValue({ ...mockSquad, context: undefined } as ReturnType<typeof loadSquad>);
    await expect(contextShowCommand('engineering')).resolves.toBeUndefined();
  });

  it('outputs JSON when json option is set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await contextShowCommand('engineering', { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.name).toBe('engineering');
    consoleSpy.mockRestore();
  });

  it('shows resolved MCP servers when present', async () => {
    mockResolveExecutionContext.mockReturnValue({
      ...mockExecContext,
      resolved: {
        ...mockExecContext.resolved,
        mcpServers: ['chrome-devtools', 'filesystem'],
        mcpSource: 'squad-local',
      },
    } as ReturnType<typeof resolveExecutionContext>);
    const { writeLine } = await import('../../src/lib/terminal.js');
    await contextShowCommand('engineering');
    expect(writeLine).toHaveBeenCalled();
  });

  it('shows resolved skills when present', async () => {
    mockResolveExecutionContext.mockReturnValue({
      ...mockExecContext,
      resolved: {
        ...mockExecContext.resolved,
        skills: [
          { name: 'gh', source: 'squad-local', path: '/path/to/gh.md' },
          { name: 'gcloud', source: 'project', path: '/path/to/gcloud.md' },
        ],
      },
    } as ReturnType<typeof resolveExecutionContext>);
    await expect(contextShowCommand('engineering')).resolves.toBeUndefined();
  });
});

describe('contextListCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockListSquads.mockReturnValue(['engineering', 'marketing']);
    mockLoadSquad.mockReturnValue(mockSquad as ReturnType<typeof loadSquad>);
    mockResolveExecutionContext.mockReturnValue(mockExecContext as ReturnType<typeof resolveExecutionContext>);
  });

  it('exits when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(contextListCommand()).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('lists all squad contexts', async () => {
    await expect(contextListCommand()).resolves.toBeUndefined();
  });

  it('outputs JSON when json option set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await contextListCommand({ json: true });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('handles squad with no context in list', async () => {
    mockLoadSquad.mockReturnValue({ ...mockSquad, context: undefined } as ReturnType<typeof loadSquad>);
    await expect(contextListCommand()).resolves.toBeUndefined();
  });
});

describe('contextActivateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockLoadSquad.mockReturnValue(mockSquad as ReturnType<typeof loadSquad>);
    mockResolveExecutionContext.mockReturnValue(mockExecContext as ReturnType<typeof resolveExecutionContext>);
  });

  it('exits when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(contextActivateCommand('engineering')).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('exits when squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(contextActivateCommand('unknown')).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('resolves in dry-run mode', async () => {
    await expect(contextActivateCommand('engineering', { dryRun: true })).resolves.toBeUndefined();
  });

  it('outputs JSON in activate json mode', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await contextActivateCommand('engineering', { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('resolves in normal activate mode', async () => {
    await expect(contextActivateCommand('engineering')).resolves.toBeUndefined();
  });

  it('dry-run shows skills when resolved', async () => {
    mockResolveExecutionContext.mockReturnValue({
      ...mockExecContext,
      resolved: {
        ...mockExecContext.resolved,
        skills: [{ name: 'gh', source: 'squad-local', path: '/path/to/gh.md' }],
        memoryPaths: ['/path/to/state.md'],
        mcpSource: 'generated',
        mcpServers: ['filesystem'],
      },
    } as ReturnType<typeof resolveExecutionContext>);
    await expect(contextActivateCommand('engineering', { dryRun: true })).resolves.toBeUndefined();
  });
});

describe('contextPromptCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockLoadSquad.mockReturnValue(mockSquad as ReturnType<typeof loadSquad>);
  });

  it('exits when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(contextPromptCommand('engineering')).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('exits when squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(contextPromptCommand('engineering')).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('exits when no agent specified', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(contextPromptCommand('engineering', {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('outputs prompt for agent', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await contextPromptCommand('engineering', { agent: 'issue-solver' });
    expect(consoleSpy).toHaveBeenCalled();
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain('issue-solver');
    expect(output).toContain('engineering');
    consoleSpy.mockRestore();
  });

  it('outputs JSON when json option set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await contextPromptCommand('engineering', { agent: 'issue-solver', json: true });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.squad).toBe('engineering');
    expect(output.agent).toBe('issue-solver');
    expect(output.prompt).toContain('issue-solver');
    consoleSpy.mockRestore();
  });
});
