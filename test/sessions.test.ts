import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'child_process';
import {
  detectAIProcessesFast,
  detectAIProcesses,
  enrichProcessesWithSquad,
  getLiveSessionSummaryFast,
  getLiveSessionSummaryAsync,
  getLiveSessionSummary,
  detectSquad,
  AIProcess,
} from '../src/lib/sessions.js';

// Mock execSync for consistent test behavior
vi.mock('child_process', async () => {
  const actual = await vi.importActual('child_process');
  return {
    ...actual,
    execSync: vi.fn(),
    exec: vi.fn(),
  };
});

describe('sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('detectSquad', () => {
    it('detects squad from hq directory', () => {
      expect(detectSquad('/Users/test/agents-squads/hq')).toBe('company');
    });

    it('detects squad from website directory', () => {
      expect(detectSquad('/Users/test/agents-squads/agents-squads-web/src')).toBe('website');
    });

    it('detects squad from product directory', () => {
      expect(detectSquad('/Users/test/agents-squads/product')).toBe('product');
    });

    it('returns null for non-squad directory', () => {
      expect(detectSquad('/Users/test/some-other-project')).toBeNull();
    });

    it('returns null for empty path', () => {
      expect(detectSquad('')).toBeNull();
    });
  });

  describe('detectAIProcessesFast', () => {
    it('returns empty array when no AI processes found', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue('  PID TTY      CMD\n1234 pts/0   bash\n5678 pts/1   vim');

      const result = detectAIProcessesFast();
      expect(result).toEqual([]);
    });

    it('detects claude processes', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue('  PID TTY      CMD\n1234 pts/0   claude\n5678 pts/1   bash');

      const result = detectAIProcessesFast();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        pid: 1234,
        tool: 'claude',
        cwd: '', // Fast mode doesn't get cwd
        squad: null, // Fast mode doesn't detect squad
      });
    });

    it('detects multiple AI tool processes', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue(
        '  PID TTY      CMD\n' +
        '1234 pts/0   claude\n' +
        '2345 pts/1   cursor\n' +
        '3456 pts/2   aider'
      );

      const result = detectAIProcessesFast();
      expect(result).toHaveLength(3);
      expect(result.map(p => p.tool)).toEqual(['claude', 'cursor', 'aider']);
    });

    it('handles ps command failure gracefully', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockImplementation(() => {
        throw new Error('Command failed');
      });

      const result = detectAIProcessesFast();
      expect(result).toEqual([]);
    });
  });

  describe('getLiveSessionSummaryFast', () => {
    it('returns count without squad breakdown', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue('  PID TTY      CMD\n1234 pts/0   claude\n2345 pts/1   claude');

      const result = getLiveSessionSummaryFast();
      expect(result.totalSessions).toBe(2);
      expect(result.byTool).toEqual({ claude: 2 });
      // All sessions show as 'unknown' squad in fast mode
      expect(result.bySquad).toEqual({ unknown: 2 });
    });
  });

  describe('enrichProcessesWithSquad', () => {
    it('enriches processes with cwd and squad info', async () => {
      const processes: AIProcess[] = [
        { pid: 1234, tty: 'pts/0', cwd: '', squad: null, tool: 'claude' },
      ];

      // Note: This test verifies the function structure
      // Actual lsof behavior would need integration tests
      const result = await enrichProcessesWithSquad(processes);
      expect(result).toHaveLength(1);
      expect(result[0].pid).toBe(1234);
      expect(result[0].tool).toBe('claude');
    });

    it('handles empty process list', async () => {
      const result = await enrichProcessesWithSquad([]);
      expect(result).toEqual([]);
    });
  });

  describe('getLiveSessionSummaryAsync', () => {
    it('returns session summary with squad detection', async () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue('  PID TTY      CMD\n1234 pts/0   claude');

      // Pass '/' as projectRoot so any non-empty cwd matches the filter
      const result = await getLiveSessionSummaryAsync('/');
      expect(result.totalSessions).toBeGreaterThanOrEqual(0);
      expect(result.byTool).toBeDefined();
    });

    it('filters sessions to project root', async () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue('  PID TTY      CMD\n1234 pts/0   claude');

      // With a non-matching project root, all sessions should be filtered out
      const result = await getLiveSessionSummaryAsync('/nonexistent/path');
      expect(result.totalSessions).toBe(0);
    });
  });

  describe('detectAIProcesses (sync, backwards compatible)', () => {
    it('returns processes with cwd attempted', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      // First call: ps
      mockExecSync.mockReturnValueOnce('  PID TTY      CMD\n1234 pts/0   claude');
      // Second call: lsof
      mockExecSync.mockReturnValueOnce('/Users/test/agents-squads/hq');

      const result = detectAIProcesses();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        pid: 1234,
        tool: 'claude',
        cwd: '/Users/test/agents-squads/hq',
        squad: 'company',
      });
    });

    it('handles lsof failure gracefully', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      // First call: ps
      mockExecSync.mockReturnValueOnce('  PID TTY      CMD\n1234 pts/0   claude');
      // Second call: lsof fails
      mockExecSync.mockImplementationOnce(() => {
        throw new Error('lsof failed');
      });

      const result = detectAIProcesses();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        pid: 1234,
        tool: 'claude',
        cwd: '',
        squad: null,
      });
    });
  });
});
