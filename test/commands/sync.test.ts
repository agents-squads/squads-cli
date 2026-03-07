import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => ''),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  loadSquad: vi.fn(),
}));

vi.mock('../../src/lib/cycle-sync.js', () => ({
  syncAllCycleData: vi.fn(),
  isPostgresAvailable: vi.fn(),
  closeCycleSyncPool: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  colors: { dim: '', cyan: '', red: '', yellow: '', green: '', white: '', purple: '' },
  bold: '',
  RESET: '',
  gradient: (s: string) => s,
  icons: { success: '+', error: 'x', warning: '!', active: '*', running: '>', progress: '...' },
  writeLine: vi.fn(),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn(),
  Events: { CLI_MEMORY_SYNC: 'cli_memory_sync' },
}));

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { findMemoryDir } from '../../src/lib/memory.js';
import { findSquadsDir } from '../../src/lib/squad-parser.js';
import { isPostgresAvailable, syncAllCycleData, closeCycleSyncPool } from '../../src/lib/cycle-sync.js';
import { writeLine } from '../../src/lib/terminal.js';
import { syncCommand } from '../../src/commands/sync.js';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockFindMemoryDir = vi.mocked(findMemoryDir);
const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockIsPostgresAvailable = vi.mocked(isPostgresAvailable);
const mockSyncAllCycleData = vi.mocked(syncAllCycleData);

describe('syncCommand', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockFindMemoryDir.mockReturnValue('/fake/.agents/memory');
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('shows warning when no memory directory found', async () => {
    mockFindMemoryDir.mockReturnValue(null);

    await syncCommand({});

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('No .agents/memory directory found');
  });

  it('pulls from remote by default', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git fetch')) return '';
      if (typeof cmd === 'string' && cmd.includes('git status -sb')) return '## main...origin/main';
      if (typeof cmd === 'string' && cmd.includes('git log')) return '';
      return '';
    });

    await syncCommand({});

    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('git fetch'),
      expect.any(Object),
    );
  });

  it('reports no new commits when none found', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git fetch')) return '';
      if (typeof cmd === 'string' && cmd.includes('git status -sb')) return '## main';
      if (typeof cmd === 'string' && cmd.includes('git log')) return '';
      return '';
    });

    await syncCommand({});

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('No new commits');
  });

  it('processes and groups commits by squad', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git fetch')) return '';
      if (typeof cmd === 'string' && cmd.includes('git status -sb')) return '## main';
      if (typeof cmd === 'string' && cmd.includes('git log')) {
        return 'abc1234|2026-03-07T10:00:00Z|feat(cli): add tests\nsrc/commands/test.ts';
      }
      if (typeof cmd === 'string' && cmd.includes('git pull')) return 'Already up to date';
      return '';
    });

    mockExistsSync.mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('.last-sync')) return false;
      if (typeof path === 'string' && path.includes('memory')) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      { name: 'cli-lead', isDirectory: () => true, isFile: () => false } as unknown as ReturnType<typeof readdirSync>[0],
    ] as ReturnType<typeof readdirSync>);

    await syncCommand({});

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('1 commits to process');
    expect(calls).toContain('squad memories updated');
  });

  it('pushes to remote when --push is set', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git fetch')) return '';
      if (typeof cmd === 'string' && cmd.includes('git status')) return '';
      if (typeof cmd === 'string' && cmd.includes('git log')) {
        return 'abc1234|2026-03-07T10:00:00Z|feat(cli): push test\nsrc/commands/test.ts';
      }
      if (typeof cmd === 'string' && cmd.includes('git pull')) return '';
      if (typeof cmd === 'string' && cmd.includes('git push')) return 'Pushed successfully';
      if (typeof cmd === 'string' && cmd.includes('git add')) return '';
      if (typeof cmd === 'string' && cmd.includes('git commit')) return '';
      return '';
    });

    mockExistsSync.mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('memory')) return true;
      return false;
    });

    mockReaddirSync.mockReturnValue([
      { name: 'cli-lead', isDirectory: () => true, isFile: () => false } as unknown as ReturnType<typeof readdirSync>[0],
    ] as ReturnType<typeof readdirSync>);

    await syncCommand({ push: true });

    // Verify git push was called
    const pushCalls = mockExecSync.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('git push'),
    );
    expect(pushCalls.length).toBeGreaterThan(0);
  });

  it('syncs to postgres when --postgres and available', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git fetch')) return '';
      if (typeof cmd === 'string' && cmd.includes('git status')) return '';
      if (typeof cmd === 'string' && cmd.includes('git log')) return '';
      return '';
    });

    mockIsPostgresAvailable.mockResolvedValue(true);
    mockSyncAllCycleData.mockResolvedValue({
      goals: { synced: 5, errors: 0 },
      feedback: { synced: 2, errors: 0 },
      kpis: { synced: 1, errors: 0 },
      learnings: { synced: 3, errors: 0 },
      duration: 42,
    });

    await syncCommand({ postgres: true });

    expect(mockSyncAllCycleData).toHaveBeenCalled();
  });

  it('handles postgres unavailability gracefully', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git fetch')) return '';
      if (typeof cmd === 'string' && cmd.includes('git status')) return '';
      if (typeof cmd === 'string' && cmd.includes('git log')) return '';
      return '';
    });

    mockIsPostgresAvailable.mockResolvedValue(false);

    await syncCommand({ postgres: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('Postgres not available');
  });

  it('dimensions sync fetches squad definitions', async () => {
    mockReaddirSync.mockReturnValue([]);

    await syncCommand({ dimensions: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('sync --dimensions');
  });

  it('learnings sync scans memory directory', async () => {
    mockFindMemoryDir.mockReturnValue('/fake/.agents/memory');
    mockReaddirSync.mockReturnValue([]);

    await syncCommand({ learnings: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('sync --learnings');
  });

  it('auto-learn generates learnings from commits', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git log')) {
        return 'abc1234|2026-03-07T10:00:00Z|feat(cli): add new agent feature\nsrc/commands/run.ts\n\ndef5678|2026-03-07T11:00:00Z|feat(cli): improve parallel execution\nsrc/lib/parallel.ts';
      }
      return '';
    });

    await syncCommand({ autoLearn: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('auto-learn');
  });
});
