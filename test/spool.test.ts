import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import {
  buildSpoolWriterShell,
  buildWatchdogShell,
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

describe('buildWatchdogShell (#450 D3)', () => {
  it('reaps a hung executor at the deadline, flag set, wrapper survives', () => {
    const flag = join(root, 'run.timeout');
    const out = join(root, 'after.txt');
    const snippet = buildWatchdogShell('sleep 30 > /dev/null 2>&1', 1, flag);
    const t0 = Date.now();
    // The wrapper must SURVIVE the reaping to run what follows (harvest/spool).
    execSync(`${snippet}; echo "exit=$EXIT" > '${out}'`, { shell: '/bin/sh' });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(10_000); // not the full sleep 30
    expect(existsSync(flag)).toBe(true);
    const after = readFileSync(out, 'utf8');
    expect(after).toMatch(/exit=(143|137)/);
  });

  it('fast executor finishes untouched — no flag, exit 0, no lingering wait', () => {
    const flag = join(root, 'fast.timeout');
    const out = join(root, 'fast.txt');
    const snippet = buildWatchdogShell('true', 30, flag);
    const t0 = Date.now();
    execSync(`${snippet}; echo "exit=$EXIT" > '${out}'`, { shell: '/bin/sh' });
    expect(Date.now() - t0).toBeLessThan(5_000); // watchdog killed, not awaited for 30s
    expect(existsSync(flag)).toBe(false);
    expect(readFileSync(out, 'utf8')).toContain('exit=0');
  });

  it('spool snippet records timedOut from the flag file and removes it', () => {
    const flag = join(root, 'spooled.timeout');
    writeFileSync(flag, '');
    const snippet = buildSpoolWriterShell({
      obsRoot: root,
      execId: 'exec_timeout_1',
      squad: 's',
      agent: 'a',
      provider: 'deepseek',
      model: 'deepseek-chat',
      trigger: 'scheduled',
      logFile: join(root, 'run.log'),
      timeoutFlag: flag,
    });
    execSync(`EXIT=143; START=1700000000; true ${snippet}`, { shell: '/bin/sh' });
    const parsed = JSON.parse(readFileSync(join(spoolDir(root), 'exec_timeout_1.json'), 'utf8'));
    expect(parsed.timedOut).toBe(true);
    expect(parsed.exitCode).toBe(143);
    expect(existsSync(flag)).toBe(false); // flag consumed
  });

  it('reconcile maps a timedOut done-file to status timeout', () => {
    writeFileSync(join(root, 'run.log'), 'Tokens: 5k sent, 100 received. Cost: $0.002 message, $0.002 session.\n');
    writeSpoolFile({ execId: 'exec_to_2', exitCode: 143, timedOut: true });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('timeout');
    expect(String(rec.error)).toContain('watchdog');
  });
});

// ── #857: detached-claude usage attribution ──────────────────────────

describe('session-id attribution (#857)', () => {
  let home: string;
  let oldHome: string | undefined;

  const SESSION_ID = '11111111-2222-3333-4444-555555555555';

  function writeSessionFile(projDir: string, name: string, inputTokens: number, outputTokens: number): string {
    const dir = join(home, '.claude', 'projects', projDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-haiku-4-5', usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
    });
    writeFileSync(path, `${line}\n`);
    return path;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'squads-home-'));
    oldHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('buildSpoolWriterShell embeds the (sanitized) session id in the done-file', () => {
    const snippet = buildSpoolWriterShell({
      obsRoot: root,
      execId: 'exec_sid_1',
      squad: 's',
      agent: 'a',
      provider: 'anthropic',
      model: 'haiku',
      trigger: 'scheduled',
      logFile: '/tmp/x.log',
      sessionId: `${SESSION_ID}'; touch /tmp/pwned; '`,
    });
    execSync(`EXIT=0; START=1700000000; true ${snippet}`, { shell: '/bin/sh' });
    const parsed = JSON.parse(readFileSync(join(spoolDir(root), 'exec_sid_1.json'), 'utf8'));
    expect(parsed.sessionId).toBe(`${SESSION_ID}touchtmppwned`);
    expect(existsSync('/tmp/pwned')).toBe(false);
  });

  it('reconcile attributes exactly the pinned session, not a bigger concurrent one', () => {
    writeSessionFile('proj-run', SESSION_ID, 100, 50);
    // A concurrent giant session (e.g. interactive) — newer mtime, way bigger
    writeSessionFile('proj-interactive', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 118_000, 9_000);

    writeSpoolFile({ execId: 'exec_sid_2', provider: 'anthropic', model: 'haiku', sessionId: SESSION_ID });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.input_tokens).toBe(100);
    expect(rec.output_tokens).toBe(50);
    expect(rec.model).toBe('claude-haiku-4-5');
  });

  it('legacy records (no sessionId) bound the mtime window by endEpoch', () => {
    // Session file modified NOW — far after the legacy run's endEpoch
    // (1.7e9 ≈ 2023). The old global newest-after-start scan would grab it.
    writeSessionFile('proj-later', 'ffffffff-1111-2222-3333-444444444444', 118_000, 9_000);

    writeSpoolFile({ execId: 'exec_sid_3', provider: 'anthropic', model: 'haiku' });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.input_tokens).toBe(0);
    expect(rec.output_tokens).toBe(0);
  });
});

