import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

vi.mock('../src/lib/api-client.js', () => ({
  reportExecutionComplete: vi.fn().mockResolvedValue(true),
}));

// #1147: a hook for one test to observe/intercept the exact readFileSync
// call spool.ts makes on a claimed done-file — used to inject a second,
// fully independent reconcile sweep at the precise moment a real race would
// land. `vi.hoisted` is required because `vi.mock` factories run before any
// module-scope `let` would otherwise be initialized.
const fsReadHook = vi.hoisted(() => ({ intercept: null as null | ((target: string) => void) }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const hook = fsReadHook.intercept;
      // Real read happens FIRST — the caller (sweep A) captures the content
      // exactly like a real process would before a concurrent sweep (B) can
      // touch the file. Only then do we let B race in, so pre-fix behavior
      // (no claim before read) is faithfully reproduced: A already has the
      // bytes in hand and will still append its own record even though B
      // deletes the file out from under it a moment later.
      const result = actual.readFileSync(...args);
      if (hook) {
        fsReadHook.intercept = null;
        hook(String(args[0]));
      }
      return result;
    },
  };
});

import {
  buildSpoolWriterShell,
  buildWatchdogShell,
  reconcileDetachedRuns,
  spoolDir,
  type SpoolRecord,
} from '../src/lib/spool.js';
import { reportExecutionComplete } from '../src/lib/api-client.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-spool-'));
  mkdirSync(join(root, '.agents', 'observability'), { recursive: true });
  mkdirSync(join(root, '.agents', 'squads'), { recursive: true }); // findProjectRoot requires it
  // reconcile writes via logObservability/updateExecutionStatus which resolve
  // the project root from cwd
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.mocked(reportExecutionComplete).mockClear();
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
    // deepseek runs the claude harness now (#1159): raw logs are stream-json.
    const resultLine = JSON.stringify({
      type: 'result', subtype: 'success', is_error: false,
      usage: { input_tokens: 21000, output_tokens: 740 }, model: 'deepseek-chat',
    });
    writeFileSync(join(root, 'run.log'), `noise\n${resultLine}\n`);
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

  it('claims each done-file atomically — two sweeps racing on the same file yield exactly one record (#1147)', () => {
    writeFileSync(join(root, 'run.log'), 'Tokens: 5k sent, 100 received. Cost: $0.002 message, $0.002 session.\n');
    writeSpoolFile({ execId: 'exec_race_1', exitCode: 143, timedOut: true });

    const dir = spoolDir(root);
    // Simulate two CLI processes (e.g. `squads status` and `squads usage`)
    // sweeping the spool at the same instant: sweep A is paused right as it
    // opens the done-file's content — the exact window where, pre-#1147, a
    // second sweep (B, a fully independent reconcileDetachedRuns() call)
    // could also see and process the same still-present done-file. Post-fix,
    // A has already claimed the file via an atomic rename before this read,
    // so B's own directory listing finds nothing left to claim.
    fsReadHook.intercept = (target) => {
      if (target.startsWith(dir) && target.endsWith('.json')) {
        reconcileDetachedRuns(root); // sweep B races in here
      }
    };

    const ingestedByA = reconcileDetachedRuns(root); // sweep A
    fsReadHook.intercept = null;

    const records = readExecutionsJsonl();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: 'exec_race_1', status: 'timeout' });
    // Exactly one sweep won the claim; the other ingested nothing for this entry.
    expect(ingestedByA).toBeLessThanOrEqual(1);
    expect(reportExecutionComplete).toHaveBeenCalledTimes(1);
    // No orphaned claim file left behind by the loser.
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
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
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 't1', content: '[main fe12ab3] feat: x\n 1 file changed, 2 insertions(+)' },
      ] } }),
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

  // cli#1175: provider parity. A non-Claude lane runs the SAME claude harness
  // (`claude --model glm-4.7 --output-format stream-json`), so its log is
  // stream-json and must get the SAME rich pipeline — events, outcomes, model,
  // cost — not the old usage-only non-anthropic branch that produced a black
  // box (0 events, unknown model). The glm result event carries model only via
  // modelUsage (no top-level `model`), so model is backfilled from the
  // assistant events; cost comes from total_cost_usd.
  function writeGlmStreamJsonLog(): void {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'g1', name: 'Bash', input: { command: 'git add -A && git commit -m "fix: y"' } },
        { type: 'tool_use', id: 'g2', name: 'Edit', input: { file_path: '/repo/y.ts', content: 'zz' } },
      ], model: 'glm-4.7' } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'g1', content: '[main ab12cd3] fix: y\n 1 file changed' },
      ] } }),
      // glm/deepseek terminal result: total_cost_usd + usage, but NO top-level
      // `model` (it lives in modelUsage) — the exact shape that made the board
      // show "unknown / unpriced".
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done', is_error: false,
        total_cost_usd: 1.52, num_turns: 3,
        usage: { input_tokens: 34590, output_tokens: 10612 },
        modelUsage: { 'glm-4.7': { inputTokens: 34590, outputTokens: 10612, costUSD: 1.52 } } }),
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
  }

  it('a non-Claude (glm) stream-json lane gets full observability parity', () => {
    writeGlmStreamJsonLog();
    writeSpoolFile({ execId: 'exec_glm_1', provider: 'glm', model: 'glm-4.7' });
    expect(reconcileDetachedRuns(root)).toBe(1);

    const [rec] = readExecutionsJsonl();
    expect(rec.provider).toBe('glm');
    expect(rec.model).toBe('glm-4.7');          // backfilled from assistant events (was "unknown")
    expect(rec.cost_usd).toBe(1.52);            // from total_cost_usd (was 0/unpriced)
    expect(rec.input_tokens).toBe(34590);
    expect(rec.output_tokens).toBe(10612);
    expect(rec.status).toBe('completed');
    expect(rec.actions).toBe(2);                // outcomes (was always 0)
    expect(rec.commits).toBe(1);
    expect(rec.files_edited).toBe(1);

    // The GLM run now has a normalized events file — the same stream the
    // Claude run gets. This is the black box being killed.
    const eventsPath = join(root, '.agents', 'observability', 'events', 'exec_glm_1.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const types = events.map((e) => e.event.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('artifact');
    expect(types).toContain('file_write');
    expect(types[types.length - 1]).toBe('run_end');
    expect(events.every((e) => e.provider === 'glm')).toBe(true);
  });

  it('a legacy non-stream-json provider log still uses the usage-only path (no events)', () => {
    // An aider-style plain-text log (no JSON) — no stream to normalize.
    writeFileSync(join(root, 'run.log'), 'aider: applied edit to y.ts\nTokens: 1000 sent, 200 received\n');
    writeSpoolFile({ execId: 'exec_glm_legacy', provider: 'glm', model: 'glm-4.7' });
    expect(reconcileDetachedRuns(root)).toBe(1);
    expect(existsSync(join(root, '.agents', 'observability', 'events', 'exec_glm_legacy.jsonl'))).toBe(false);
  });
});

