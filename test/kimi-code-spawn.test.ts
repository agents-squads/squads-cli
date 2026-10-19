/**
 * cli#1309 — drive the real executeWithProvider spawn path with a STUB `kimi`
 * (the real CLI is checked live by the orchestrator, not here). Proves the
 * wiring the unit tests can't: sandbox wrapper, cwd = the worktree, stdin
 * ignored, metered keys scrubbed, stream parsed into the ledger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, chmodSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const stub = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/lib/api-client.js', () => ({
  reportExecutionStart: vi.fn().mockResolvedValue(true),
  reportExecutionComplete: vi.fn().mockResolvedValue(true),
  reportExecutionEvents: vi.fn().mockResolvedValue(true),
}));

const FIXTURE = join(__dirname, 'fixtures', 'kimi-code', 'tool-run.jsonl');
const darwin = process.platform === 'darwin';

let root: string;
let out: string;
let prevEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  prevEnv = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'kimi-spawn-')));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.agents', 'squads', 'demo'), { recursive: true });
  writeFileSync(join(repo, '.agents', 'squads', 'demo', 'tester.md'), '---\nname: tester\n---\n# tester\n');
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m init', { cwd: repo });

  // The stub records how it was spawned, then replays the captured fixture.
  stub.dir = join(root, 'stub');
  mkdirSync(stub.dir);
  out = join(stub.dir, 'spawn.txt');
  copyFileSync(FIXTURE, join(stub.dir, 'tool-run.jsonl'));
  const bin = join(stub.dir, 'kimi');
  writeFileSync(bin, [
    '#!/bin/sh',
    `{ echo "cwd=$PWD"; echo "args=$*"; echo "kimikey=\${KIMI_API_KEY-unset}"; echo "anthropic=\${ANTHROPIC_API_KEY-unset}";`,
    `  echo "ghtoken=\${GH_TOKEN-unset}"; echo "stdin_bytes=$(cat | wc -c | tr -d ' ')"; } > "${out}"`,
    `cat "${join(stub.dir, 'tool-run.jsonl')}"`,
  ].join('\n') + '\n');
  chmodSync(bin, 0o755);

  process.env.SQUADS_KIMI_BIN = bin;
  process.env.KIMI_API_KEY = 'metered-secret';
  process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
  process.env.GH_TOKEN = 'gh-secret';
  vi.spyOn(process, 'cwd').mockReturnValue(repo);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.env = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

function recorded(): Record<string, string> {
  return Object.fromEntries(readFileSync(out, 'utf-8').trim().split('\n').map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  }));
}

describe.skipIf(!darwin || !existsSyncSandboxExec())('executeWithProvider kimi-code (stub binary)', () => {
  it('foreground: sandboxed, worktree cwd, stdin closed, no metered keys, ledger from the stream', async () => {
    const { executeWithProvider } = await import('../src/lib/execution-engine.js');
    const repo = join(root, 'repo');
    await executeWithProvider('kimi-code', 'do it', {
      foreground: true, cwd: repo, squadName: 'demo', agentName: 'tester', model: 'kimi-code/k3',
    });

    const r = recorded();
    expect(r.cwd).toContain(join(root, '.worktrees', 'demo-tester-')); // the worktree, not the repo
    expect(r.args).toBe('-p do it --output-format stream-json -m k3');
    expect(r.kimikey).toBe('unset');
    expect(r.anthropic).toBe('unset');
    expect(r.ghtoken).toBe('unset');
    expect(r.stdin_bytes).toBe('0'); // /dev/null, never the parent's stdin

    const ledger = readFileSync(join(repo, '.agents', 'observability', 'executions.jsonl'), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const done = ledger.filter((e) => e.status === 'completed' || e.status === 'failed').pop();
    expect(done.provider).toBe('kimi-code');
    expect(done.status).toBe('completed');
    expect(done.billing).toBe('subscription');
    expect(done.cost_usd).toBe(0);
    expect(done.actions).toBe(3);
    expect(done.files_edited).toBe(1);
    expect(done.session_id).toBe('session_d5dd8847-999d-48ba-8983-3f0f559584c3');
  });

  it('background: same sandbox + stdin + env contract through the detached shell, spool stamped kimi-code', async () => {
    const { executeWithProvider } = await import('../src/lib/execution-engine.js');
    const { reconcileDetachedRuns, spoolDir } = await import('../src/lib/spool.js');
    const repo = join(root, 'repo');
    await executeWithProvider('kimi-code', 'do it', {
      foreground: false, cwd: repo, squadName: 'demo', agentName: 'tester', model: 'kimi-code/k3', executionId: 'exec_kimi_bg',
    });

    // The wrapper is detached: wait for its done-file (written after the harvest step).
    const done = join(spoolDir(repo), 'exec_kimi_bg.json');
    for (let i = 0; i < 100 && !existsSync(done); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(done)).toBe(true);

    const r = recorded();
    expect(r.cwd).toContain(join(root, '.worktrees', 'demo-tester-'));
    expect(r.args).toBe('-p do it --output-format stream-json -m k3');
    expect(r.kimikey).toBe('unset');
    expect(r.anthropic).toBe('unset');
    expect(r.stdin_bytes).toBe('0');

    expect(JSON.parse(readFileSync(done, 'utf-8')).harness).toBe('kimi-code');
    expect(reconcileDetachedRuns(repo)).toBe(1);
    const ledger = readFileSync(join(repo, '.agents', 'observability', 'executions.jsonl'), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const rec = ledger.filter((e) => e.id === 'exec_kimi_bg').pop();
    expect(rec.status).toBe('completed');
    expect(rec.billing).toBe('subscription');
    expect(rec.actions).toBe(3);
  });

  it('refuses the run and drops the worktree when the contract cannot be honoured', async () => {
    writeFileSync(join(root, 'repo', '.agents', 'squads', 'demo', 'tester.md'),
      '---\ntool_grants:\n  - { tool: Read, sensitivity: read }\n---\n# tester\n');
    const { executeWithProvider } = await import('../src/lib/execution-engine.js');
    await expect(executeWithProvider('kimi-code', 'do it', {
      foreground: true, cwd: join(root, 'repo'), squadName: 'demo', agentName: 'tester',
    })).rejects.toThrow(/kimi-code governance/);
    expect(existsSync(out)).toBe(false); // kimi was never spawned
    const wt = execSync('git worktree list --porcelain', { cwd: join(root, 'repo') }).toString();
    expect(wt).not.toContain('demo-tester-');
  });
});

function existsSyncSandboxExec(): boolean {
  try { execSync('command -v sandbox-exec', { stdio: 'pipe' }); return true; } catch { return false; }
}
