import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { reportExecutionStart, reportExecutionComplete } from '../src/lib/api-client.js';

// Mock the auth module
vi.mock('../src/lib/auth.js', () => ({
  loadSession: vi.fn(),
}));

// Mock the env-config module
vi.mock('../src/lib/env-config.js', () => ({
  getApiUrl: vi.fn(() => process.env.SQUADS_API_URL || 'https://api.test.com'),
  getBridgeUrl: vi.fn(() => 'https://bridge.test.com'),
}));

import { loadSession } from '../src/lib/auth.js';
const mockLoadSession = vi.mocked(loadSession);

describe('reportExecutionStart', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.SQUADS_API_URL;
    delete process.env.SCHEDULER_API_KEY;
    delete process.env.SQUADS_PLATFORM_API_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('returns null when no active session and no API key', async () => {
    mockLoadSession.mockReturnValue(null);

    const result = await reportExecutionStart('eng', 'lead', 'exec-1');

    expect(result).toBeNull();
  });

  it('POSTs with X-API-Key when SCHEDULER_API_KEY is set and there is no session (#1100 — unattended background dispatch)', async () => {
    mockLoadSession.mockReturnValue(null);
    process.env.SQUADS_API_URL = 'https://api.test.com';
    process.env.SCHEDULER_API_KEY = 'scheduler-secret';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ execution_id: 'api-exec-789' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await reportExecutionStart('cli', 'issue-solver', 'local-1', {
      trigger: 'background',
    });

    expect(result).toBe('api-exec-789');
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['X-API-Key']).toBe('scheduler-secret');
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('prefers SQUADS_PLATFORM_API_TOKEN over SCHEDULER_API_KEY', async () => {
    mockLoadSession.mockReturnValue(null);
    process.env.SQUADS_API_URL = 'https://api.test.com';
    process.env.SCHEDULER_API_KEY = 'scheduler-secret';
    process.env.SQUADS_PLATFORM_API_TOKEN = 'platform-token';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ execution_id: 'api-exec-789' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionStart('cli', 'issue-solver', 'local-1');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['X-API-Key']).toBe('platform-token');
  });

  it('sends both Authorization and X-API-Key when a session and an API key are both available', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
    });
    process.env.SQUADS_API_URL = 'https://api.test.com';
    process.env.SCHEDULER_API_KEY = 'scheduler-secret';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ execution_id: 'api-exec-1' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionStart('cli', 'issue-solver', 'local-1');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers.Authorization).toBe('Bearer valid-token');
    expect(options.headers['X-API-Key']).toBe('scheduler-secret');
  });

  it('returns null when no token', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      // no accessToken
    });

    const result = await reportExecutionStart('eng', 'lead', 'exec-1');

    expect(result).toBeNull();
  });

  it('returns null when status not active', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'pending',
      createdAt: '2024-01-01',
      accessToken: 'token',
    });

    const result = await reportExecutionStart('eng', 'lead', 'exec-1');

    expect(result).toBeNull();
  });

  it('POSTs to /agent-executions with correct payload', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ execution_id: 'api-exec-123' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionStart('engineering', 'eng-lead', 'local-123', {
      trigger: 'scheduled',
      model: 'opus',
      brief: 'Run daily analysis',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/agent-executions');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body);
    expect(body.squad).toBe('engineering');
    expect(body.agent).toBe('eng-lead');
    expect(body.executor).toBe('cli');
    expect(body.brief).toBe('Run daily analysis');
    expect(body.model).toBe('opus');
    // Run-ledger contract: the local id IS the row id — top-level, honored by
    // the API — not buried in metadata for a server-minted duplicate identity.
    expect(body.execution_id).toBe('local-123');
    expect(body.metadata.trigger).toBe('scheduled');
  });

  it('returns execution_id from response', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ execution_id: 'api-exec-456' }),
    }));

    const result = await reportExecutionStart('eng', 'lead', 'local-1');

    expect(result).toBe('api-exec-456');
  });

  it('returns null on fetch failure (silent, offline-first)', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const result = await reportExecutionStart('eng', 'lead', 'local-1');

    expect(result).toBeNull();
  });

  it('uses SQUADS_API_URL env fallback when session has no apiUrl', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      // no apiUrl in session
    });
    process.env.SQUADS_API_URL = 'https://env-api.test.com';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ execution_id: 'exec-1' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionStart('eng', 'lead', 'local-1');

    expect(mockFetch.mock.calls[0][0]).toBe('https://env-api.test.com/agent-executions');
  });
});

describe('reportExecutionComplete', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.SCHEDULER_API_KEY;
    delete process.env.SQUADS_PLATFORM_API_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('PATCHes with status and details', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionComplete('exec-123', 'completed', {
      summary: 'All tasks done',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test.com/agent-executions/exec-123');
    expect(options.method).toBe('PATCH');

    const body = JSON.parse(options.body);
    expect(body.status).toBe('completed');
    expect(body.summary).toBe('All tasks done');
  });

  it('returns false on failure (silent)', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));

    const result = await reportExecutionComplete('exec-123', 'failed', {
      error: 'Something broke',
    });

    expect(result).toBe(false);
  });

  it('returns false when no active session and no API key', async () => {
    mockLoadSession.mockReturnValue(null);

    const result = await reportExecutionComplete('exec-123', 'completed');

    expect(result).toBe(false);
  });

  it('PATCHes with X-API-Key when SCHEDULER_API_KEY is set and there is no session (#1100 — spool reconcile on an unattended machine)', async () => {
    mockLoadSession.mockReturnValue(null);
    process.env.SCHEDULER_API_KEY = 'scheduler-secret';

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const result = await reportExecutionComplete('exec-123', 'completed', {
      summary: 'Background run finished',
    });

    expect(result).toBe(true);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['X-API-Key']).toBe('scheduler-secret');
    expect(options.headers.Authorization).toBeUndefined();
  });

  it('includes durationMs in PATCH payload for background runs (#1100)', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionComplete('exec-123', 'completed', {
      summary: 'Background run finished',
      durationMs: 12345,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.duration_ms).toBe(12345);
  });

  it('includes error in PATCH payload when background run fails (#1100)', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionComplete('exec-123', 'failed', {
      error: 'Provider API timeout',
      durationMs: 5000,
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.status).toBe('failed');
    expect(body.error).toBe('Provider API timeout');
  });

  it('includes stream-derived model in PATCH payload (#1186)', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionComplete('exec-124', 'completed', {
      model: 'claude-sonnet-4-20250514',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('claude-sonnet-4-20250514');
  });

  it('omits model from PATCH payload when not provided (#1186)', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@acme.com',
      domain: 'acme.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'valid-token',
      apiUrl: 'https://api.test.com',
    });

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    await reportExecutionComplete('exec-125', 'completed', {
      summary: 'No model available',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body).not.toHaveProperty('model');
  });
});
