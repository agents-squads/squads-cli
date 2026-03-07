import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => '[]'),
  spawn: vi.fn(() => ({
    pid: 12345,
    on: vi.fn(),
    kill: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
  })),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  listSquads: vi.fn(() => []),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(() => null),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  colors: { dim: '', cyan: '', red: '', yellow: '', green: '', white: '', purple: '' },
  bold: '',
  RESET: '',
  icons: { success: '+', error: 'x', warning: '!', active: '*', running: '>', progress: '...' },
  writeLine: vi.fn(),
}));

import { execSync } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { findSquadsDir, listSquads } from '../../src/lib/squad-parser.js';
import { writeLine } from '../../src/lib/terminal.js';
import { daemonCommand } from '../../src/commands/daemon.js';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockListSquads = vi.mocked(listSquads);

describe('daemonCommand', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockListSquads.mockReturnValue(['cli', 'website']);
    mockExistsSync.mockReturnValue(false);
    // Reset execSync to default — prevents implementation leak from prior tests
    mockExecSync.mockReturnValue('[]');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('runs single cycle with --once flag', async () => {
    await daemonCommand({ once: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('squads daemon');
    expect(calls).toContain('Single cycle complete');
  });

  it('displays configuration in header', async () => {
    await daemonCommand({ once: true, interval: '15', parallel: '3', budget: '20' });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('15m');
    expect(calls).toContain('3');
    expect(calls).toContain('$20');
  });

  it('shows DRY RUN indicator when dry-run enabled', async () => {
    await daemonCommand({ once: true, dryRun: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('DRY RUN');
  });

  it('reports no squads need attention when no repos match', async () => {
    mockListSquads.mockReturnValue(['custom-squad']); // No matching repo in SQUAD_REPOS

    await daemonCommand({ once: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('No squads need attention');
  });

  it('scores squads with open issues', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('issue list')) {
        return JSON.stringify([
          { number: 1, title: 'Test issue', labels: [{ name: 'P1' }] },
        ]);
      }
      if (typeof cmd === 'string' && cmd.includes('pr list')) {
        return '[]';
      }
      return '[]';
    });

    await daemonCommand({ once: true, dryRun: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('Signals');
  });

  it('respects daily budget limit', async () => {
    // Simulate state with budget exceeded
    mockExistsSync.mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('state.json')) return true;
      return false;
    });

    const { readFileSync } = await import('fs');
    vi.mocked(readFileSync).mockImplementation((path) => {
      if (typeof path === 'string' && path.includes('state.json')) {
        return JSON.stringify({
          lastCycle: '',
          dailyCost: 100,
          dailyCostDate: new Date().toISOString().slice(0, 10),
          recentRuns: [],
          failCounts: {},
        });
      }
      return '';
    });

    await daemonCommand({ once: true, budget: '10' });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('Daily budget reached');
  });

  it('saves state after cycle', async () => {
    await daemonCommand({ once: true });

    expect(mockWriteFileSync).toHaveBeenCalled();
  });

  it('parses default options correctly', async () => {
    await daemonCommand({ once: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    // Default interval=30, parallel=2, budget=10
    expect(calls).toContain('30m');
    expect(calls).toContain('$10');
  });

  it('dry run shows what would dispatch without dispatching', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('issue list')) {
        return JSON.stringify([
          { number: 1, title: 'Fix bug', labels: [{ name: 'P0' }] },
        ]);
      }
      return '[]';
    });

    await daemonCommand({ once: true, dryRun: true });

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('DRY RUN');
    expect(calls).toContain('Would dispatch');
  });
});
