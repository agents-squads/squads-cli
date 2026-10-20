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

// ── #1321: reconcile terminal state from the row's OWN log ────────────────

describe('reconcileOrphanedRuns — evidence from the log (#1321)', () => {
  const DEAD_PID = 2 ** 24; // safely dead on macOS and Linux

  function writeRunLog(ts: number, content: string): void {
    const dir = join(state.root, '.agents', 'logs', 'cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `solver-${ts}.log`), content);
  }

  it('a dead pid whose log shows a provider error becomes failed with the typed cause', async () => {
    const ts = Date.now();
    writeRows([{ ts: new Date(ts).toISOString(), id: 'exec_1321_quota', status: 'running', pid: DEAD_PID }]);
    writeRunLog(ts, 'error: failed to run prompt: provider.api_error: 429 exceeded your current quota\n');

    const folded = reconcileOrphanedRuns();
    const rec = folded.find(r => r.id === 'exec_1321_quota')!;
    expect(rec.status).toBe('failed');
    expect(rec.failure_cause).toBe('quota_exhausted');
    expect(String(rec.error)).toContain('429');

    const refolded = foldExecutions(queryExecutions()).find(r => r.id === 'exec_1321_quota')!;
    expect(refolded.status).toBe('failed');
    expect(refolded.failure_cause).toBe('quota_exhausted');
    // The API mirror is fire-and-forget via a lazy import.
    await vi.waitFor(() => {
      expect(reportExecutionComplete).toHaveBeenCalledWith('exec_1321_quota', 'failed', expect.any(Object));
    });
  });

  it('a process that dies within seconds on an error line is failed, never orphaned', () => {
    const ts = Date.now() - 2_000;
    writeRows([{ ts: new Date(ts).toISOString(), id: 'exec_1321_fast', status: 'running', pid: DEAD_PID }]);
    writeRunLog(ts, 'error: failed to run prompt: provider.api_error: 429 exceeded your current quota (fast death)\n');

    const rec = reconcileOrphanedRuns().find(r => r.id === 'exec_1321_fast')!;
    expect(rec.status).toBe('failed');
    expect(rec.failure_cause).toBe('quota_exhausted');
  });

  it('a live pid stays running even when its log already carries an error line', () => {
    const ts = Date.now();
    writeRows([{ ts: new Date(ts).toISOString(), id: 'exec_1321_live', status: 'running', pid: process.pid }]);
    writeRunLog(ts, 'error: failed to run prompt: provider.api_error: 429 transient\n');

    const rec = reconcileOrphanedRuns().find(r => r.id === 'exec_1321_live')!;
    expect(rec.status).toBe('running');
    expect(reportExecutionComplete).not.toHaveBeenCalledWith('exec_1321_live', expect.anything(), expect.anything());
  });

  it('orphans a dead row only when its log shows no cause', () => {
    const ts = Date.now();
    writeRows([{ ts: new Date(ts).toISOString(), id: 'exec_1321_silent', status: 'running', pid: DEAD_PID }]);
    writeRunLog(ts, 'ordinary output, then the process vanished\n');

    const rec = reconcileOrphanedRuns().find(r => r.id === 'exec_1321_silent')!;
    expect(rec.status).toBe('orphaned');
    expect(rec.failure_cause).toBe('orphaned');
  });
});
