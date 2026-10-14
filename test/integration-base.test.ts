/**
 * #1083 — provider-lane worktrees must branch from the repo's integration
 * base, never the operator's checked-out HEAD.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveIntegrationBase } from '../src/lib/execution-engine.js';

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('resolveIntegrationBase (#1083)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'squads-base-'));
    git('init -b main', root);
    git('config user.email t@t.t', root);
    git('config user.name t', root);
    writeFileSync(join(root, 'a.md'), 'a\n');
    git('add -A', root);
    git('commit -m base', root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to HEAD when no remote refs exist (fresh local-only repo)', () => {
    expect(resolveIntegrationBase(root)).toBe('HEAD');
  });

  it('prefers origin/develop over operator HEAD (fetch failure tolerated offline)', () => {
    // Materialize remote-tracking refs without a live remote; the best-effort
    // fetch fails (no origin configured) and the stale ref is still used.
    git('update-ref refs/remotes/origin/develop HEAD', root);
    git('checkout -b some-unmerged-fix-branch -q', root);
    expect(resolveIntegrationBase(root)).toBe('origin/develop');
  });

  it('uses origin/main when origin/develop is absent', () => {
    git('update-ref refs/remotes/origin/main HEAD', root);
    expect(resolveIntegrationBase(root)).toBe('origin/main');
  });
});
