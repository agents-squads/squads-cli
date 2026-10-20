import { describe, it, expect } from 'vitest';
import { deriveLifecycleTimings, type PersistedExecEvent } from '../../src/lib/exec-events.js';

function line(seq: number, ts: string, event: PersistedExecEvent['event']): PersistedExecEvent {
  return { schema_version: 1, v: 1, runId: 'run_1', seq, ts, event };
}

describe('deriveLifecycleTimings (#1355)', () => {
  it('extracts dispatchedAt, firstCommitAt, prOpenedAt and endedAt from events', () => {
    const events: PersistedExecEvent[] = [
      line(0, '2026-10-20T10:00:00.000Z', { type: 'run_start', squad: 'demo', mode: 'foreground', model: 'deepseek', role: '', startedAt: '2026-10-20T10:00:00.000Z' }),
      line(1, '2026-10-20T10:01:00.000Z', { type: 'artifact', kind: 'commit', ref: 'abc' }),
      line(2, '2026-10-20T10:02:00.000Z', { type: 'artifact', kind: 'pr', ref: 'https://github.com/x/y/pull/1' }),
      line(3, '2026-10-20T10:03:00.000Z', { type: 'run_end', ok: true, durationMs: 180000, totalUsage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costEst: 0 } }),
    ];
    expect(deriveLifecycleTimings(events)).toEqual({
      dispatchedAt: '2026-10-20T10:00:00.000Z',
      firstCommitAt: '2026-10-20T10:01:00.000Z',
      prOpenedAt: '2026-10-20T10:02:00.000Z',
      endedAt: '2026-10-20T10:03:00.000Z',
    });
  });

  it('keeps the FIRST commit/pr and fills gate/review timings when #1354 events arrive', () => {
    const events: PersistedExecEvent[] = [
      line(0, '2026-10-20T10:00:00.000Z', { type: 'run_start', squad: 'demo', mode: 'foreground', model: 'm', role: '', startedAt: '2026-10-20T10:00:00.000Z' }),
      line(1, '2026-10-20T10:01:00.000Z', { type: 'artifact', kind: 'commit', ref: 'a' }),
      line(2, '2026-10-20T10:05:00.000Z', { type: 'artifact', kind: 'commit', ref: 'b' }),
      // #1354 gate_result / review_verdict — read forward-compatibly.
      line(3, '2026-10-20T10:06:00.000Z', { type: 'gate_result', ok: true, newFailures: [], tests: '1/1' } as unknown as PersistedExecEvent['event']),
      line(4, '2026-10-20T10:07:00.000Z', { type: 'review_verdict', pr: '1', verdict: 'PASS', findings: 0 } as unknown as PersistedExecEvent['event']),
      line(5, '2026-10-20T10:08:00.000Z', { type: 'run_end', ok: true, durationMs: 1, totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEst: 0 } }),
    ];
    expect(deriveLifecycleTimings(events)).toEqual({
      dispatchedAt: '2026-10-20T10:00:00.000Z',
      firstCommitAt: '2026-10-20T10:01:00.000Z',
      gatedAt: '2026-10-20T10:06:00.000Z',
      verdictAt: '2026-10-20T10:07:00.000Z',
      endedAt: '2026-10-20T10:08:00.000Z',
    });
  });

  it('returns an empty timeline when no lifecycle events are present', () => {
    expect(deriveLifecycleTimings([])).toEqual({});
  });
});
