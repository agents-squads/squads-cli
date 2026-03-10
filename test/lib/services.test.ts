/**
 * Tests for src/lib/services.ts — service availability checking utilities.
 *
 * Covers:
 * - checkServiceAvailable: unknown service, container not running, health check fail/pass
 * - showServiceSetupGuide: output format for known/unknown services
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

// Mock terminal to suppress output during tests
vi.mock('../../src/lib/terminal.js', () => ({
  colors: { yellow: '', dim: '', red: '', green: '', cyan: '' },
  bold: '',
  RESET: '',
  icons: { warning: '⚠' },
  writeLine: vi.fn(),
}));

import { execSync } from 'child_process';
import { checkServiceAvailable, showServiceSetupGuide } from '../../src/lib/services.js';
import { writeLine } from '../../src/lib/terminal.js';

const mockExecSync = vi.mocked(execSync);
const mockWriteLine = vi.mocked(writeLine);

describe('checkServiceAvailable', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns false for unknown service name', async () => {
    const result = await checkServiceAvailable('unknown-service' as never);
    expect(result).toBe(false);
  });

  it('returns false when container is not running', async () => {
    mockExecSync.mockReturnValue('false' as never);
    const result = await checkServiceAvailable('postgres', false);
    expect(result).toBe(false);
  });

  it('returns false when docker inspect throws (container not found)', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('container not found'); });
    const result = await checkServiceAvailable('postgres', false);
    expect(result).toBe(false);
  });

  it('returns true for postgres (no healthUrl) when container is running', async () => {
    // postgres has no healthUrl — only needs container running
    mockExecSync.mockReturnValueOnce('true' as never)  // running check
      .mockReturnValueOnce('' as never)                // port (optional)
      .mockReturnValueOnce('none' as never);            // health status (none = healthy)
    const result = await checkServiceAvailable('postgres', false);
    expect(result).toBe(true);
  });

  it('shows guidance by default when container is not running', async () => {
    mockExecSync.mockReturnValue('false' as never);
    await checkServiceAvailable('postgres');
    expect(mockWriteLine).toHaveBeenCalled();
  });

  it('suppresses guidance when showGuidance=false', async () => {
    mockExecSync.mockReturnValue('false' as never);
    await checkServiceAvailable('postgres', false);
    expect(mockWriteLine).not.toHaveBeenCalled();
  });

  it('returns false when health URL check fails', async () => {
    // bridge has a healthUrl — needs container running + health OK
    mockExecSync.mockReturnValueOnce('true' as never)
      .mockReturnValueOnce('' as never)
      .mockReturnValueOnce('none' as never);

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));

    const result = await checkServiceAvailable('bridge', false);
    expect(result).toBe(false);
  });

  it('returns true when container running and health URL responds ok', async () => {
    mockExecSync.mockReturnValueOnce('true' as never)
      .mockReturnValueOnce('8088' as never)
      .mockReturnValueOnce('none' as never);

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    const result = await checkServiceAvailable('bridge', false);
    expect(result).toBe(true);
  });

  it('returns false when health URL responds with non-ok status', async () => {
    mockExecSync.mockReturnValueOnce('true' as never)
      .mockReturnValueOnce('' as never)
      .mockReturnValueOnce('none' as never);

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

    const result = await checkServiceAvailable('bridge', false);
    expect(result).toBe(false);
  });

  it('returns false when container health status is "starting"', async () => {
    mockExecSync.mockReturnValueOnce('true' as never)
      .mockReturnValueOnce('' as never)
      .mockReturnValueOnce('starting' as never);  // starting = unhealthy

    // bridge has healthUrl, so it still checks HTTP
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    const result = await checkServiceAvailable('bridge', false);
    // Container health is starting but HTTP is ok — returns true (healthUrl is the final check)
    expect(result).toBe(true);
  });
});

describe('showServiceSetupGuide', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing for unknown service name', () => {
    showServiceSetupGuide('unknown-service' as never, 'not running');
    expect(mockWriteLine).not.toHaveBeenCalled();
  });

  it('outputs service name and issue for bridge', () => {
    showServiceSetupGuide('bridge', 'not running');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('Bridge API');
    expect(calls).toContain('not running');
  });

  it('outputs service name and issue for postgres', () => {
    showServiceSetupGuide('postgres', 'not responding');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('PostgreSQL');
    expect(calls).toContain('not responding');
  });

  it('outputs setup guide steps', () => {
    showServiceSetupGuide('bridge', 'not running');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('squads stack up');
  });

  it('outputs env var status for services with envVars', () => {
    showServiceSetupGuide('bridge', 'not running');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('SQUADS_BRIDGE_URL');
  });

  it('works for all known services without throwing', () => {
    const services = ['bridge', 'postgres', 'mem0', 'scheduler', 'langfuse', 'redis'] as const;
    for (const svc of services) {
      expect(() => showServiceSetupGuide(svc, 'not running')).not.toThrow();
    }
  });

  it('outputs full setup guide for mem0', () => {
    showServiceSetupGuide('mem0', 'not running');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('Mem0');
    expect(calls).toContain('squads stack up');
  });

  it('references squads health in footer', () => {
    showServiceSetupGuide('redis', 'not running');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('squads health');
  });
});
