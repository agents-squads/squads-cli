import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'child_process';

// Mock child_process
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

// Mock terminal (avoids side effects from ANSI detection)
vi.mock('../src/lib/terminal.js', () => ({
  colors: {
    green: '',
    yellow: '',
    red: '',
    cyan: '',
    dim: '',
    purple: '',
  },
  bold: '',
  RESET: '',
  icons: {
    success: '✓',
    warning: '⚠',
    error: '✖',
    progress: '◆',
  },
  writeLine: vi.fn(),
  gradient: (s: string) => s,
  box: { horizontal: '─', vertical: '│', topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘' },
  padEnd: (s: string, n: number) => s.padEnd(n),
}));

const mockedExecSync = vi.mocked(childProcess.execSync);
const mockedSpawn = vi.mocked(childProcess.spawn);

// Import after mocks
import {
  commandExists,
  isDockerRunning,
  isColimaRunning,
  checkDockerPrereqs,
  checkGhCli,
  checkGhPermissions,
  checkClaudeCli,
  checkProviderAuth,
  runPrereqChecks,
  runAuthChecks,
  displayCheckResults,
  attemptFix,
  waitForService,
  PROVIDERS,
  type CheckResult,
} from '../src/lib/setup-checks.js';

describe('setup-checks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('PROVIDERS registry', () => {
    it('contains all expected providers', () => {
      const expected = ['claude', 'gemini', 'openai', 'ollama', 'cursor', 'aider', 'none'];
      expect(Object.keys(PROVIDERS)).toEqual(expect.arrayContaining(expected));
      expect(Object.keys(PROVIDERS)).toHaveLength(expected.length);
    });

    it('each provider has required fields', () => {
      for (const [key, provider] of Object.entries(PROVIDERS)) {
        expect(provider.id).toBe(key);
        expect(typeof provider.name).toBe('string');
        expect(provider.name.length).toBeGreaterThan(0);
        expect(typeof provider.requiresSubscription).toBe('boolean');
        expect(typeof provider.requiresApiKey).toBe('boolean');
      }
    });
  });

  describe('commandExists', () => {
    it('returns true when command is found', () => {
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      expect(commandExists('git')).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith('which git', { stdio: 'ignore' });
    });

    it('returns false when command is not found', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error('not found'); });
      expect(commandExists('nonexistent')).toBe(false);
    });
  });

  describe('isDockerRunning', () => {
    it('returns true when docker info succeeds', () => {
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      expect(isDockerRunning()).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith('docker info', { stdio: 'ignore' });
    });

    it('returns false when docker info fails', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error('not running'); });
      expect(isDockerRunning()).toBe(false);
    });
  });

  describe('isColimaRunning', () => {
    it('returns true when colima status says Running', () => {
      mockedExecSync.mockReturnValueOnce('colima is Running' as any);
      expect(isColimaRunning()).toBe(true);
    });

    it('returns false when colima status does not say Running', () => {
      mockedExecSync.mockReturnValueOnce('colima is not running' as any);
      expect(isColimaRunning()).toBe(false);
    });

    it('returns false when colima command fails', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error('not installed'); });
      expect(isColimaRunning()).toBe(false);
    });
  });

  describe('checkDockerPrereqs', () => {
    it('returns ok when Docker is running', () => {
      // isDockerRunning -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      const result = checkDockerPrereqs();
      expect(result.status).toBe('ok');
      expect(result.name).toBe('Docker');
    });

    it('returns warning when Docker installed but not running, no colima', () => {
      // isDockerRunning -> false
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      // commandExists('docker') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // commandExists('colima') -> false
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkDockerPrereqs();
      expect(result.status).toBe('warning');
      expect(result.message).toContain('not running');
    });

    it('returns warning when Docker + Colima installed but Colima not running', () => {
      // isDockerRunning -> false
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      // commandExists('docker') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // commandExists('colima') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // isColimaRunning -> false
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkDockerPrereqs();
      expect(result.status).toBe('warning');
      expect(result.fixCommand).toBe('colima start');
    });

    it('returns ok when Colima is running', () => {
      // isDockerRunning -> false
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      // commandExists('docker') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // commandExists('colima') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // isColimaRunning -> colima status returns Running
      mockedExecSync.mockReturnValueOnce('colima is Running' as any);

      const result = checkDockerPrereqs();
      expect(result.status).toBe('ok');
      expect(result.name).toBe('Docker (Colima)');
    });

    it('returns warning when Docker is not installed', () => {
      // isDockerRunning -> false
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });
      // commandExists('docker') -> false
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkDockerPrereqs();
      expect(result.status).toBe('warning');
      expect(result.message).toContain('Optional');
    });
  });

  describe('checkGhCli', () => {
    it('returns ok when gh is installed and authenticated', () => {
      // commandExists('gh') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // gh auth status -> success
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));

      const result = checkGhCli();
      expect(result.status).toBe('ok');
      expect(result.name).toBe('GitHub CLI');
    });

    it('returns missing when gh is not installed', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkGhCli();
      expect(result.status).toBe('missing');
      expect(result.fixCommand).toBe('brew install gh');
    });

    it('returns warning when gh is installed but not authenticated', () => {
      // commandExists('gh') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // gh auth status -> fails
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkGhCli();
      expect(result.status).toBe('warning');
      expect(result.fixCommand).toBe('gh auth login');
    });
  });

  describe('checkGhPermissions', () => {
    it('returns ok when all scopes present', () => {
      mockedExecSync.mockReturnValueOnce('Token scopes: repo, workflow' as any);

      const result = checkGhPermissions();
      expect(result.status).toBe('ok');
    });

    it('returns warning when repo scope missing', () => {
      mockedExecSync.mockReturnValueOnce('Token scopes: none' as any);

      const result = checkGhPermissions();
      expect(result.status).toBe('warning');
      expect(result.message).toContain('repo scope');
    });

    it('returns warning when workflow scope missing but repo present', () => {
      mockedExecSync.mockReturnValueOnce('Token scopes: repo' as any);

      const result = checkGhPermissions();
      expect(result.status).toBe('warning');
      expect(result.message).toContain('workflow');
    });

    it('returns warning when auth status fails', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkGhPermissions();
      expect(result.status).toBe('warning');
      expect(result.message).toContain('Could not verify');
    });
  });

  describe('checkClaudeCli', () => {
    it('returns ok when claude is installed and working', () => {
      // commandExists('claude') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // claude --version -> success
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));

      const result = checkClaudeCli();
      expect(result.status).toBe('ok');
    });

    it('returns missing when claude is not installed', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkClaudeCli();
      expect(result.status).toBe('missing');
      expect(result.hint).toContain('npm install');
    });

    it('returns warning when claude is installed but version check fails', () => {
      // commandExists('claude') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // claude --version -> fails
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkClaudeCli();
      expect(result.status).toBe('warning');
      expect(result.message).toContain('may need login');
    });
  });

  describe('checkProviderAuth', () => {
    it('returns ok for "none" provider', () => {
      const result = checkProviderAuth('none');
      expect(result.status).toBe('ok');
    });

    it('returns ok for "cursor" provider', () => {
      const result = checkProviderAuth('cursor');
      expect(result.status).toBe('ok');
    });

    it('returns warning for unknown provider', () => {
      const result = checkProviderAuth('unknown-provider');
      expect(result.status).toBe('warning');
      expect(result.message).toContain('Unknown provider');
    });

    it('returns missing when provider CLI not installed', () => {
      // commandExists('claude') -> false
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkProviderAuth('claude');
      expect(result.status).toBe('missing');
      expect(result.fixCommand).toBeDefined();
    });

    it('returns ok when provider CLI is installed', () => {
      // commandExists('claude') -> true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));

      const result = checkProviderAuth('claude');
      expect(result.status).toBe('ok');
    });

    it('returns warning when API key required but not set', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const result = checkProviderAuth('openai');
      expect(result.status).toBe('warning');
      expect(result.message).toContain('OPENAI_API_KEY');

      if (originalKey) process.env.OPENAI_API_KEY = originalKey;
    });

    it('returns ok when API key required and set', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      const result = checkProviderAuth('openai');
      expect(result.status).toBe('ok');

      if (originalKey) {
        process.env.OPENAI_API_KEY = originalKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });

    it('returns missing when ollama CLI not installed', () => {
      mockedExecSync.mockImplementationOnce(() => { throw new Error(); });

      const result = checkProviderAuth('ollama');
      expect(result.status).toBe('missing');
    });
  });

  describe('runPrereqChecks', () => {
    it('returns array of check results', () => {
      // checkDockerPrereqs -> isDockerRunning true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // checkGhCli -> commandExists true, auth true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));

      const results = runPrereqChecks();
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('Docker');
      expect(results[1].name).toBe('GitHub CLI');
    });
  });

  describe('runAuthChecks', () => {
    it('includes provider check for claude', () => {
      // checkProviderAuth('claude') -> commandExists true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // checkClaudeCli -> commandExists true, version true
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      mockedExecSync.mockReturnValueOnce(Buffer.from(''));
      // checkGhPermissions -> auth status succeeds with all scopes
      mockedExecSync.mockReturnValueOnce('Token scopes: repo, workflow' as any);

      const results = runAuthChecks('claude');
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('skips GitHub permissions for none provider', () => {
      const results = runAuthChecks('none');
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('ok');
    });

    it('skips Claude CLI check for non-claude providers', () => {
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';

      // checkProviderAuth -> ok
      // checkGhPermissions -> auth status
      mockedExecSync.mockReturnValueOnce('Token scopes: repo, workflow' as any);

      const results = runAuthChecks('openai');
      // Should have provider check + gh permissions, but NOT claude CLI
      expect(results).toHaveLength(2);

      if (originalKey) {
        process.env.OPENAI_API_KEY = originalKey;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
    });
  });

  describe('displayCheckResults', () => {
    it('returns no errors or warnings for all-ok checks', () => {
      const checks: CheckResult[] = [
        { name: 'Docker', status: 'ok' },
        { name: 'GitHub CLI', status: 'ok' },
      ];

      const result = displayCheckResults(checks);
      expect(result.hasErrors).toBe(false);
      expect(result.hasWarnings).toBe(false);
      expect(result.errorChecks).toHaveLength(0);
      expect(result.warningChecks).toHaveLength(0);
    });

    it('identifies errors and warnings', () => {
      const checks: CheckResult[] = [
        { name: 'Docker', status: 'missing', message: 'Not installed' },
        { name: 'GitHub CLI', status: 'warning', message: 'Not authenticated', hint: 'Run gh auth login' },
        { name: 'Claude CLI', status: 'ok' },
      ];

      const result = displayCheckResults(checks);
      expect(result.hasErrors).toBe(true);
      expect(result.hasWarnings).toBe(true);
      expect(result.errorChecks).toHaveLength(1);
      expect(result.warningChecks).toHaveLength(1);
    });

    it('treats missing status as error', () => {
      const checks: CheckResult[] = [
        { name: 'Test', status: 'missing' },
      ];

      const result = displayCheckResults(checks);
      expect(result.hasErrors).toBe(true);
      expect(result.errorChecks[0].name).toBe('Test');
    });

    it('treats error status as error', () => {
      const checks: CheckResult[] = [
        { name: 'Test', status: 'error' },
      ];

      const result = displayCheckResults(checks);
      expect(result.hasErrors).toBe(true);
    });
  });

  describe('attemptFix', () => {
    it('returns false when no fixCommand', async () => {
      const check: CheckResult = { name: 'Test', status: 'missing' };
      const result = await attemptFix(check);
      expect(result).toBe(false);
    });

    it('returns true when fix command succeeds', async () => {
      const mockProc = {
        on: vi.fn((event: string, cb: Function) => {
          if (event === 'close') setTimeout(() => cb(0), 0);
          return mockProc;
        }),
      };
      mockedSpawn.mockReturnValueOnce(mockProc as any);

      const check: CheckResult = { name: 'Test', status: 'missing', fixCommand: 'brew install test' };
      const result = await attemptFix(check);
      expect(result).toBe(true);
      expect(mockedSpawn).toHaveBeenCalledWith('brew install test', [], { stdio: 'inherit', shell: true });
    });

    it('returns false when fix command fails', async () => {
      const mockProc = {
        on: vi.fn((event: string, cb: Function) => {
          if (event === 'close') setTimeout(() => cb(1), 0);
          return mockProc;
        }),
      };
      mockedSpawn.mockReturnValueOnce(mockProc as any);

      const check: CheckResult = { name: 'Test', status: 'missing', fixCommand: 'bad-command' };
      const result = await attemptFix(check);
      expect(result).toBe(false);
    });

    it('returns false when spawn errors', async () => {
      const mockProc = {
        on: vi.fn((event: string, cb: Function) => {
          if (event === 'error') setTimeout(() => cb(new Error('spawn error')), 0);
          return mockProc;
        }),
      };
      mockedSpawn.mockReturnValueOnce(mockProc as any);

      const check: CheckResult = { name: 'Test', status: 'missing', fixCommand: 'bad-command' };
      const result = await attemptFix(check);
      expect(result).toBe(false);
    });
  });

  describe('waitForService', () => {
    it('returns true immediately when service is ready', async () => {
      const checkFn = vi.fn().mockResolvedValueOnce(true);
      const result = await waitForService('test', checkFn, 5, 10);
      expect(result).toBe(true);
      expect(checkFn).toHaveBeenCalledTimes(1);
    });

    it('retries until service is ready', async () => {
      const checkFn = vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      const result = await waitForService('test', checkFn, 5, 10);
      expect(result).toBe(true);
      expect(checkFn).toHaveBeenCalledTimes(3);
    });

    it('returns false when max attempts exceeded', async () => {
      const checkFn = vi.fn().mockResolvedValue(false);
      const result = await waitForService('test', checkFn, 3, 10);
      expect(result).toBe(false);
      expect(checkFn).toHaveBeenCalledTimes(3);
    });

    it('works with sync check function', async () => {
      const checkFn = vi.fn().mockReturnValueOnce(true);
      const result = await waitForService('test', checkFn, 5, 10);
      expect(result).toBe(true);
    });
  });
});
