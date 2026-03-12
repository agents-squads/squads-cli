/**
 * Tests for src/lib/services.ts — service availability checking utilities.
 *
 * Covers:
 * - checkServiceAvailable: unknown service, health check fail/pass
 * - showServiceSetupGuide: output format for known/unknown services
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock terminal to suppress output during tests
vi.mock('../../src/lib/terminal.js', () => ({
  colors: { yellow: '', dim: '', red: '', green: '', cyan: '' },
  bold: '',
  RESET: '',
  icons: { warning: '⚠' },
  writeLine: vi.fn(),
}));

import { checkServiceAvailable, showServiceSetupGuide } from '../../src/lib/services.js';
import { writeLine } from '../../src/lib/terminal.js';

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

  it('returns false when health URL is not configured', async () => {
    // postgres has no healthUrl by default (empty getHealthUrl)
    const result = await checkServiceAvailable('postgres', false);
    expect(result).toBe(false);
  });

  it('shows guidance by default when service unavailable', async () => {
    await checkServiceAvailable('postgres');
    expect(mockWriteLine).toHaveBeenCalled();
  });

  it('suppresses guidance when showGuidance=false', async () => {
    await checkServiceAvailable('postgres', false);
    expect(mockWriteLine).not.toHaveBeenCalled();
  });

  it('returns false when health URL check fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('connection refused'));

    // bridge needs SQUADS_BRIDGE_URL to have a health URL
    process.env.SQUADS_BRIDGE_URL = 'http://localhost:8088';
    const result = await checkServiceAvailable('bridge', false);
    delete process.env.SQUADS_BRIDGE_URL;
    expect(result).toBe(false);
  });

  it('returns true when health URL responds ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true } as Response);

    process.env.SQUADS_BRIDGE_URL = 'http://localhost:8088';
    const result = await checkServiceAvailable('bridge', false);
    delete process.env.SQUADS_BRIDGE_URL;
    expect(result).toBe(true);
  });

  it('returns false when health URL responds with non-ok status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false } as Response);

    process.env.SQUADS_BRIDGE_URL = 'http://localhost:8088';
    const result = await checkServiceAvailable('bridge', false);
    delete process.env.SQUADS_BRIDGE_URL;
    expect(result).toBe(false);
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
    expect(calls).toContain('API');
    expect(calls).toContain('not running');
  });

  it('outputs service name and issue for postgres', () => {
    showServiceSetupGuide('postgres', 'not responding');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('Database');
    expect(calls).toContain('not responding');
  });

  it('outputs setup guide with squads login', () => {
    showServiceSetupGuide('bridge', 'not running');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('squads login');
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
    expect(calls).toContain('Memory Service');
    expect(calls).toContain('squads login');
  });

  it('references squads health in footer', () => {
    showServiceSetupGuide('redis', 'not running');
    const calls = mockWriteLine.mock.calls.map(c => c[0] ?? '').join('\n');
    expect(calls).toContain('squads health');
  });
});
