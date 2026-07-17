import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Network-touching bot identity — keep tests hermetic (same mock as harvest.test.ts)
vi.mock('../src/lib/github.js', () => ({
  getBotGitEnv: vi.fn(async () => ({
    GIT_AUTHOR_NAME: 'test-bot',
    GIT_AUTHOR_EMAIL: 'bot@test',
    GIT_COMMITTER_NAME: 'test-bot',
    GIT_COMMITTER_EMAIL: 'bot@test',
  })),
  getBotPushUrl: vi.fn(async () => null),
  getBotGhEnv: vi.fn(async () => ({})),
  getCoAuthorTrailer: vi.fn(() => 'Co-Authored-By: Test <test@test>'),
  detectGitHubRepo: vi.fn(() => null),
}));

import { buildDetachedHarvestShell } from '../src/lib/execution-engine.js';

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, {
    encoding: 'utf-8',
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  }).trim();
}

/**
 * Regression guard for cli#1126: the shell cleanupCmd for detached
 * non-Anthropic provider lanes used to `git merge --ff-only` an ahead agent
 * branch directly into whatever was checked out at projectRoot — silently
 * fast-forwarding unreviewed agent commits onto develop. harvestProviderWork
 * (the foreground TS path) was fixed to preserve-only semantics by #966; this
 * exercises the detached shell path (buildDetachedHarvestShell) the same way
 * harvest.test.ts exercises harvestProviderWork.
 */
describe('buildDetachedHarvestShell (cli#1126 — detached lane must never merge into projectRoot)', () => {
  let root: string;
  let workDir: string;
  let logFile: string;
  const branch = 'agent/testsquad/testagent-123';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'squads-detached-harvest-root-'));
    git('init -b main', root);
    writeFileSync(join(root, 'README.md'), 'base\n');
    git('add -A', root);
    git('commit -m base', root);
    workDir = join(root, '..', `squads-detached-harvest-wt-${Date.now()}`);
    git(`worktree add '${workDir}' -b '${branch}' HEAD`, root);
    const logDir = join(root, '.agents', 'logs', 'testsquad');
    mkdirSync(logDir, { recursive: true });
    logFile = join(logDir, 'testagent-123.log');
  });

  afterEach(() => {
    try { git(`worktree remove '${workDir}' --force`, root); } catch { /* may already be gone */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('never advances projectRoot HEAD when the agent branch is ahead — preserves the branch instead', () => {
    writeFileSync(join(workDir, 'report.md'), '# Agent report\n');
    const trunkBefore = git('rev-parse HEAD', root);

    const script = buildDetachedHarvestShell({
      workDir, projectRoot: root, branchName: branch,
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek', logFile,
    });
    execSync(`true ${script}`, { shell: '/bin/sh', cwd: root });

    // The operator's checkout never moves — the pre-#966-class hazard this
    // closes was exactly a silent `git merge --ff-only` advancing this HEAD.
    expect(git('rev-parse HEAD', root)).toBe(trunkBefore);
    // The work is not lost — it's committed and preserved on the agent branch.
    expect(git(`rev-list --count '${branch}' '^HEAD'`, root)).toBe('1');
    expect(git(`show '${branch}:report.md'`, root)).toContain('Agent report');
    // The worktree is cleaned up but the branch survives for the inbox gate.
    expect(existsSync(workDir)).toBe(false);
    expect(git('branch --list ' + branch, root)).toContain(branch.split('/').pop()!);
    // Logged loudly so the inbox stranded-branch scanner's human operator sees it.
    const log = readFileSync(logFile, 'utf-8');
    expect(log).toContain(branch);
    expect(log).toContain('squads inbox');
  });

  it('still preserves (never merges) even when projectRoot has diverged concurrently', () => {
    writeFileSync(join(workDir, 'report.md'), '# Agent report\n');
    writeFileSync(join(root, 'other.md'), 'concurrent work\n');
    git('add -A', root);
    git('commit -m concurrent', root);
    const trunkBefore = git('rev-parse HEAD', root);

    const script = buildDetachedHarvestShell({
      workDir, projectRoot: root, branchName: branch,
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek', logFile,
    });
    execSync(`true ${script}`, { shell: '/bin/sh', cwd: root });

    expect(git('rev-parse HEAD', root)).toBe(trunkBefore);
    expect(git(`rev-list --count '${branch}' '^HEAD'`, root)).toBe('1');
  });

  it('deletes the branch when the executor produced no changes — nothing to strand', () => {
    const trunkBefore = git('rev-parse HEAD', root);

    const script = buildDetachedHarvestShell({
      workDir, projectRoot: root, branchName: branch,
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek', logFile,
    });
    execSync(`true ${script}`, { shell: '/bin/sh', cwd: root });

    expect(git('rev-parse HEAD', root)).toBe(trunkBefore);
    expect(existsSync(workDir)).toBe(false);
    const branches = git('branch --list', root);
    expect(branches).not.toContain(branch.split('/').pop());
  });

  it('returns an empty snippet when the agent ran in projectRoot directly (nothing to harvest)', () => {
    const script = buildDetachedHarvestShell({
      workDir: root, projectRoot: root, branchName: branch,
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek', logFile,
    });
    expect(script).toBe('');
  });
});
