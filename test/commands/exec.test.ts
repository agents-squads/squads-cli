import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  Events: { CLI_EXEC: 'cli_exec' },
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', purple: '', cyan: '' },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  box: { topLeft: '', topRight: '', bottomLeft: '', bottomRight: '', vertical: '', horizontal: '', teeLeft: '', teeRight: '' },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
  icons: { running: '◉', success: '✓', error: '✗', empty: '○' },
}));

vi.mock('../../src/lib/executions.js', () => ({
  listExecutions: vi.fn(),
  getExecutionStats: vi.fn(),
  formatDuration: vi.fn((ms: number) => `${ms}ms`),
  formatRelativeTime: vi.fn(() => '2m ago'),
}));

import { execListCommand, execShowCommand, execStatsCommand } from '../../src/commands/exec.js';
import { listExecutions, getExecutionStats } from '../../src/lib/executions.js';

const mockListExecutions = vi.mocked(listExecutions);
const mockGetExecutionStats = vi.mocked(getExecutionStats);

const sampleExecution = {
  id: 'exec-abc123def456',
  squad: 'engineering',
  agent: 'issue-solver',
  status: 'completed' as const,
  taskType: 'issue',
  trigger: 'label',
  startTime: '2026-03-06T10:00:00Z',
  endTime: '2026-03-06T10:15:00Z',
  durationMs: 900000,
  outcome: 'Created PR #123',
};

const sampleStats = {
  total: 5,
  running: 1,
  completed: 3,
  failed: 1,
  avgDurationMs: 450000,
  bySquad: { engineering: 3, marketing: 2 },
  byAgent: { 'engineering/issue-solver': 3, 'marketing/content-writer': 2 },
};

describe('execListCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExecutionStats.mockReturnValue(sampleStats);
  });

  it('resolves without error when no executions exist', async () => {
    mockListExecutions.mockReturnValue([]);

    await expect(execListCommand()).resolves.toBeUndefined();
  });

  it('resolves without error when executions exist', async () => {
    mockListExecutions.mockReturnValue([sampleExecution]);

    await expect(execListCommand()).resolves.toBeUndefined();
  });

  it('outputs JSON when --json option is set', async () => {
    mockListExecutions.mockReturnValue([sampleExecution]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await execListCommand({ json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(Array.isArray(output)).toBe(true);
    consoleSpy.mockRestore();
  });

  it('filters by squad when squad option provided', async () => {
    mockListExecutions.mockReturnValue([sampleExecution]);

    await execListCommand({ squad: 'engineering' });

    expect(mockListExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ squad: 'engineering' })
    );
  });

  it('applies limit option', async () => {
    mockListExecutions.mockReturnValue([]);

    await execListCommand({ limit: 5 });

    expect(mockListExecutions).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 })
    );
  });
});

describe('execShowCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves without error when execution found', async () => {
    mockListExecutions.mockReturnValue([sampleExecution]);

    await expect(execShowCommand('exec-abc123def456')).resolves.toBeUndefined();
  });

  it('handles execution not found', async () => {
    mockListExecutions.mockReturnValue([]);

    await expect(execShowCommand('nonexistent-id')).resolves.toBeUndefined();
  });

  it('handles multiple matches for partial ID', async () => {
    mockListExecutions.mockReturnValue([
      { ...sampleExecution, id: 'exec-abc1' },
      { ...sampleExecution, id: 'exec-abc2' },
    ]);

    await expect(execShowCommand('exec-abc')).resolves.toBeUndefined();
  });

  it('outputs JSON when --json option is set', async () => {
    mockListExecutions.mockReturnValue([sampleExecution]);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await execShowCommand('exec-abc123def456', { json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.id).toBe('exec-abc123def456');
    consoleSpy.mockRestore();
  });

  it('supports partial ID matching', async () => {
    mockListExecutions.mockReturnValue([sampleExecution]);

    await expect(execShowCommand('exec-abc')).resolves.toBeUndefined();
  });
});

describe('execStatsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetExecutionStats.mockReturnValue(sampleStats);
  });

  it('resolves without error', async () => {
    await expect(execStatsCommand()).resolves.toBeUndefined();
  });

  it('outputs JSON when --json option is set', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await execStatsCommand({ json: true });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(output.total).toBe(5);
    consoleSpy.mockRestore();
  });

  it('filters by squad when squad option provided', async () => {
    await execStatsCommand({ squad: 'engineering' });

    expect(mockGetExecutionStats).toHaveBeenCalledWith(
      expect.objectContaining({ squad: 'engineering' })
    );
  });

  it('handles stats with no average duration', async () => {
    mockGetExecutionStats.mockReturnValue({ ...sampleStats, avgDurationMs: null });

    await expect(execStatsCommand()).resolves.toBeUndefined();
  });
});
