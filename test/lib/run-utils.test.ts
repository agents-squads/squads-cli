/**
 * Tests for src/lib/run-utils.ts — checkClaudeAuthenticated (#956).
 *
 * A stale OAuth/keychain session still answers normally, so the probe reads
 * the CLI's own error text rather than checking for an API key or
 * credentials file — an env/file-based check produced false positives for
 * OAuth users when it was tried before (#520).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';
import { checkClaudeAuthenticated, AUTH_PROBE_TIMEOUT_MS } from '../../src/lib/run-utils.js';

const mockExecSync = vi.mocked(execSync);

describe('checkClaudeAuthenticated', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when the CLI answers normally', () => {
    mockExecSync.mockReturnValue('ok\n' as unknown as Buffer);
    expect(checkClaudeAuthenticated()).toBe(true);
  });

  it('returns false when stdout reports "Not logged in"', () => {
    mockExecSync.mockReturnValue('Not logged in\n' as unknown as Buffer);
    expect(checkClaudeAuthenticated()).toBe(false);
  });

  it('returns false when stdout reports "Please run /login"', () => {
    mockExecSync.mockReturnValue('Please run /login to continue\n' as unknown as Buffer);
    expect(checkClaudeAuthenticated()).toBe(false);
  });

  it('returns false when the probe throws with "Not logged in" in stderr', () => {
    const error = Object.assign(new Error('command failed'), { stdout: '', stderr: 'Not logged in' });
    mockExecSync.mockImplementation(() => { throw error; });
    expect(checkClaudeAuthenticated()).toBe(false);
  });

  it('returns true when the probe throws for an unrelated reason (e.g. timeout)', () => {
    const error = Object.assign(new Error('Command timed out'), { stdout: '', stderr: '' });
    mockExecSync.mockImplementation(() => { throw error; });
    expect(checkClaudeAuthenticated()).toBe(true);
  });

  it('probes with a 10s timeout and no stdin', () => {
    mockExecSync.mockReturnValue('ok' as unknown as Buffer);
    checkClaudeAuthenticated();
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("claude -p 'ok'"),
      expect.objectContaining({ timeout: AUTH_PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
    );
  });
});
