import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Inventory only needs two things from the engine; mocking them keeps these
// tests free of git fixtures (harvest itself is covered by harvest.test.ts).
vi.mock('../src/lib/execution-engine.js', () => ({
  resolveTargetRepoRoot: vi.fn((projectRoot: string) => projectRoot),
  harvestProviderWork: vi.fn(async () => ({ outcome: 'merged' })),
}));

import { listDetachedRuns, cleanStaleRuns, killDetachedRun } from '../src/lib/runs-inventory.js';
import { harvestProviderWork } from '../src/lib/execution-engine.js';

let root: string;

function deadPid(): number {
  // A real pid that is guaranteed dead: spawn something that exits instantly.
  const r = spawnSync('true');
  return r.pid!;
}

function writePidFile(squad: string, agent: string, ts: number, pid: number): string {
  const dir = join(root, '.agents', 'logs', squad);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${agent}-${ts}.pid`);
  writeFileSync(p, String(pid));
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-runs-'));
  mkdirSync(join(root, '.agents', 'squads'), { recursive: true });
  mkdirSync(join(root, '.agents', 'observability'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('listDetachedRuns', () => {
  it('classifies live and dead runs and parses identity from filenames', () => {
    writePidFile('research', 'housekeeper', 1700000000001, process.pid); // live (this test process)
    writePidFile('company', 'validator', 1700000000002, deadPid());
    const runs = listDetachedRuns(root);
    expect(runs).toHaveLength(2);
    const live = runs.find((r) => r.alive)!;
    expect(live).toMatchObject({ squad: 'research', agent: 'housekeeper', pid: process.pid });
    const dead = runs.find((r) => !r.alive)!;
    expect(dead).toMatchObject({ squad: 'company', agent: 'validator', startedAt: 1700000000002 });
    expect(dead.logFile.endsWith('validator-1700000000002.log')).toBe(true);
  });

  it('ignores malformed pid files and missing logs dirs', () => {
    const dir = join(root, '.agents', 'logs', 'x');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'not-a-run.pid'), 'garbage');
    expect(listDetachedRuns(root)).toEqual([]);
  });
});

describe('cleanStaleRuns', () => {
  it('removes a stale pid file without a worktree silently (no synthesized record)', async () => {
    writePidFile('research', 'housekeeper', 1700000000003, deadPid());
    const res = await cleanStaleRuns(root);
    expect(res.removedPidFiles).toBe(1);
    expect(res.salvaged).toEqual([]);
    expect(existsSync(join(root, '.agents', 'observability', 'executions.jsonl'))).toBe(false);
  });

  it('salvages a crashed run whose worktree survives: harvest + orphan record + pid cleanup', async () => {
    const ts = 1700000000004;
    const pidFile = writePidFile('research', 'housekeeper', ts, deadPid());
    mkdirSync(join(root, '..', '.worktrees', `research-housekeeper-${ts}`), { recursive: true });
    const res = await cleanStaleRuns(root);
    expect(vi.mocked(harvestProviderWork)).toHaveBeenCalledOnce();
    expect(res.salvaged).toEqual([{ squad: 'research', agent: 'housekeeper', outcome: 'merged' }]);
    expect(existsSync(pidFile)).toBe(false);
    const jsonl = readFileSync(join(root, '.agents', 'observability', 'executions.jsonl'), 'utf8');
    const rec = JSON.parse(jsonl.trim());
    expect(rec.status).toBe('failed');
    expect(rec.error).toContain('orphaned');
    expect(rec.error).toContain('merged');
    rmSync(join(root, '..', '.worktrees'), { recursive: true, force: true });
  });

  it('leaves live runs alone', async () => {
    const pidFile = writePidFile('research', 'housekeeper', 1700000000005, process.pid);
    const res = await cleanStaleRuns(root);
    expect(res.removedPidFiles).toBe(0);
    expect(existsSync(pidFile)).toBe(true);
  });
});

describe('killDetachedRun', () => {
  it('reports not-running for dead runs', () => {
    writePidFile('s', 'a', 1700000000006, deadPid());
    const run = listDetachedRuns(root)[0];
    expect(killDetachedRun(run).method).toBe('not-running');
  });

  it('TERMs the wrapper children first so the wrapper can finish', async () => {
    // Real wrapper-shaped process: sh parent with a sleep child.
    const wrapper = spawn('sh', ['-c', 'sleep 30 & wait $!'], { stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 300)); // let sh fork the sleep
    writePidFile('s', 'a', 1700000000007, wrapper.pid!);
    const run = listDetachedRuns(root).find((r) => r.pid === wrapper.pid)!;
    const res = killDetachedRun(run);
    expect(res.method).toBe('children-term');
    // child TERM'd → wait returns → wrapper exits on its own
    await new Promise<void>((resolve) => {
      wrapper.on('exit', () => resolve());
      setTimeout(() => { wrapper.kill('SIGKILL'); }, 5000); // safety net
    });
  });
});
