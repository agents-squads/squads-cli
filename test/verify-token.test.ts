import { describe, it, expect, vi, beforeEach } from 'vitest';
import { verifyToken } from '../src/lib/auth.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('verifyToken', () => {
  it('returns user data on 200 (maps snake_case → camelCase)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        id: 'u_123',
        email: 'user@example.com',
        display_name: 'Test User',
        subscription_plan: 'pro',
      }),
    });

    const result = await verifyToken('tok_abc', 'https://api.example.com');

    expect(result).toEqual({
      id: 'u_123',
      email: 'user@example.com',
      name: 'Test User',
      plan: 'pro',
    });
  });

  it('returns null on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await verifyToken('bad_token', 'https://api.example.com');

    expect(result).toBeNull();
  });

  it('returns null on network error (silent)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const result = await verifyToken('tok_abc', 'https://api.example.com');

    expect(result).toBeNull();
  });

  it('returns null on timeout/abort', async () => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('Aborted'), { name: 'AbortError' }));

    const result = await verifyToken('tok_abc', 'https://api.example.com');

    expect(result).toBeNull();
  });

  it('sends Bearer token in Authorization header', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '1', email: 'u@e.com' }),
    });

    await verifyToken('my_token_xyz', 'https://api.example.com');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { Authorization: 'Bearer my_token_xyz' },
      })
    );
  });

  it('builds correct URL from apiUrl param', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: '1', email: 'u@e.com' }),
    });

    await verifyToken('tok', 'https://custom-api.agents-squads.com');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://custom-api.agents-squads.com/auth/verify',
      expect.any(Object)
    );
  });
});
