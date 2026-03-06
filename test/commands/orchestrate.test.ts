import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/lib/orchestration/lead-orchestrator.js', () => ({
  initEventsDir: vi.fn(),
  buildLeadPrompt: vi.fn(),
  watchForEvents: vi.fn(),
}));

vi.mock('../../src/lib/mcp-config.js', () => ({
  resolveMcpConfigPath: vi.fn(),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  loadSquad: vi.fn(),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(),
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

import { existsSync, readFileSync, readdirSync } from 'fs';
import { spawn } from 'child_process';
import { initEventsDir, buildLeadPrompt } from '../../src/lib/orchestration/lead-orchestrator.js';
import { resolveMcpConfigPath } from '../../src/lib/mcp-config.js';
import { findSquadsDir, loadSquad } from '../../src/lib/squad-parser.js';
import { findMemoryDir } from '../../src/lib/memory.js';
import { writeLine } from '../../src/lib/terminal.js';
import { registerOrchestrateCommand } from '../../src/commands/orchestrate.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockSpawn = vi.mocked(spawn);
const mockInitEventsDir = vi.mocked(initEventsDir);
const mockBuildLeadPrompt = vi.mocked(buildLeadPrompt);
const mockResolveMcpConfigPath = vi.mocked(resolveMcpConfigPath);
const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockLoadSquad = vi.mocked(loadSquad);
const mockFindMemoryDir = vi.mocked(findMemoryDir);
const mockWriteLine = vi.mocked(writeLine);

function makeSpawnMock() {
  return { on: vi.fn(), unref: vi.fn() };
}

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerOrchestrateCommand(program);
  return program;
}

const mockSquad = {
  name: 'cli',
  context: { mcp: [] },
  agents: [],
  pipelines: [],
};

describe('registerOrchestrateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
    mockFindMemoryDir.mockReturnValue('/project/.agents/memory');
    mockLoadSquad.mockReturnValue(mockSquad as never);
    mockInitEventsDir.mockReturnValue('/project/.agents/events');
    mockBuildLeadPrompt.mockReturnValue('You are the lead agent...');
    mockResolveMcpConfigPath.mockReturnValue('/tmp/mcp.json');
    mockReadFileSync.mockReturnValue('## Mission\nBuild CLI\n## Goals\n- Ship features');
    // Squad dir exists, no state file
    mockExistsSync.mockImplementation((p: unknown) => {
      const path = String(p);
      return path.endsWith('/cli') || path.endsWith('SQUAD.md');
    });
    // Squad directory has lead + workers
    mockReaddirSync.mockReturnValue(['cli-lead.md', 'issue-solver.md', 'reviewer.md'] as never);
    mockSpawn.mockReturnValue(makeSpawnMock() as never);
  });

  it('registers the orchestrate command', () => {
    const program = buildProgram();
    const cmd = program.commands.find(c => c.name() === 'orchestrate');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain('orchestrat');
  });

  it('accepts --foreground flag', () => {
    const program = buildProgram();
    const cmd = program.commands.find(c => c.name() === 'orchestrate');
    const opts = cmd?.opts();
    expect(cmd).toBeDefined();
  });

  it('exits when squad directory does not exist', async () => {
    mockExistsSync.mockReturnValue(false);
    // readdirSync for available squads list
    mockReaddirSync.mockReturnValue(['engineering', 'marketing'] as never);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1'); });

    const program = buildProgram();
    await expect(
      program.parseAsync(['orchestrate', 'nonexistent'], { from: 'user' })
    ).rejects.toThrow('exit:1');

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));

    mockExit.mockRestore();
  });

  it('exits when no lead agent found in squad', async () => {
    // Squad dir exists but has no lead file
    mockExistsSync.mockImplementation((p: unknown) => String(p).endsWith('/cli'));
    mockReaddirSync.mockReturnValue(['worker-a.md', 'worker-b.md'] as never);

    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit:1'); });

    const program = buildProgram();
    await expect(
      program.parseAsync(['orchestrate', 'cli'], { from: 'user' })
    ).rejects.toThrow('exit:1');

    expect(mockExit).toHaveBeenCalledWith(1);
    expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('lead'));

    mockExit.mockRestore();
  });

  it('spawns tmux in background mode (default)', async () => {
    const program = buildProgram();
    await program.parseAsync(['orchestrate', 'cli'], { from: 'user' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'tmux',
      expect.arrayContaining(['new-session', '-d']),
      expect.objectContaining({ detached: true })
    );
    expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('background'));
  });

  it('includes squad name in tmux session name', async () => {
    const program = buildProgram();
    await program.parseAsync(['orchestrate', 'cli'], { from: 'user' });

    const [, tmuxArgs] = mockSpawn.mock.calls[0];
    const sessionIdx = tmuxArgs.indexOf('-s');
    expect(tmuxArgs[sessionIdx + 1]).toContain('cli');
  });

  it('calls initEventsDir with process.cwd()', async () => {
    const program = buildProgram();
    await program.parseAsync(['orchestrate', 'cli'], { from: 'user' });

    expect(mockInitEventsDir).toHaveBeenCalledWith(process.cwd());
  });

  it('calls buildLeadPrompt with squad and agents', async () => {
    const program = buildProgram();
    await program.parseAsync(['orchestrate', 'cli'], { from: 'user' });

    expect(mockBuildLeadPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        squad: 'cli',
        lead: 'cli-lead',
        agents: expect.arrayContaining(['issue-solver', 'reviewer']),
      })
    );
  });

  it('uses ~/.claude.json when squad has no mcp servers', async () => {
    const program = buildProgram();
    await program.parseAsync(['orchestrate', 'cli'], { from: 'user' });

    // No MCP servers → resolveMcpConfigPath not called, uses home .claude.json
    expect(mockResolveMcpConfigPath).not.toHaveBeenCalled();
  });

  it('resolves mcp config when squad has mcp servers', async () => {
    mockLoadSquad.mockReturnValue({ ...mockSquad, context: { mcp: ['filesystem'] } } as never);

    const program = buildProgram();
    await program.parseAsync(['orchestrate', 'cli'], { from: 'user' });

    expect(mockResolveMcpConfigPath).toHaveBeenCalledWith('cli', ['filesystem']);
  });

  it('spawns claude directly in foreground mode', async () => {
    mockSpawn.mockReturnValue({ on: vi.fn() } as never);

    const program = buildProgram();
    await program.parseAsync(['orchestrate', 'cli', '--foreground'], { from: 'user' });

    expect(mockSpawn).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['--permission-mode', 'bypassPermissions']),
      expect.objectContaining({ stdio: 'inherit' })
    );
  });

  it('passes squad env vars to spawned process', async () => {
    const program = buildProgram();
    await program.parseAsync(['orchestrate', 'cli'], { from: 'user' });

    const [, , spawnOpts] = mockSpawn.mock.calls[0];
    expect(spawnOpts.env).toMatchObject({
      SQUADS_SQUAD: 'cli',
      SQUADS_AGENT: 'cli-lead',
      SQUADS_ROLE: 'lead',
    });
  });
});
