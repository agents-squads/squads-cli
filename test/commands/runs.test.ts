import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

vi.mock('../../src/lib/run-utils.js', () => ({
  getProjectRoot: vi.fn(() => process.cwd()),
}));

vi.mock('../../src/lib/execution-engine.js', () => ({
  resolveOwnedRepoRoots: vi.fn((projectRoot: string) => [projectRoot]),
  harvestProviderWork: vi.fn(async () => ({ outcome: 'merged' })),
}));

// Wrap the real sweep so one test can make it throw without losing the
// behaviour every other test relies on.
vi.mock('../../src/lib/spool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/spool.js')>();
  return { ...actual, reconcileDetachedRuns: vi.fn(actual.reconcileDetachedRuns) };
});

import { runsCommand, annotateRunCommand } from '../../src/commands/runs.js';
import { listDetachedRuns } from '../../src/lib/runs-inventory.js';
import { reconcileDetachedRuns } from '../../src/lib/spool.js';

let root: string;

function writePidFile(squad: string, agent: string, ts: number, pid: number): string {
  const dir = join(root, '.agents', 'logs', squad);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${agent}-${ts}.pid`);
  writeFileSync(p, String(pid));
  return p;
}

function writeLogFile(squad: string, agent: string, ts: number, content: string): string {
  const dir = join(root, '.agents', 'logs', squad);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${agent}-${ts}.log`);
  writeFileSync(p, content);
  return p;
}

/**
 * A PID guaranteed to have already exited by the time it's returned —
 * spawnSync blocks until the child is fully reaped, so there's no race with
 * isAlive() and no dependency on a real live process (regression for CI
 * flakiness: a detached `spawn` + timeout races isAlive checks and is
 * inherently non-deterministic under CI scheduling).
 */
