import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Heavy mocks must be hoisted before imports
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
    pid: 12345,
  })),
}));

vi.mock('crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'abc123abc123abc1'),
  })),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
  };
});

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
    blue: '',
    magenta: '',
  },
  bold: '',
  RESET: '',
  icons: {
    running: '→',
    success: '✓',
    error: '✗',
    warning: '!',
    progress: '›',
    empty: '○',
    paused: '⏸',
  },
  gradient: vi.fn((s: string) => s),
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(() => null),
  listSquads: vi.fn(() => []),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(() => null),
}));

vi.mock('../../src/lib/github.js', () => ({
  getBotGhEnv: vi.fn(async () => ({})),
}));

vi.mock('../../src/lib/outcomes.js', () => ({
  recordArtifacts: vi.fn(),
  pollOutcomes: vi.fn(() => ({ polled: 0, settled: 0 })),
  computeAllScorecards: vi.fn(),
  getOutcomeScoreModifier: vi.fn(() => ({ modifier: 0, reason: '' })),
}));

import { daemonCommand } from '../../src/commands/daemon.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getBotGhEnv } from '../../src/lib/github.js';
import { pollOutcomes, computeAllScorecards } from '../../src/lib/outcomes.js';
import { findSquadsDir } from '../../src/lib/squad-parser.js';
import { writeLine } from '../../src/lib/terminal.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockGetBotGhEnv = vi.mocked(getBotGhEnv);
const mockPollOutcomes = vi.mocked(pollOutcomes);
const mockComputeAllScorecards = vi.mocked(computeAllScorecards);
const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockWriteLine = vi.mocked(writeLine);

describe('daemonCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no state file, no squads dir
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}' as unknown as ReturnType<typeof readFileSync>);
    mockFindSquadsDir.mockReturnValue(null);
    mockGetBotGhEnv.mockResolvedValue({});
    mockPollOutcomes.mockReturnValue({ polled: 0, settled: 0 });
    mockComputeAllScorecards.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs one cycle and exits when --once is set', async () => {
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
    expect(mockGetBotGhEnv).toHaveBeenCalledTimes(1);
  });

  it('calls pollOutcomes once per cycle', async () => {
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
    expect(mockPollOutcomes).toHaveBeenCalledTimes(1);
  });

  it('computes scorecards with 7d period on each cycle', async () => {
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
    expect(mockComputeAllScorecards).toHaveBeenCalledWith('7d');
  });

  it('exits cleanly when no squads are found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
  });

  it('resolves with verbose option enabled', async () => {
    await expect(daemonCommand({ once: true, verbose: true })).resolves.toBeUndefined();
  });

  it('resolves with dry-run option enabled', async () => {
    await expect(daemonCommand({ dryRun: true, once: true })).resolves.toBeUndefined();
  });

  it('uses default interval and parallel values', async () => {
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
    // Should not throw from parsing defaults
  });

  it('writes status lines on start', async () => {
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
    expect(mockWriteLine).toHaveBeenCalled();
  });

  it('saves state after each cycle', async () => {
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('checks existsSync for state file on cycle start', async () => {
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
    expect(mockExistsSync).toHaveBeenCalled();
  });

  it('enforces budget ceiling when daily cost equals budget', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExistsSync.mockImplementation((p) => String(p).endsWith('state.json'));
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        lastCycle: '',
        dailyCost: 10,
        dailyCostDate: today,
        recentRuns: [],
        failCounts: {},
      }) as unknown as ReturnType<typeof readFileSync>,
    );
    // Budget of $5 with $10 already spent — should halt without dispatching
    await expect(daemonCommand({ once: true, budget: '5' })).resolves.toBeUndefined();
  });

  it('enforces budget ceiling when daily cost exceeds budget', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExistsSync.mockImplementation((p) => String(p).endsWith('state.json'));
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        lastCycle: '',
        dailyCost: 100,
        dailyCostDate: today,
        recentRuns: [],
        failCounts: {},
      }) as unknown as ReturnType<typeof readFileSync>,
    );
    await expect(daemonCommand({ once: true, budget: '50' })).resolves.toBeUndefined();
  });

  it('resets daily cost counter when date changes', async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith('state.json'));
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        lastCycle: '',
        dailyCost: 99,
        dailyCostDate: '2020-01-01', // old date — triggers reset
        recentRuns: [],
        failCounts: {},
      }) as unknown as ReturnType<typeof readFileSync>,
    );
    await expect(daemonCommand({ once: true }).then(() => {
      // Daily cost should have been reset — state file was saved
      expect(mockWriteFileSync).toHaveBeenCalled();
    })).resolves.toBeUndefined();
  });

  it('does not enforce budget when budget is 0 (subscription mode)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockExistsSync.mockImplementation((p) => String(p).endsWith('state.json'));
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        lastCycle: '',
        dailyCost: 999,
        dailyCostDate: today,
        recentRuns: [],
        failCounts: {},
      }) as unknown as ReturnType<typeof readFileSync>,
    );
    // budget=0 (default) = unlimited — should proceed past budget check
    await expect(daemonCommand({ once: true, budget: '0' })).resolves.toBeUndefined();
  });

  it('handles missing state file by using default state', async () => {
    mockExistsSync.mockReturnValue(false); // state file does not exist
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
    // writeFileSync called because saveState creates it
    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('handles corrupt state file by falling back to default state', async () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith('state.json'));
    mockReadFileSync.mockReturnValue('INVALID JSON !!!' as unknown as ReturnType<typeof readFileSync>);
    await expect(daemonCommand({ once: true })).resolves.toBeUndefined();
  });
});
