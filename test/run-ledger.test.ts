// Run-ledger semantics (cli#1142): the jsonl is an event log — a 'running'
// row at spawn, a terminal row at exit, current state = last row per id —
// and the orphan reaper is what makes "running" mean RUNNING. Before this,
// `squads status` counted 'running' lines in unreconciled per-agent markdown
// and reported 17 phantom runs while zero processes existed.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/lib/api-client.js', () => ({
  reportExecutionComplete: vi.fn().mockResolvedValue(true),
  reportExecutionStart: vi.fn().mockResolvedValue(null),
}));

// Pin the project root per-test instead of process.chdir: cwd is process-global,
// so chdir here races every other test file sharing the worker.
const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/lib/squad-parser.js', () => ({
  findProjectRoot: () => state.root,
}));

import {
  foldExecutions,
  logRunStarted,
  reconcileOrphanedRuns,
  queryExecutions,
  type ObservabilityRecord,
} from '../src/lib/observability.js';
import { reportExecutionComplete } from '../src/lib/api-client.js';

let root: string;

const LOG = () => join(root, '.agents', 'observability', 'executions.jsonl');

function writeRows(rows: Partial<ObservabilityRecord>[]): void {
  const base = {
    squad: 'cli', agent: 'solver', provider: 'anthropic', model: 'sonnet',
    trigger: 'manual', duration_ms: 0, input_tokens: 0, output_tokens: 0,
    cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, context_tokens: 0,
  };
  mkdirSync(join(root, '.agents', 'observability'), { recursive: true });
  writeFileSync(LOG(), rows.map(r => JSON.stringify({ ...base, ...r })).join('\n') + '\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-ledger-'));
  state.root = root;
  vi.mocked(reportExecutionComplete).mockClear();
});

describe('foldExecutions', () => {
  it('collapses a run to its LAST row — running then terminal reads terminal', () => {
    writeRows([
      { ts: '2026-07-16T10:00:00Z', id: 'exec_a', status: 'running', pid: process.pid },
      { ts: '2026-07-16T10:05:00Z', id: 'exec_a', status: 'completed', duration_ms: 300000 },
      { ts: '2026-07-16T10:06:00Z', id: 'exec_b', status: 'running', pid: process.pid },
    ]);
    const folded = foldExecutions(queryExecutions());
    expect(folded).toHaveLength(2);
    expect(folded.find(r => r.id === 'exec_a')?.status).toBe('completed');
    expect(folded.find(r => r.id === 'exec_b')?.status).toBe('running');
  });
});

describe('logRunStarted', () => {
  it('appends a running event with the pid the reaper will check', () => {
    logRunStarted({
      id: 'exec_start1', squad: 'cli', agent: 'solver',
      provider: 'glm', model: 'glm-4.7', trigger: 'manual', pid: 4242,
    });
    const rows = readFileSync(LOG(), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'exec_start1', status: 'running', pid: 4242, provider: 'glm' });
  });
});

describe('reconcileOrphanedRuns', () => {
  it('leaves a running row alone while its process is alive', () => {
    writeRows([{ ts: new Date().toISOString(), id: 'exec_live', status: 'running', pid: process.pid }]);
    const folded = reconcileOrphanedRuns();
    expect(folded.find(r => r.id === 'exec_live')?.status).toBe('running');
    expect(reportExecutionComplete).not.toHaveBeenCalled();
  });

  it('orphans a running row whose pid is gone, appends the terminal event, and mirrors to the API', () => {
    // Max pid on macOS is 99998, on Linux ~4M by default — 2**22+ is safely dead.
    writeRows([{ ts: new Date().toISOString(), id: 'exec_dead', status: 'running', pid: 2 ** 24 }]);
    const folded = reconcileOrphanedRuns();
    expect(folded.find(r => r.id === 'exec_dead')?.status).toBe('orphaned');

    // The event is persisted, not just returned: a re-read folds to orphaned.
    const refolded = foldExecutions(queryExecutions());
    expect(refolded.find(r => r.id === 'exec_dead')?.status).toBe('orphaned');
  });

  it('gives a pid-less running row 3h grace, then orphans it', () => {
    const fresh = new Date(Date.now() - 60 * 60 * 1000).toISOString();      // 1h old
    const stale = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();  // 4h old
    writeRows([
      { ts: fresh, id: 'exec_fresh', status: 'running' },
      { ts: stale, id: 'exec_stale', status: 'running' },
    ]);
    const folded = reconcileOrphanedRuns();
    expect(folded.find(r => r.id === 'exec_fresh')?.status).toBe('running');
    expect(folded.find(r => r.id === 'exec_stale')?.status).toBe('orphaned');
  });

  it('never touches terminal rows', () => {
    writeRows([
      { ts: '2026-07-16T09:00:00Z', id: 'exec_done', status: 'completed' },
      { ts: '2026-07-16T09:01:00Z', id: 'exec_bad', status: 'failed' },
    ]);
    const before = readFileSync(LOG(), 'utf-8');
    reconcileOrphanedRuns();
    expect(readFileSync(LOG(), 'utf-8')).toBe(before);
  });
});
