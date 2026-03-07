import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock chalk with fluent proxy (autonomous.ts uses chalk directly)
vi.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalk = new Proxy(identity, {
    get: () => new Proxy(identity, { get: () => identity }),
  });
  (chalk as Record<string, unknown>).bold = identity;
  (chalk as Record<string, unknown>).green = identity;
  (chalk as Record<string, unknown>).red = identity;
  (chalk as Record<string, unknown>).yellow = identity;
  (chalk as Record<string, unknown>).cyan = identity;
  (chalk as Record<string, unknown>).gray = identity;
  (chalk as Record<string, unknown>).dim = identity;
  (chalk as Record<string, unknown>).white = identity;
  return { default: chalk };
});

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  listSquads: vi.fn(() => []),
  Routine: {},
}));

vi.mock('../../src/lib/cron.js', () => ({
  cronMatches: vi.fn(() => false),
  getNextCronRun: vi.fn(() => null),
  parseCooldown: vi.fn(() => 0),
}));

// Mock fs module — default: no PID file, no pause file, no running agents
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    mkdirSync: vi.fn(),
    appendFileSync: vi.fn(),
    openSync: vi.fn(() => 3),
  };
});

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    pid: 12345,
  })),
  execSync: vi.fn(),
}));

import { registerAutonomousCommand } from '../../src/commands/autonomous.js';
import { writeLine } from '../../src/lib/terminal.js';
import * as fs from 'fs';

const mockWriteLine = vi.mocked(writeLine);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);

describe('registerAutonomousCommand', () => {
  let program: Command;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerAutonomousCommand(program);
  });

  it('registers the autonomous command', () => {
    const cmd = program.commands.find(c => c.name() === 'autonomous');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain('daemon');
  });

  it('registers all expected subcommands', () => {
    const cmd = program.commands.find(c => c.name() === 'autonomous')!;
    const names = cmd.commands.map(c => c.name());
    expect(names).toContain('start');
    expect(names).toContain('stop');
    expect(names).toContain('status');
    expect(names).toContain('pause');
    expect(names).toContain('resume');
  });

  describe('autonomous stop', () => {
    it('shows not-running message when no PID file exists', async () => {
      mockExistsSync.mockReturnValue(false);

      await program.parseAsync(['node', 'squads', 'autonomous', 'stop']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('not running')
      );
    });

    it('shows not-running when PID file has no valid PID', async () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('autonomous.pid')
      );
      mockReadFileSync.mockReturnValue('invalid\n' as unknown as Buffer);

      await program.parseAsync(['node', 'squads', 'autonomous', 'stop']);

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('not running')
      );
    });
  });

  describe('autonomous status', () => {
    it('shows daemon not running when no PID file', async () => {
      mockExistsSync.mockReturnValue(false);

      await program.parseAsync(['node', 'squads', 'autonomous', 'status']);

      const output = mockWriteLine.mock.calls.flat().join(' ');
      expect(output).toContain('not running');
    });

    it('shows daemon not running when PID file is stale', async () => {
      // PID file exists but process.kill throws (stale PID)
      mockExistsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('autonomous.pid')
      );
      mockReadFileSync.mockReturnValue('99999\n' as unknown as Buffer);

      const origKill = process.kill.bind(process);
      const mockKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 0) throw new Error('ESRCH');
        return origKill(pid, signal as NodeJS.Signals);
      });

      await program.parseAsync(['node', 'squads', 'autonomous', 'status']);

      const output = mockWriteLine.mock.calls.flat().join(' ');
      expect(output).toContain('not running');

      mockKill.mockRestore();
    });
  });

  describe('autonomous pause', () => {
    it('writes pause file with reason', async () => {
      await program.parseAsync(['node', 'squads', 'autonomous', 'pause', 'quota exceeded']);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('autonomous.paused'),
        expect.stringContaining('quota exceeded')
      );
    });

    it('uses default reason when none provided', async () => {
      await program.parseAsync(['node', 'squads', 'autonomous', 'pause']);

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('autonomous.paused'),
        expect.stringContaining('Manual pause')
      );
    });
  });

  describe('autonomous resume', () => {
    it('removes pause file', async () => {
      await program.parseAsync(['node', 'squads', 'autonomous', 'resume']);

      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('autonomous.paused')
      );
    });

    it('does not throw if pause file does not exist', async () => {
      mockUnlinkSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      await expect(
        program.parseAsync(['node', 'squads', 'autonomous', 'resume'])
      ).resolves.toBeDefined();
    });
  });
});
