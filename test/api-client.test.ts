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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it('returns null when no active session', async () => {
    mockLoadSession.mockReturnValue(null);

    const result = await reportExecutionStart('eng', 'lead', 'exec-1');

    expect(result).toBeNull();
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
    expect(body.metadata.local_execution_id).toBe('local-123');
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

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
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

  it('returns false when no active session', async () => {
    mockLoadSession.mockReturnValue(null);

    const result = await reportExecutionComplete('exec-123', 'completed');

    expect(result).toBe(false);
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
});
