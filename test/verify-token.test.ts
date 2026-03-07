import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyToken } from '../src/lib/auth.js';

describe('verifyToken', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns user data on 200 (maps snake_case → camelCase)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        email: 'user@acme.com',
        tenant_id: 42,
        tenant_slug: 'acme',
        tenant_name: 'Acme Corp',
        status: 'active',
      }),
    }));

    const result = await verifyToken('https://api.example.com', 'valid-token');

    expect(result).toEqual({
      email: 'user@acme.com',
      tenantId: 42,
      tenantSlug: 'acme',
      tenantName: 'Acme Corp',
      status: 'active',
    });
  });

  it('returns null on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
    }));

    const result = await verifyToken('https://api.example.com', 'bad-token');

    expect(result).toBeNull();
  });

  it('returns null on network error (silent)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await verifyToken('https://api.example.com', 'any-token');

    expect(result).toBeNull();
  });

  it('returns null on timeout/abort', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('The operation was aborted', 'AbortError')));

    const result = await verifyToken('https://api.example.com', 'any-token');

    expect(result).toBeNull();
  });

  it('sends Bearer token in Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', mockFetch);

    await verifyToken('https://api.example.com', 'my-secret-token');

    expect(mockFetch).toHaveBeenCalledOnce();
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].headers.Authorization).toBe('Bearer my-secret-token');
  });

  it('builds correct URL from apiUrl param', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', mockFetch);

    await verifyToken('https://custom-api.io', 'token');

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(mockFetch.mock.calls[0][0]).toBe('https://custom-api.io/auth/cli/verify');
  });
});
