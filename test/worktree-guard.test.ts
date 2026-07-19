/**
 * Tests for the worktree guard (cli#1166/#1153) — the generated hook script
 * is EXECUTED with real PreToolUse payloads (not just string-inspected), so
 * template-escaping bugs can't ship. Block = exit 2, allow = exit 0.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildWorktreeGuardScript,
  buildWorktreeGuardHooks,
  mergeHooks,
} from '../src/lib/worktree-guard.js';

const PRIMARY = '/Users/x/agents-squads/squads-api';

function runGuard(payload: unknown, cwd?: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wtg-'));
  const script = join(dir, 'guard.cjs');
  writeFileSync(script, buildWorktreeGuardScript(PRIMARY));
  const workdir = cwd ?? mkdtempSync(join(tmpdir(), 'wtg-cwd-'));
  const r = spawnSync('node', [script], {
    input: JSON.stringify(payload),
    cwd: workdir,
    encoding: 'utf-8',
  });
  return { status: r.status, stderr: r.stderr };
}

describe('file mutations', () => {
  it('blocks Edit on a primary-checkout path', () => {
    const r = runGuard({ tool_name: 'Edit', tool_input: { file_path: `${PRIMARY}/routers/runs.py` } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('PRIMARY checkout');
  });

  it('blocks Write on the primary root itself', () => {
    const r = runGuard({ tool_name: 'Write', tool_input: { file_path: `${PRIMARY}/x.py` } });
    expect(r.status).toBe(2);
  });

  it('allows Edit inside the worktree', () => {
    const r = runGuard({ tool_name: 'Edit', tool_input: { file_path: '/Users/x/agents-squads/.worktrees/api-x/routers/runs.py' } });
    expect(r.status).toBe(0);
  });

  it('allows Write under the primary .agents subtree (logs/memory/spool)', () => {
    const r = runGuard({ tool_name: 'Write', tool_input: { file_path: `${PRIMARY}/.agents/logs/x.log` } });
    expect(r.status).toBe(0);
  });
});

describe('bash mutations', () => {
  it('blocks cd into the primary checkout', () => {
    const r = runGuard({ tool_name: 'Bash', tool_input: { command: `cd ${PRIMARY} && git checkout -b feature/x` } });
    expect(r.status).toBe(2);
  });

  it('blocks cd into primary after a chain', () => {
    const r = runGuard({ tool_name: 'Bash', tool_input: { command: `echo hi; cd '${PRIMARY}'; python -m pytest` } });
    expect(r.status).toBe(2);
  });

  it('blocks git -C primary mutations', () => {
    const r = runGuard({ tool_name: 'Bash', tool_input: { command: `git -C ${PRIMARY} checkout -b feature/y` } });
    expect(r.status).toBe(2);
  });

  it('blocks redirection into primary paths', () => {
    const r = runGuard({ tool_name: 'Bash', tool_input: { command: `echo x > ${PRIMARY}/notes.md` } });
    expect(r.status).toBe(2);
  });

  it('allows git -C primary reads (log/diff/status/worktree list)', () => {
    for (const cmd of [
      `git -C ${PRIMARY} log --oneline -5`,
      `git -C ${PRIMARY} status --short`,
      `git -C ${PRIMARY} diff --stat`,
      `git -C ${PRIMARY} worktree list`,
    ]) {
      const r = runGuard({ tool_name: 'Bash', tool_input: { command: cmd } });
      expect(r.status, cmd).toBe(0);
    }
  });

  it('allows commands that never reference the primary root', () => {
    const r = runGuard({ tool_name: 'Bash', tool_input: { command: 'npm test && git commit -m x' } });
    expect(r.status).toBe(0);
  });

  it('allows redirection into the primary .agents subtree', () => {
    const r = runGuard({ tool_name: 'Bash', tool_input: { command: `echo x >> ${PRIMARY}/.agents/logs/a.log` } });
    expect(r.status).toBe(0);
  });
});

describe('disarm + plumbing', () => {
  it('disarms when cwd IS the primary root (foreground fallback mode)', () => {
    const fakePrimary = mkdtempSync(join(tmpdir(), 'wtg-primary-'));
    const dir = mkdtempSync(join(tmpdir(), 'wtg-'));
    const script = join(dir, 'guard.cjs');
    writeFileSync(script, buildWorktreeGuardScript(fakePrimary));
    const r = spawnSync('node', [script], {
      input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: `${fakePrimary}/x.py` } }),
      cwd: fakePrimary,
      encoding: 'utf-8',
    });
    expect(r.status).toBe(0);
  });

  it('exits 0 on malformed stdin (never bricks a run)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wtg-'));
    const script = join(dir, 'guard.cjs');
    writeFileSync(script, buildWorktreeGuardScript(PRIMARY));
    const r = spawnSync('node', [script], { input: 'not json', encoding: 'utf-8' });
    expect(r.status).toBe(0);
  });

  it('mergeHooks concatenates guardrail + guard entries per event', () => {
    const guardrail = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] };
    const merged = mergeHooks(guardrail, buildWorktreeGuardHooks('/tmp/g.cjs')) as {
      PreToolUse: unknown[];
    };
    expect(merged.PreToolUse).toHaveLength(2);
  });
});

describe('detached script fail-loud (cli#1166)', () => {
  it('never silently falls back to the primary checkout on worktree failure', async () => {
    const { buildDetachedShellScript } = await import('../src/lib/execution-engine.js');
    const script = buildDetachedShellScript({
      projectRoot: '/repo/primary',
      squadName: 'cli',
      agentName: 'lane',
      timestamp: 1,
      escapedPrompt: 'x',
      logFile: '/tmp/l.log',
      pidFile: '/tmp/l.pid',
    });
    // The old escape hatch: `WORK_DIR='<primary>'; if git worktree add ...; then WORK_DIR=...` —
    // failure left the lane running in the primary checkout.
    expect(script).not.toContain(`WORK_DIR='/repo/primary'`);
    expect(script).toContain('FATAL: worktree creation failed');
    expect(script).toContain('exit 1');
  });

  it('cli#1135: the whole wrapper exec-redirects into the lane log before any segment runs', async () => {
    const { buildDetachedShellScript } = await import('../src/lib/execution-engine.js');
    const script = buildDetachedShellScript({
      projectRoot: '/repo/primary',
      squadName: 'cli',
      agentName: 'lane',
      timestamp: 1,
      escapedPrompt: 'x',
      logFile: '/tmp/l.log',
      pidFile: '/tmp/l.pid',
    });
    const execIdx = script.indexOf(`exec >> '/tmp/l.log' 2>&1`);
    const worktreeIdx = script.indexOf('worktree add');
    expect(execIdx).toBeGreaterThan(-1);
    expect(worktreeIdx).toBeGreaterThan(-1);
    expect(execIdx).toBeLessThan(worktreeIdx); // log live before anything can die
  });
});
