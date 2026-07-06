import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

vi.mock('../../src/lib/terminal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/terminal.js')>();
  return { ...actual, writeLine: vi.fn() };
});

import { inboxCommand } from '../../src/commands/inbox.js';

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { cwd, encoding: 'utf8' });
}

/**
 * End-to-end exit-code truth for `squads inbox approve` (#979): a decision
 * verb that reports ok:false must never exit 0 — the user has to be able to
 * script/CI around it. Also exercises the local-first land (no GitHub remote)
 * through the full command, not just the lib function.
 */
describe('inboxCommand approve — exit code truth + local-first landing (#979)', () => {
  let dir: string;
  let originalCwd: string;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'squads-inbox-cmd-'));
    originalCwd = process.cwd();
    process.chdir(dir);
    process.exitCode = undefined;

    git('init -q -b develop', dir);
    git('config user.email t@t', dir);
    git('config user.name t', dir);
    writeFileSync(join(dir, 'a.txt'), 'a');
    git('add -A', dir);
    git('commit -qm base', dir);
    git('checkout -q -b squads/run-cli-abc123-0', dir);
    writeFileSync(join(dir, 'brief.md'), 'deliverable');
    git('add -A', dir);
    git('commit -qm brief', dir);
    git('checkout -q develop', dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = originalExitCode;
  });

  it('exits 0 and lands the branch locally when there is no GitHub remote (no dead-end)', async () => {
    await inboxCommand('approve', 'branch-squads/run-cli-abc123-0', { json: true });
    expect(process.exitCode).toBeUndefined();
    expect(git('show develop:brief.md', dir).trim()).toBe('deliverable');
    expect(git('branch --list "squads/*"', dir).trim()).toBe('');
  });

  it('exits nonzero when the local merge fails (ok:false), never silently 0', async () => {
    // Conflicting content already on develop collides with the branch's file.
    writeFileSync(join(dir, 'brief.md'), 'conflicting develop content');
    git('add -A', dir);
    git('commit -qm "conflicting develop edit"', dir);

    await inboxCommand('approve', 'branch-squads/run-cli-abc123-0', { json: true });
    expect(process.exitCode).toBe(1);
  });
});
