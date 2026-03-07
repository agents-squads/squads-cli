import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  Events: { CLI_STATUS: 'cli_status' },
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '',
    red: '',
    green: '',
    yellow: '',
    purple: '',
    cyan: '',
  },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  icons: { success: '✓', warning: '⚠', error: '✗', empty: '○' },
}));

import { autonomyCommand } from '../../src/commands/autonomy.js';

const mockAutonomyResponse = {
  overall_score: 80,
  confidence_level: 'high',
  period: 'today',
  squad: null,
  components: {
    quota_compliance: 90,
    cooldown_compliance: 85,
    quality_score: 75,
    success_rate: 88,
    learning_utilization: 60,
  },
  execution_stats: {
    total_tasks: 10,
    successful_tasks: 9,
    monthly_used: 25,
    monthly_quota: 100,
    quota_pct: 25,
    learning_count: 3,
  },
};

describe('autonomyCommand', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('resolves without error when bridge returns valid data', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(mockAutonomyResponse),
    } as unknown as Response);

    await expect(autonomyCommand()).resolves.toBeUndefined();
  });

  it('outputs JSON when --json option is set', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue(mockAutonomyResponse),
    } as unknown as Response);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await autonomyCommand({ json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.overall_score).toBe(80);
    consoleSpy.mockRestore();
  });

  it('handles fetch failure gracefully', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    await expect(autonomyCommand()).resolves.toBeUndefined();
  });

  it('uses the period option in the request', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        json: vi.fn().mockResolvedValue(mockAutonomyResponse),
      });
    });

    await autonomyCommand({ period: 'week' });

    expect(capturedUrl).toContain('period=week');
  });

  it('includes squad in request when provided', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        json: vi.fn().mockResolvedValue({ ...mockAutonomyResponse, squad: 'engineering' }),
      });
    });

    await autonomyCommand({ squad: 'engineering' });

    expect(capturedUrl).toContain('squad=engineering');
  });

  it('resolves without error for low score with recommendations', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        ...mockAutonomyResponse,
        overall_score: 40,
        confidence_level: 'low',
        components: {
          ...mockAutonomyResponse.components,
          learning_utilization: 20,
          quality_score: 30,
          quota_compliance: 50,
        },
        execution_stats: { ...mockAutonomyResponse.execution_stats, total_tasks: 0 },
      }),
    } as unknown as Response);

    await expect(autonomyCommand()).resolves.toBeUndefined();
  });
});
