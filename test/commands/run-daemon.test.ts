import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs module — default: no PID file, no pause file
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

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '', red: '', green: '', yellow: '', purple: '',
    cyan: '', white: '', blue: '', magenta: '',
  },
  bold: '',
  RESET: '',
  icons: {
    running: '→', success: '✓', error: '✗', warning: '!',
    progress: '›', empty: '○', paused: '⏸',
  },
  gradient: vi.fn((s: string) => s),
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(() => null),
  listSquads: vi.fn(() => []),
}));

vi.mock('../../src/lib/cron.js', () => ({
  cronMatches: vi.fn(() => false),
  getNextCronRun: vi.fn(() => new Date()),
  parseCooldown: vi.fn(() => 0),
  collectRoutines: vi.fn(() => []),
  loadCooldowns: vi.fn(() => new Map()),
  saveCooldowns: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    pid: 12345,
  })),
  execSync: vi.fn(),
}));

import * as fs from 'fs';
import { writeLine } from '../../src/lib/terminal.js';
import {
  isDaemonRunning,
  isDaemonPaused,
  pauseDaemon,
  resumeDaemon,
  stopDaemon,
  showDaemonStatus,
} from '../../src/lib/run-modes.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockUnlinkSync = vi.mocked(fs.unlinkSync);
const mockWriteLine = vi.mocked(writeLine);

describe('daemon lifecycle (run-modes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  describe('isDaemonRunning', () => {
    it('returns false when no PID file exists', () => {
      const result = isDaemonRunning();
      expect(result.running).toBe(false);
    });

    it('returns false when PID file has invalid content', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('autonomous.pid')
      );
      mockReadFileSync.mockReturnValue('invalid\n' as unknown as Buffer);

      const result = isDaemonRunning();
      expect(result.running).toBe(false);
    });
  });

  describe('isDaemonPaused', () => {
    it('returns false when no pause file exists', () => {
      const result = isDaemonPaused();
      expect(result.paused).toBe(false);
    });

    it('returns true with reason when pause file exists', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) =>
        String(p).endsWith('autonomous.paused')
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ reason: 'quota exceeded', since: '2026-03-17T00:00:00Z' }) as unknown as Buffer
      );

      const result = isDaemonPaused();
      expect(result.paused).toBe(true);
      expect(result.reason).toBe('quota exceeded');
    });
  });

  describe('pauseDaemon', () => {
    it('writes pause file with reason', () => {
      pauseDaemon('quota exceeded');

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('autonomous.paused'),
        expect.stringContaining('quota exceeded')
      );
    });
  });

  describe('resumeDaemon', () => {
    it('removes pause file', () => {
      resumeDaemon();

      expect(mockUnlinkSync).toHaveBeenCalledWith(
        expect.stringContaining('autonomous.paused')
      );
    });

    it('does not throw if pause file does not exist', () => {
      mockUnlinkSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(() => resumeDaemon()).not.toThrow();
    });
  });

  describe('stopDaemon', () => {
    it('returns false when daemon not running', () => {
      const result = stopDaemon();
      expect(result).toBe(false);
    });
  });

  describe('showDaemonStatus', () => {
    it('shows not running when no PID file', async () => {
      await showDaemonStatus();

      const output = mockWriteLine.mock.calls.flat().join(' ');
      expect(output).toContain('not running');
    });
  });
});