// ── #1129: session_id stamped on the reconciled ledger row ──────────────

describe('session_id on the ledger row (#1129)', () => {
  let home: string;
  let oldHome: string | undefined;

  const SESSION_ID = '99999999-8888-7777-6666-555555555555';

  function writeSessionFile(projDir: string, name: string, inputTokens: number, outputTokens: number): string {
    const dir = join(home, '.claude', 'projects', projDir);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: 'claude-haiku-4-5', usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
    });
    writeFileSync(path, `${line}\n`);
    return path;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'squads-home-'));
    oldHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('persists the id the wrapper was launched with (--session-id, #857) into the ledger row', () => {
    writeSessionFile('proj-run', SESSION_ID, 100, 50);
    writeSpoolFile({ execId: 'exec_stamp_1', provider: 'anthropic', model: 'haiku', sessionId: SESSION_ID });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.session_id).toBe(SESSION_ID);
  });

  it('falls back to the mtime-discovered session file basename when no explicit id was pinned', () => {
    const startEpoch = Math.floor(Date.now() / 1000) - 10;
    const endEpoch = Math.floor(Date.now() / 1000) + 10;
    writeSessionFile('proj-run', SESSION_ID, 10, 5);
    writeSpoolFile({ execId: 'exec_stamp_2', provider: 'anthropic', model: 'haiku', startEpoch, endEpoch });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.session_id).toBe(SESSION_ID);
  });

  it('leaves session_id absent for non-Claude provider runs', () => {
    writeFileSync(join(root, 'run.log'), 'Tokens: 1k sent, 10 received. Cost: $0.001 message, $0.001 session.\n');
    writeSpoolFile({ execId: 'exec_stamp_3', provider: 'deepseek', model: 'deepseek-chat' });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.session_id).toBeUndefined();
  });
});

// ── #902: exec-event normalization + outcomes for detached claude runs ──

describe('stream-json log normalization (#902)', () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    // Hermetic HOME so captureSessionUsage finds no session JSONL and the
    // stream result event is exercised as the usage fallback.
    home = mkdtempSync(join(tmpdir(), 'squads-home-'));
    oldHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeStreamJsonLog(): void {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git add -A && git commit -m "feat: x"' } },
        { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/repo/x.ts', content: 'abc' } },
      ], model: 'claude-haiku-4-5' } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done', is_error: false,
        total_cost_usd: 0.05, num_turns: 2, model: 'claude-haiku-4-5',
        usage: { input_tokens: 500, output_tokens: 80, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 } }),
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
  }

  it('detached claude run gets outcomes + stream-usage fallback + a normalized events file', () => {
    writeStreamJsonLog();
    writeSpoolFile({ execId: 'exec_ev_1', provider: 'anthropic', model: 'haiku' });
    const n = reconcileDetachedRuns(root);
    expect(n).toBe(1);

    const [rec] = readExecutionsJsonl();
    // Usage fell back to the stream's terminal result event (no session JSONL).
    expect(rec.input_tokens).toBe(500);
    expect(rec.output_tokens).toBe(80);
    expect(rec.cache_read_tokens).toBe(2000);
    expect(rec.cache_write_tokens).toBe(100);
    expect(rec.model).toBe('claude-haiku-4-5');
    // Outcomes previously always zero on detached runs — now real.
    expect(rec.actions).toBe(2);
    expect(rec.files_edited).toBe(1);
    expect(rec.commits).toBe(1);

    // The raw provider log was normalized into the run's events file.
    const eventsPath = join(root, '.agents', 'observability', 'events', 'exec_ev_1.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const types = events.map((e) => e.event.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('artifact');
    expect(types).toContain('file_write');
    expect(types).toContain('token_usage');
    expect(types[types.length - 1]).toBe('run_end');
    expect(events.every((e) => e.runId === 'exec_ev_1')).toBe(true);
  });

  it('legacy plain-text logs reconcile as before — no events file fabricated', () => {
    writeFileSync(join(root, 'run.log'), 'plain old buffered output\n');
    writeSpoolFile({ execId: 'exec_ev_legacy', provider: 'anthropic', model: 'haiku' });
    expect(reconcileDetachedRuns(root)).toBe(1);
    const [rec] = readExecutionsJsonl();
    expect(rec.input_tokens).toBe(0);
    expect(existsSync(join(root, '.agents', 'observability', 'events', 'exec_ev_legacy.jsonl'))).toBe(false);
  });
});