function deadPid(): number {
  const result = spawnSync('sh', ['-c', 'exit 0']);
  return result.pid!;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-runs-test-'));
  mkdirSync(join(root, '.agents', 'squads'), { recursive: true });
  mkdirSync(join(root, '.agents', 'observability'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('runsCommand reconcile failures (#1321 F4)', () => {
  function withDebug(value: string | undefined): () => void {
    const prev = process.env.DEBUG;
    if (value === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = value;
    return () => {
      if (prev === undefined) delete process.env.DEBUG;
      else process.env.DEBUG = prev;
    };
  }

  it('reports a throwing reconcile on stderr when DEBUG is set', async () => {
    vi.mocked(reconcileDetachedRuns).mockImplementationOnce(() => { throw new Error('spool unreadable'); });
    const restoreEnv = withDebug('1');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let logged = '';
    try {
      await runsCommand({ json: true });
      logged = errSpy.mock.calls.flat().join(' ');
    } finally {
      restoreEnv();
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
    expect(logged).toContain('spool reconcile');
    expect(logged).toContain('spool unreadable');
  });

  it('stays silent when DEBUG is not set (stdout stays parseable)', async () => {
    vi.mocked(reconcileDetachedRuns).mockImplementationOnce(() => { throw new Error('spool unreadable'); });
    const restoreEnv = withDebug(undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let calls = -1;
    try {
      await runsCommand({ json: true });
      calls = errSpy.mock.calls.length;
    } finally {
      restoreEnv();
      errSpy.mockRestore();
      outSpy.mockRestore();
    }
    expect(calls).toBe(0);
  });
});

describe('runsCommand --wait', () => {
  it('exits with error when no live runs exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(runsCommand({ wait: true })).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('exits with error when specified run id does not exist', async () => {
    // Create a live run
    const ts = Date.now();
    writePidFile('research', 'housekeeper', ts, process.pid);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(runsCommand({ wait: 'nonexistent' })).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('outputs JSON format when requested and run has completed (ended-run path: dead pid + log trail on disk)', async () => {
    // pid file points at an already-dead PID with a log trail on disk — this
    // exercises the "not live but has a trace" path in waitRun, which
    // reports the ended run's summary from the log instead of erroring.
    const ts = Date.now();
    const pidFile = writePidFile('research', 'housekeeper', ts, deadPid());

    // Write a log file with a completed result
    const logContent = JSON.stringify({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 }
    });
    writeFileSync(pidFile.replace('.pid', '.log'), logContent);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runsCommand({ wait: 'research/housekeeper', json: true });

    expect(writeSpy).toHaveBeenCalled();
    const calls = writeSpy.mock.calls;
    // Find the JSON line (skip empty lines and formatting)
    const jsonLine = calls.map(c => String(c[0])).find(line => line.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine!);
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('duration_s');
    expect(parsed).toHaveProperty('denials');

    writeSpy.mockRestore();
  });

  it('counts permission denials correctly', async () => {
    // pid file points at an already-dead PID with a log trail on disk (see
    // deadPid() note above — no live-process dependency needed here).
    const ts = Date.now();
    const pidFile = writePidFile('research', 'housekeeper', ts, deadPid());

    // Write a log file with permission denials in proper stream-json format
    const denial1 = JSON.stringify({
      type: 'user',
      content: [
        {
          type: 'tool_result',
          content: 'Error: Permission denied: haven\'t granted it yet to write to file.txt',
          tool_use_id: 'toolu_001',
          is_error: true
        }
      ]
    });

    const denial2 = JSON.stringify({
      type: 'user',
      content: [
        {
          type: 'tool_result',
          content: 'Error: haven\'t granted it yet - operation blocked',
          tool_use_id: 'toolu_002',
          is_error: true
        }
      ]
    });

    const logContent = `${denial1}\n${denial2}\n${JSON.stringify({ type: 'result', stop_reason: 'end_turn' })}\n`;
    writeFileSync(pidFile.replace('.pid', '.log'), logContent);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runsCommand({ wait: 'research/housekeeper', json: true });

    const calls = writeSpy.mock.calls;
    // Find the JSON line
    const jsonLine = calls.map(c => String(c[0])).find(line => line.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine!);
    expect(parsed.denials).toBe(2);

    writeSpy.mockRestore();
  });

  it('does not count denial phrase in task prompt or plan text (regression for #1114)', async () => {
    // pid file points at an already-dead PID with a log trail on disk (see
    // deadPid() note above — no live-process dependency needed here).
    const ts = Date.now();
    const pidFile = writePidFile('research', 'housekeeper', ts, deadPid());

    // Write a log file where the task prompt contains the denial phrase
    // but no actual tool_result denials occur
    const messageWithPhrase = JSON.stringify({
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Task: Fix the permissions issue - the system says "haven\'t granted it yet" when writing files'
        }
      ]
    });

    const planWithPhrase = JSON.stringify({
      type: 'user',
      content: [
        {
          type: 'text',
          text: 'Plan: Investigate why haven\'t granted it yet errors appear in logs'
        }
      ]
    });

    const successfulToolResult = JSON.stringify({
      type: 'user',
      content: [
        {
          type: 'tool_result',
          content: 'Successfully read file.txt',
          tool_use_id: 'toolu_001',
          is_error: false
        }
      ]
    });

    const logContent = `${messageWithPhrase}\n${planWithPhrase}\n${successfulToolResult}\n${JSON.stringify({ type: 'result', stop_reason: 'end_turn' })}\n`;
    writeFileSync(pidFile.replace('.pid', '.log'), logContent);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runsCommand({ wait: 'research/housekeeper', json: true });

    const calls = writeSpy.mock.calls;
    // Find the JSON line
    const jsonLine = calls.map(c => String(c[0])).find(line => line.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine!);
    // Should count 0 denials since the phrase only appears in prompt/plan text, not in tool_result blocks
    expect(parsed.denials).toBe(0);

    writeSpy.mockRestore();
  });
});

describe('annotateRunCommand --verdict validation (cli#1354 review F1)', () => {
  const COMMIT = 'abc123def456';

  function writeArtifactCommitEvent(runId: string): void {
    const dir = join(root, '.agents', 'observability', 'events');
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      schema_version: 1,
      v: 2,
      runId,
      seq: 0,
      ts: '2026-10-20T00:00:00.000Z',
      event: { type: 'artifact', kind: 'commit', ref: `commit ${COMMIT}` },
    });
    writeFileSync(join(dir, `${runId}.jsonl`), `${line}\n`);
  }

  function exitError(): never {
    throw new Error('process.exit');
  }

  function capturedStdout(spy: ReturnType<typeof vi.spyOn>): string {
    return spy.mock.calls.map((c) => String(c[0])).join('');
  }

  it('rejects a non-PASS/FAIL verdict with a JSON error and exit 1', async () => {
    writeArtifactCommitEvent('run1');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(exitError);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        annotateRunCommand({ commit: COMMIT, verdict: 'MAYBE', findings: '1', json: true })
      ).rejects.toThrow('process.exit');
      const out = capturedStdout(outSpy);
      expect(out).toContain('"ok": false');
      expect(out).toContain('--verdict must be PASS or FAIL');
      expect(out).toContain('MAYBE');
    } finally {
      exitSpy.mockRestore();
      outSpy.mockRestore();
    }
  });

  it('rejects a non-PASS/FAIL verdict with a clear text error and exit 1', async () => {
    writeArtifactCommitEvent('run1');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(exitError);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        annotateRunCommand({ commit: COMMIT, verdict: 'yes', findings: '1' })
      ).rejects.toThrow('process.exit');
      const out = capturedStdout(outSpy);
      expect(out).toContain('--verdict must be PASS or FAIL');
      expect(out).toContain('yes');
    } finally {
      exitSpy.mockRestore();
      outSpy.mockRestore();
    }
  });

  it('upper-cases an accepted lower-case verdict when appending the event', async () => {
    writeArtifactCommitEvent('run1');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(exitError);
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await annotateRunCommand({ commit: COMMIT, verdict: 'pass', findings: '2', json: true });
      expect(exitSpy).not.toHaveBeenCalled();

      const file = readFileSync(join(root, '.agents', 'observability', 'events', 'run1.jsonl'), 'utf8');
      const lines = file.trim().split('\n');
      expect(lines.length).toBe(2);
      const appended = JSON.parse(lines[1]);
      expect(appended.event.type).toBe('review_verdict');
      expect(appended.event.verdict).toBe('PASS');
    } finally {
      exitSpy.mockRestore();
      outSpy.mockRestore();
    }
  });
});