// ── #1131: postmortem fields on the execution row (error/result.summary) ──

describe('claude terminal-state classification + result summary (#1131)', () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    // Hermetic HOME so captureSessionUsage finds no session JSONL and the
    // stream is exercised as the usage/status source.
    home = mkdtempSync(join(tmpdir(), 'squads-home-'));
    oldHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('marks a run failed when the terminal result reports is_error, even at exit 0', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: 'working on it' },
      ], model: 'claude-haiku-4-5' } }),
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'hit max turns', is_error: true,
        total_cost_usd: 0.02, num_turns: 25, model: 'claude-haiku-4-5',
        usage: { input_tokens: 100, output_tokens: 20 } }),
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
    writeSpoolFile({ execId: 'exec_is_error_1', provider: 'anthropic', model: 'haiku', exitCode: 0 });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('failed');
    expect(String(rec.error)).toContain('is_error');
  });

  it('marks a run failed when the stream never reaches a terminal result despite real activity (interrupted mid-response)', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo hi' } },
      ], model: 'claude-haiku-4-5' } }),
      // no terminal `result` line — connection dropped mid-turn
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
    writeSpoolFile({ execId: 'exec_stall_1', provider: 'anthropic', model: 'haiku', exitCode: 0 });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('failed');
    expect(String(rec.error)).toContain('interrupted');
  });

  it('leaves legacy plain-text (non-stream-json) logs completed — no false-positive stall', () => {
    writeFileSync(join(root, 'run.log'), 'plain old buffered output, not JSON at all\n');
    writeSpoolFile({ execId: 'exec_legacy_ok', provider: 'anthropic', model: 'haiku', exitCode: 0 });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('completed');
  });

  it('reports the agent final message as the API summary instead of the generic token line', () => {
    const lines = [
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Fixed the bug and opened PR #42.', is_error: false,
        total_cost_usd: 0.01, num_turns: 3, model: 'claude-haiku-4-5',
        usage: { input_tokens: 50, output_tokens: 10 } }),
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
    writeSpoolFile({ execId: 'exec_summary_1', provider: 'anthropic', model: 'haiku' });
    reconcileDetachedRuns(root);
    expect(reportExecutionComplete).toHaveBeenCalledWith('exec_summary_1', 'completed', expect.objectContaining({
      summary: 'Fixed the bug and opened PR #42.',
    }));
  });

  it('falls back to the token-count summary when the stream carries no final message', () => {
    writeFileSync(join(root, 'run.log'), 'Tokens: 1k sent, 10 received. Cost: $0.001 message, $0.001 session.\n');
    writeSpoolFile({ execId: 'exec_summary_fallback_1', provider: 'deepseek', model: 'deepseek-chat' });
    reconcileDetachedRuns(root);
    expect(reportExecutionComplete).toHaveBeenCalledWith('exec_summary_fallback_1', 'completed', expect.objectContaining({
      summary: expect.stringContaining('Detached run reconciled'),
    }));
  });
});

