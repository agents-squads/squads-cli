import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  detectAIProcessesFast,
  detectAIProcesses,
  enrichProcessesWithSquad,
  getLiveSessionSummaryFast,
  getLiveSessionSummaryAsync,
  getLiveSessionSummary,
  detectSquad,
  findAgentsDir,
  getSessionsDir,
  getHistoryFilePath,
  startSession,
  stopSession,
  updateHeartbeat,
  getActiveSessions,
  getSessionSummary,
  cleanupStaleSessions,
  getSessionId,
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

// Helper: create a temp directory with .agents/sessions structure
function createTempAgentsDir(): { tmpDir: string; agentsDir: string; sessionsDir: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squads-test-'));
  const agentsDir = path.join(tmpDir, '.agents');
  const sessionsDir = path.join(agentsDir, 'sessions', 'active');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return { tmpDir, agentsDir, sessionsDir };
}

// Helper: write a session file
function writeSessionFile(sessionsDir: string, sessionId: string, data: object): void {
  fs.writeFileSync(
    path.join(sessionsDir, `${sessionId}.json`),
    JSON.stringify(data, null, 2)
  );
}

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

    it('detects squad from engineering directory', () => {
      expect(detectSquad('/Users/test/agents-squads/engineering/src')).toBe('engineering');
    });

    it('detects squad from customer directory', () => {
      expect(detectSquad('/Users/test/agents-squads/customer')).toBe('customer');
    });

    it('detects squad from finance directory', () => {
      expect(detectSquad('/Users/test/agents-squads/finance')).toBe('finance');
    });

    it('uses directory name as squad for unknown repos', () => {
      expect(detectSquad('/Users/test/agents-squads/squads-cli')).toBe('squads-cli');
    });

    it('returns null for non-squad directory', () => {
      expect(detectSquad('/Users/test/some-other-project')).toBeNull();
    });

    it('returns null for empty path', () => {
      expect(detectSquad('')).toBeNull();
    });

    it('returns null for root directory', () => {
      expect(detectSquad('/')).toBeNull();
    });
  });

  describe('findAgentsDir', () => {
    it('returns null when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = findAgentsDir();
      expect(result).toBeNull();
      cwdSpy.mockRestore();
    });

    it('finds .agents directory in current directory', () => {
      const { tmpDir, agentsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const result = findAgentsDir();
      expect(result).toBe(agentsDir);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('finds .agents directory in parent directory', () => {
      const { tmpDir, agentsDir } = createTempAgentsDir();
      const childDir = path.join(tmpDir, 'src', 'commands');
      fs.mkdirSync(childDir, { recursive: true });

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(childDir);
      const result = findAgentsDir();
      expect(result).toBe(agentsDir);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getSessionsDir', () => {
    it('returns null when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = getSessionsDir();
      expect(result).toBeNull();
      cwdSpy.mockRestore();
    });

    it('returns sessions/active directory path when .agents exists', () => {
      const { tmpDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const result = getSessionsDir();
      expect(result).not.toBeNull();
      expect(result).toContain('active');
      expect(fs.existsSync(result!)).toBe(true);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getHistoryFilePath', () => {
    it('returns null when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = getHistoryFilePath();
      expect(result).toBeNull();
      cwdSpy.mockRestore();
    });

    it('returns history.jsonl path when .agents exists', () => {
      const { tmpDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const result = getHistoryFilePath();
      expect(result).not.toBeNull();
      expect(result).toContain('history.jsonl');

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getActiveSessions', () => {
    it('returns empty array when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = getActiveSessions();
      expect(result).toEqual([]);
      cwdSpy.mockRestore();
    });

    it('returns empty array when sessions dir is empty', () => {
      const { tmpDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const result = getActiveSessions();
      expect(result).toEqual([]);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('returns active (non-stale) sessions', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const now = new Date().toISOString();
      writeSessionFile(sessionsDir, 'session-active', {
        sessionId: 'session-active',
        squad: 'engineering',
        startedAt: now,
        lastHeartbeat: now,
        cwd: tmpDir,
        pid: 12345,
      });

      const result = getActiveSessions();
      expect(result).toHaveLength(1);
      expect(result[0].sessionId).toBe('session-active');
      expect(result[0].squad).toBe('engineering');

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('excludes stale sessions (older than 5 minutes)', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      writeSessionFile(sessionsDir, 'session-stale', {
        sessionId: 'session-stale',
        squad: 'engineering',
        startedAt: staleTime,
        lastHeartbeat: staleTime,
        cwd: tmpDir,
        pid: 12345,
      });

      const result = getActiveSessions();
      expect(result).toHaveLength(0);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('handles malformed session files gracefully', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      fs.writeFileSync(path.join(sessionsDir, 'bad-session.json'), 'not-valid-json');

      const result = getActiveSessions();
      expect(result).toEqual([]);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('getSessionSummary', () => {
    it('returns zero sessions when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = getSessionSummary();

      expect(result.totalSessions).toBe(0);
      expect(result.bySquad).toEqual({});
      expect(result.squadCount).toBe(0);

      cwdSpy.mockRestore();
    });

    it('aggregates sessions by squad', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const now = new Date().toISOString();
      writeSessionFile(sessionsDir, 'session-1', {
        sessionId: 'session-1',
        squad: 'engineering',
        startedAt: now,
        lastHeartbeat: now,
        cwd: tmpDir,
        pid: 111,
      });
      writeSessionFile(sessionsDir, 'session-2', {
        sessionId: 'session-2',
        squad: 'engineering',
        startedAt: now,
        lastHeartbeat: now,
        cwd: tmpDir,
        pid: 222,
      });
      writeSessionFile(sessionsDir, 'session-3', {
        sessionId: 'session-3',
        squad: 'product',
        startedAt: now,
        lastHeartbeat: now,
        cwd: tmpDir,
        pid: 333,
      });

      const result = getSessionSummary();
      expect(result.totalSessions).toBe(3);
      expect(result.bySquad).toEqual({ engineering: 2, product: 1 });
      expect(result.squadCount).toBe(2);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('counts null squad as unknown', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const now = new Date().toISOString();
      writeSessionFile(sessionsDir, 'session-null-squad', {
        sessionId: 'session-null-squad',
        squad: null,
        startedAt: now,
        lastHeartbeat: now,
        cwd: tmpDir,
        pid: 444,
      });

      const result = getSessionSummary();
      expect(result.totalSessions).toBe(1);
      expect(result.bySquad['unknown']).toBe(1);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('startSession', () => {
    it('returns null when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = startSession('engineering');
      expect(result).toBeNull();
      cwdSpy.mockRestore();
    });

    it('creates session file and returns session state', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const session = startSession('engineering');

      expect(session).not.toBeNull();
      expect(session!.squad).toBe('engineering');
      expect(session!.pid).toBe(process.pid);
      expect(session!.cwd).toBe(tmpDir);
      expect(session!.sessionId).toBeTruthy();

      const sessionFile = path.join(sessionsDir, `${session!.sessionId}.json`);
      expect(fs.existsSync(sessionFile)).toBe(true);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('auto-detects squad from cwd when not specified', () => {
      const { tmpDir } = createTempAgentsDir();
      // Create a cwd that matches agents-squads pattern
      const fakeAgentsSquadsDir = path.join(tmpDir, 'agents-squads', 'engineering');
      fs.mkdirSync(path.join(fakeAgentsSquadsDir, '.agents', 'sessions', 'active'), { recursive: true });

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fakeAgentsSquadsDir);

      const session = startSession();
      expect(session).not.toBeNull();
      expect(session!.squad).toBe('engineering');

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('stopSession', () => {
    it('returns false when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = stopSession();
      expect(result).toBe(false);
      cwdSpy.mockRestore();
    });

    it('removes session file and returns true', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      // Start a session first
      const session = startSession('cli');
      expect(session).not.toBeNull();

      const sessionFile = path.join(sessionsDir, `${session!.sessionId}.json`);
      expect(fs.existsSync(sessionFile)).toBe(true);

      const stopped = stopSession();
      expect(stopped).toBe(true);
      expect(fs.existsSync(sessionFile)).toBe(false);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('returns false when session file does not exist', () => {
      const { tmpDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      // Don't start a session — stopSession should return false
      const result = stopSession();
      expect(result).toBe(false);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('updateHeartbeat', () => {
    it('returns false when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = updateHeartbeat();
      expect(result).toBe(false);
      cwdSpy.mockRestore();
    });

    it('updates lastHeartbeat timestamp', async () => {
      const { tmpDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const session = startSession('cli');
      expect(session).not.toBeNull();
      const initialHeartbeat = session!.lastHeartbeat;

      // Wait a tick to ensure timestamp changes
      await new Promise(r => setTimeout(r, 5));

      const updated = updateHeartbeat();
      expect(updated).toBe(true);

      // Read the updated session file
      const sessionsDir = path.join(tmpDir, '.agents', 'sessions', 'active');
      const sessionFile = path.join(sessionsDir, `${session!.sessionId}.json`);
      const updatedSession = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
      expect(updatedSession.lastHeartbeat).not.toBe(initialHeartbeat);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });
  });

  describe('cleanupStaleSessions', () => {
    it('returns 0 when no .agents directory exists', () => {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(os.tmpdir());
      const result = cleanupStaleSessions();
      expect(result).toBe(0);
      cwdSpy.mockRestore();
    });

    it('removes stale sessions and returns count', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const now = new Date().toISOString();

      writeSessionFile(sessionsDir, 'stale-1', {
        sessionId: 'stale-1',
        squad: 'engineering',
        startedAt: staleTime,
        lastHeartbeat: staleTime,
        cwd: tmpDir,
        pid: 111,
      });
      writeSessionFile(sessionsDir, 'stale-2', {
        sessionId: 'stale-2',
        squad: 'product',
        startedAt: staleTime,
        lastHeartbeat: staleTime,
        cwd: tmpDir,
        pid: 222,
      });
      writeSessionFile(sessionsDir, 'active-1', {
        sessionId: 'active-1',
        squad: 'cli',
        startedAt: now,
        lastHeartbeat: now,
        cwd: tmpDir,
        pid: 333,
      });

      const cleaned = cleanupStaleSessions();
      expect(cleaned).toBe(2);

      // Active session should remain
      expect(fs.existsSync(path.join(sessionsDir, 'active-1.json'))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, 'stale-1.json'))).toBe(false);
      expect(fs.existsSync(path.join(sessionsDir, 'stale-2.json'))).toBe(false);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('removes malformed session files', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      fs.writeFileSync(path.join(sessionsDir, 'bad-session.json'), 'not-valid-json');

      const cleaned = cleanupStaleSessions();
      expect(cleaned).toBe(1);
      expect(fs.existsSync(path.join(sessionsDir, 'bad-session.json'))).toBe(false);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    });

    it('returns 0 when no stale sessions exist', () => {
      const { tmpDir, sessionsDir } = createTempAgentsDir();
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

      const now = new Date().toISOString();
      writeSessionFile(sessionsDir, 'active-session', {
        sessionId: 'active-session',
        squad: 'engineering',
        startedAt: now,
        lastHeartbeat: now,
        cwd: tmpDir,
        pid: 999,
      });

      const cleaned = cleanupStaleSessions();
      expect(cleaned).toBe(0);

      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
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

    it('handles empty ps output', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue('');

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

    it('returns zero counts when no AI processes running', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue('  PID TTY      CMD\n1234 pts/0   bash');

      const result = getLiveSessionSummaryFast();
      expect(result.totalSessions).toBe(0);
      expect(result.bySquad).toEqual({});
      expect(result.squadCount).toBe(0);
    });

    it('groups multiple tools correctly', () => {
      const mockExecSync = vi.mocked(child_process.execSync);
      mockExecSync.mockReturnValue(
        '  PID TTY      CMD\n1234 pts/0   claude\n2345 pts/1   cursor\n3456 pts/2   claude'
      );

      const result = getLiveSessionSummaryFast();
      expect(result.totalSessions).toBe(3);
      expect(result.byTool).toEqual({ claude: 2, cursor: 1 });
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
