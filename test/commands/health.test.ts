import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '',
    red: '',
    green: '',
    yellow: '',
    purple: '',
    cyan: '',
    white: '',
  },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  icons: {
    success: '✓',
    error: '✗',
    warning: '!',
    progress: '›',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
}));

import { healthCommand } from '../../src/commands/health.js';

describe('healthCommand', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves when all services are down (all optional)', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));
    await expect(healthCommand()).resolves.toBeUndefined();
  });

  it('resolves when all services respond healthy', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    await expect(healthCommand()).resolves.toBeUndefined();
  });

  it('resolves when some services return non-ok status (degraded)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
    await expect(healthCommand()).resolves.toBeUndefined();
  });

  it('resolves with verbose option when services are down', async () => {
    fetchMock.mockRejectedValue(new Error('timeout'));
    await expect(healthCommand({ verbose: true })).resolves.toBeUndefined();
  });

  it('resolves with verbose option when services are healthy', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as Response);
    await expect(healthCommand({ verbose: true })).resolves.toBeUndefined();
  });

  it('shows trigger stats when scheduler is healthy', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/triggers/stats')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            active: 3,
            disabled: 1,
            last_fire: { name: 'cli-trigger', fired_at: new Date().toISOString() },
          }),
        } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    });
    await expect(healthCommand()).resolves.toBeUndefined();
  });

  it('handles scheduler healthy but trigger stats fetch fails', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/triggers/stats')) {
        return Promise.reject(new Error('not found'));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    });
    await expect(healthCommand()).resolves.toBeUndefined();
  });

  it('handles empty options object', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));
    await expect(healthCommand({})).resolves.toBeUndefined();
  });

  it('shows trigger stats with no last_fire', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/api/triggers/stats')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ active: 0, disabled: 0 }),
        } as Response);
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) } as Response);
    });
    await expect(healthCommand()).resolves.toBeUndefined();
  });
});