// ── #1130: detached lane ends its turn waiting on its own background
// subagent — a clean, non-error terminal result with zero deliverable and an
// unresolved Agent/Task tool_use must not be recorded as completed ──────────

describe('open-background-subagent + no-deliverable classification (#1130)', () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'squads-home-'));
    oldHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('marks failed: clean is_error:false result, zero commits/PRs/issues, subagent left hanging', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'explore the codebase', run_in_background: true } },
      ] }, model: 'claude-sonnet-5' }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: "I'm waiting on the background exploration agent's report before I write the migration and endpoint code. I'll pause here until it completes." },
      ] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: "I'll pause here until it completes.", is_error: false,
        total_cost_usd: 1.58, num_turns: 34, model: 'claude-sonnet-5',
        usage: { input_tokens: 500, output_tokens: 80 } }),
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
    writeSpoolFile({ execId: 'exec_bg_wait_1', provider: 'anthropic', model: 'sonnet', exitCode: 0 });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('failed');
    expect(String(rec.error)).toContain('background subagent');
    expect(String(rec.error)).toContain('#1130');
  });

  it('stays completed when the subagent spawned but its result came back before the terminal result', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'explore' } },
      ] }, model: 'claude-sonnet-5' }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'exploration complete: found the endpoint' },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: "git commit -m 'feat: endpoint'" } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_2', content: '[main ab12cd3] feat: endpoint\n 1 file changed, 10 insertions(+)' },
      ] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Implemented and committed.', is_error: false,
        total_cost_usd: 0.9, num_turns: 10, model: 'claude-sonnet-5',
        usage: { input_tokens: 500, output_tokens: 80 } }),
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
    writeSpoolFile({ execId: 'exec_bg_resolved_1', provider: 'anthropic', model: 'sonnet', exitCode: 0 });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('completed');
  });

  it('stays completed when a subagent is left open but the lane still delivered a PR', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'background followup', run_in_background: true } },
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'gh pr create --title x' } },
      ] }, model: 'claude-sonnet-5' }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'https://github.com/agents-squads/x/pull/42' },
      ] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Opened PR #42, kicked off a background followup task.', is_error: false,
        total_cost_usd: 0.5, num_turns: 12, model: 'claude-sonnet-5',
        usage: { input_tokens: 500, output_tokens: 80 } }),
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
    writeSpoolFile({ execId: 'exec_bg_delivered_1', provider: 'anthropic', model: 'sonnet', exitCode: 0 });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('completed');
  });

  it('leaves legacy plain-text logs untouched — no false positive', () => {
    writeFileSync(join(root, 'run.log'), 'plain old buffered output, not JSON at all\n');
    writeSpoolFile({ execId: 'exec_bg_legacy_1', provider: 'anthropic', model: 'sonnet', exitCode: 0 });
    reconcileDetachedRuns(root);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('completed');
  });
});

