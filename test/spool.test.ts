import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  buildSpoolWriterShell,
  reconcileDetachedRuns,
  spoolDir,
  type SpoolRecord,
} from '../src/lib/spool.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-spool-'));
  mkdirSync(join(root, '.agents', 'observability'), { recursive: true });
  mkdirSync(join(root, '.agents', 'squads'), { recursive: true }); // findProjectRoot requires it
  // reconcile writes via logObservability/updateExecutionStatus which resolve
  // the project root from cwd
  vi.spyOn(process, 'cwd').mockReturnValue(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function writeSpoolFile(overrides: Partial<SpoolRecord> = {}): string {
  const record: SpoolRecord = {
    execId: 'exec_test_abc123',
    squad: 'research',
    agent: 'housekeeper',
    provider: 'deepseek',
    model: 'deepseek-chat',
    trigger: 'scheduled',
    logFile: join(root, 'run.log'),
    startEpoch: 1_700_000_000,
    endEpoch: 1_700_000_042,
    exitCode: 0,
    harvest: 'merged',
    ...overrides,
  };
  const dir = spoolDir(root);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${record.execId}.json`);
  writeFileSync(path, JSON.stringify(record));
  return path;
}

function readExecutionsJsonl(): Array<Record<string, unknown>> {
  const p = join(root, '.agents', 'observability', 'executions.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('buildSpoolWriterShell', () => {
  it('produces a shell snippet that writes a valid done-file atomically', () => {
    const snippet = buildSpoolWriterShell({
      obsRoot: root,
      execId: 'exec_shell_1',
      squad: 'cli',
      agent: 'worker',
      provider: 'deepseek',
      model: 'deepseek-chat',
      trigger: 'manual',
      logFile: '/tmp/x.log',
    });
    // Simulate the wrapper: EXIT/START set, then the snippet runs.
    execSync(`EXIT=0; START=1700000000; HARVEST=merged; true ${snippet}`, { shell: '/bin/sh' });
    const file = join(spoolDir(root), 'exec_shell_1.json');
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    expect(parsed).toMatchObject({
      execId: 'exec_shell_1',
      squad: 'cli',
      provider: 'deepseek',
      startEpoch: 1_700_000_000,
      exitCode: 0,
      harvest: 'merged',
    });
    expect(parsed.endEpoch).toBeGreaterThan(0);
    // no tmp leftovers
    expect(readdirSync(spoolDir(root)).filter((f) => f.startsWith('.tmp'))).toEqual([]);
  });

  it('sanitizes the execId for the done-file name and embedded value', () => {
    const snippet = buildSpoolWriterShell({
      obsRoot: root,
      execId: "exec'; touch /tmp/pwned; 'x_1",
      squad: 's',
      agent: 'a',
      provider: 'deepseek',
      model: '',
      trigger: 'manual',
      logFile: '/tmp/x.log',
    });
    expect(snippet).toContain('exectouchtmppwnedx_1.json');
    expect(snippet).not.toContain("'exec';");
  });
});

describe('reconcileDetachedRuns', () => {
  it('turns a provider done-file into an ObservabilityRecord with parsed usage', () => {
    writeFileSync(join(root, 'run.log'), 'noise\nTokens: 21k sent, 740 received. Cost: $0.0063 message, $0.0063 session.\n');
    writeSpoolFile();
    const n = reconcileDetachedRuns(root);
    expect(n).toBe(1);
    const records = readExecutionsJsonl();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: 'exec_test_abc123',
      squad: 'research',
      agent: 'housekeeper',
      provider: 'deepseek',
      model: 'deepseek-chat',
      status: 'completed',
      input_tokens: 21000,
      output_tokens: 740,
      duration_ms: 42_000,
    });
    // done-file consumed
    expect(readdirSync(spoolDir(root))).toEqual([]);
  });

  it('records failed status + error for nonzero exit codes', () => {
    writeFileSync(join(root, 'run.log'), 'boom\n');
    writeSpoolFile({ execId: 'exec_fail_1', exitCode: 7 });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('failed');
    expect(String(rec.error)).toContain('code 7');
  });

  it('is idempotent and silent on an empty/missing spool', () => {
    expect(reconcileDetachedRuns(root)).toBe(0);
    writeSpoolFile();
    writeFileSync(join(root, 'run.log'), '');
    expect(reconcileDetachedRuns(root)).toBe(1);
    expect(reconcileDetachedRuns(root)).toBe(0);
    expect(readExecutionsJsonl()).toHaveLength(1);
  });

  it('quarantines malformed done-files without breaking the sweep', () => {
    const dir = spoolDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), '{not json');
    writeFileSync(join(root, 'run.log'), 'Tokens: 1k sent, 10 received. Cost: $0.001 message, $0.001 session.\n');
    writeSpoolFile({ execId: 'exec_good_1' });
    const n = reconcileDetachedRuns(root);
    expect(n).toBe(1);
    expect(readExecutionsJsonl()).toHaveLength(1);
    expect(existsSync(join(dir, 'broken.json'))).toBe(false);
  });
});