describe('opencode harness reconcile (#1177)', () => {
  // Real `opencode run --format json` v1.18.3 shapes (captured live 2026-07-19).
  function writeOpencodeJsonLog(): void {
    const oc = (type: string, part: Record<string, unknown>) =>
      JSON.stringify({ type, timestamp: 1784487629681, sessionID: 'ses_fix', part });
    const lines = [
      oc('step_start', { id: 'p1', type: 'step-start' }),
      oc('tool_use', { type: 'tool', tool: 'bash', callID: 'c1', state: {
        status: 'completed', input: { command: 'git add -A && git commit -m "fix: z"' },
        output: '[main ab12cd3] fix: z\n 1 file changed', title: 't', time: { start: 1, end: 2 } } }),
      oc('tool_use', { type: 'tool', tool: 'edit', callID: 'c2', state: {
        status: 'completed', input: { filePath: '/repo/z.ts', newString: 'zz' },
        output: 'ok', title: 't', time: { start: 1, end: 2 } } }),
      oc('step_finish', { id: 'p2', reason: 'tool-calls', type: 'step-finish',
        tokens: { total: 13508, input: 13373, output: 104, reasoning: 31, cache: { write: 0, read: 0 } }, cost: 0.0019 }),
      oc('text', { id: 'p3', type: 'text', text: 'done' }),
      oc('step_finish', { id: 'p4', reason: 'stop', type: 'step-finish',
        tokens: { total: 13760, input: 167, output: 9, reasoning: 16, cache: { write: 0, read: 13568 } }, cost: 0.0001 }),
    ];
    writeFileSync(join(root, 'run.log'), lines.join('\n') + '\n');
  }

  it('an opencode lane gets full observability parity via the harness field', () => {
    writeOpencodeJsonLog();
    writeSpoolFile({ execId: 'exec_oc_1', provider: 'opencode', model: 'deepseek/deepseek-chat', harness: 'opencode' });
    expect(reconcileDetachedRuns(root)).toBe(1);

    const [rec] = readExecutionsJsonl();
    expect(rec.provider).toBe('opencode');
    expect(rec.model).toBe('deepseek/deepseek-chat'); // from the spool — opencode events carry no model
    expect(rec.status).toBe('completed');
    expect(rec.cost_usd).toBeCloseTo(0.002, 10);      // REAL provider-priced cost from step_finish
    expect(rec.input_tokens).toBe(13373 + 167);
    expect(rec.output_tokens).toBe(104 + 31 + 9 + 16);
    expect(rec.actions).toBe(2);
    expect(rec.commits).toBe(1);
    expect(rec.files_edited).toBe(1);

    const eventsPath = join(root, '.agents', 'observability', 'events', 'exec_oc_1.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const types = events.map((e) => e.event.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('artifact');
    expect(types).toContain('file_write');
    expect(types).toContain('token_usage');
    expect(types[types.length - 1]).toBe('run_end');
    expect(events.every((e) => e.provider === 'opencode')).toBe(true);
  });

  it('an opencode log WITHOUT the harness stamp falls back to usage-only (no fabricated events)', () => {
    writeOpencodeJsonLog();
    writeSpoolFile({ execId: 'exec_oc_legacy', provider: 'opencode', model: 'x' });
    expect(reconcileDetachedRuns(root)).toBe(1);
    // Claude parser finds no stream evidence in opencode-shaped JSONL → no events file.
    expect(existsSync(join(root, '.agents', 'observability', 'events', 'exec_oc_legacy.jsonl'))).toBe(false);
  });

  it('an opencode run cut off before its stop step reconciles as failed (#1131 parity)', () => {
    const oc = (type: string, part: Record<string, unknown>) =>
      JSON.stringify({ type, timestamp: 1, sessionID: 'ses_fix', part });
    writeFileSync(join(root, 'run.log'), [
      oc('step_start', { id: 'p1', type: 'step-start' }),
      oc('tool_use', { type: 'tool', tool: 'read', callID: 'c1', state: {
        status: 'completed', input: { filePath: '/repo/a.ts' }, output: 'x', title: 't', time: { start: 1, end: 2 } } }),
    ].join('\n') + '\n');
    writeSpoolFile({ execId: 'exec_oc_cut', provider: 'opencode', model: 'x', harness: 'opencode' });
    expect(reconcileDetachedRuns(root)).toBe(1);
    const [rec] = readExecutionsJsonl();
    expect(rec.status).toBe('failed');
    expect(String(rec.error)).toContain('without a terminal result');
  });
});
