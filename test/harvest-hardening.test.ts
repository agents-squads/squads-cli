import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Network-touching bot identity — keep tests hermetic
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

import { harvestProviderWork, buildDetachedHarvestShell } from '../src/lib/execution-engine.js';
import { readWorktreeGitdirLink, verifyWorktreeLink } from '../src/lib/harvest-guard.js';

const IDENT = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@test',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@test',
};

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { encoding: 'utf-8', cwd, env: { ...process.env, ...IDENT } }).trim();
}

/** Executable script that drops a marker file when git (or anything) runs it. */
function trap(dir: string, name: string): { script: string; marker: string } {
  const marker = join(dir, `${name}.ran`);
  const script = join(dir, `${name}.sh`);
  writeFileSync(script, `#!/bin/sh\necho ran >> '${marker}'\ncat\n`);
  chmodSync(script, 0o755);
  return { script, marker };
}

/**
 * #1311 — the lane controls the worktree's `.git` file. A lane that points it
 * at a gitdir it built (config.fsmonitor / hooksPath / filter) must not get
 * the harness to run that code when the lane's work is harvested.
 */
describe('harvest git hardening (#1311)', () => {
  let root: string;
  let workDir: string;
  let scratch: string;
  let logFile: string;
  const branch = 'agent/testsquad/testagent-123';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'squads-harden-root-'));
    scratch = mkdtempSync(join(tmpdir(), 'squads-harden-scratch-'));
    git('init -b main', root);
    writeFileSync(join(root, 'README.md'), 'base\n');
    git('add -A', root);
    git('commit -m base', root);
    workDir = join(scratch, 'wt');
    git(`worktree add '${workDir}' -b '${branch}' HEAD`, root);
    logFile = join(scratch, 'lane.log');
  });

  afterEach(() => {
    try { git(`worktree remove '${workDir}' --force`, root); } catch { /* may be gone */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  /** Lane-side attack: a decoy gitdir whose config runs an fsmonitor hook. */
  function plantDecoyGitdir(): string {
    const { script, marker } = trap(scratch, 'fsmonitor');
    const decoy = join(scratch, 'decoy');
    git(`init -b main '${decoy}'`, scratch);
    git(`config core.fsmonitor '${script}'`, decoy);
    writeFileSync(join(workDir, '.git'), `gitdir: ${join(decoy, '.git')}\n`);
    writeFileSync(join(workDir, 'loot.md'), 'lane output\n');
    return marker;
  }

  it('the attack is real: plain git in a re-pointed worktree runs the fsmonitor hook', () => {
    const marker = plantDecoyGitdir();
    try { git('status --porcelain', workDir); } catch { /* status result irrelevant */ }
    expect(existsSync(marker)).toBe(true);
  });

  describe('harvestProviderWork', () => {
    it('refuses a worktree whose .git was re-pointed at a decoy gitdir — hook never runs, branch kept', async () => {
      const recorded = readWorktreeGitdirLink(workDir);
      const marker = plantDecoyGitdir();

      const result = await harvestProviderWork(
        workDir, root, branch, { squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek' },
        [], undefined, recorded,
      );

      expect(result.outcome).toBe('refused');
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(workDir)).toBe(true);
      expect(git('branch --list', root)).toContain('testagent-123');
    });

    it('refuses without a recorded link too (orphan salvage) — back-link check alone catches the decoy', async () => {
      const marker = plantDecoyGitdir();
      const result = await harvestProviderWork(
        workDir, root, branch, { squadName: 'testsquad', agentName: 'testagent', provider: 'unknown' },
      );
      expect(result.outcome).toBe('refused');
      expect(existsSync(marker)).toBe(false);
    });

    it("refuses a worktree re-pointed at a sibling lane's legitimate admin dir", async () => {
      const sibling = join(scratch, 'sibling');
      git(`worktree add '${sibling}' -b agent/testsquad/other-1 HEAD`, root);
      writeFileSync(join(workDir, '.git'), readFileSync(join(sibling, '.git'), 'utf-8'));
      writeFileSync(join(workDir, 'x.md'), 'x\n');
      const result = await harvestProviderWork(
        workDir, root, branch, { squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek' },
      );
      expect(result.outcome).toBe('refused');
    });

    it('a normal lane still harvests unchanged', async () => {
      const recorded = readWorktreeGitdirLink(workDir);
      writeFileSync(join(workDir, 'report.md'), '# report\n');
      const result = await harvestProviderWork(
        workDir, root, branch, { squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek' },
        [], undefined, recorded,
      );
      expect(result).toEqual({ outcome: 'branch-preserved', branch });
      expect(git(`show '${branch}:report.md'`, root)).toContain('report');
    });

    it('never runs hooks, fsmonitor or filter drivers, even from the verified repo config', async () => {
      const fsmon = trap(scratch, 'fsmon');
      const hook = trap(scratch, 'precommit');
      const filter = trap(scratch, 'filter');
      git(`config core.fsmonitor '${fsmon.script}'`, root);
      git(`config filter.evil.clean '${filter.script}'`, root);
      git(`config filter.evil.smudge '${filter.script}'`, root);
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      const preCommit = join(root, '.git', 'hooks', 'pre-commit');
      writeFileSync(preCommit, `#!/bin/sh\necho ran >> '${hook.marker}'\n`);
      chmodSync(preCommit, 0o755);
      writeFileSync(join(workDir, '.gitattributes'), '* filter=evil\n');
      writeFileSync(join(workDir, 'report.md'), '# report\n');

      const result = await harvestProviderWork(
        workDir, root, branch, { squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek' },
        [], undefined, readWorktreeGitdirLink(workDir),
      );

      expect(result.outcome).toBe('branch-preserved');
      expect(existsSync(fsmon.marker)).toBe(false);
      expect(existsSync(hook.marker)).toBe(false);
      expect(existsSync(filter.marker)).toBe(false);
    });
  });

  describe('buildDetachedHarvestShell', () => {
    const build = () => buildDetachedHarvestShell({
      workDir, projectRoot: root, branchName: branch,
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek', logFile,
    });

    it('refuses a re-pointed .git: no git runs in the worktree, worktree + branch kept, logged loudly', () => {
      const script = build(); // built before the lane runs — records the link
      const marker = plantDecoyGitdir();
      execSync(`true ${script}`, { shell: '/bin/sh', cwd: root });

      expect(existsSync(marker)).toBe(false);
      expect(existsSync(workDir)).toBe(true);
      expect(git('branch --list', root)).toContain('testagent-123');
      expect(readFileSync(logFile, 'utf-8')).toContain('harvest REFUSED');
    });

    it('a normal lane still preserves its work on the branch and removes the worktree', () => {
      const script = build();
      writeFileSync(join(workDir, 'report.md'), '# Agent report\n');
      execSync(`true ${script}`, { shell: '/bin/sh', cwd: root });

      expect(git(`rev-list --count '${branch}' '^HEAD'`, root)).toBe('1');
      expect(git(`show '${branch}:report.md'`, root)).toContain('Agent report');
      expect(existsSync(workDir)).toBe(false);
      expect(readFileSync(logFile, 'utf-8')).toContain('squads inbox');
    });

    it('does not run the repo hooks, fsmonitor or filters while harvesting a normal lane', () => {
      const fsmon = trap(scratch, 'fsmon');
      const hook = trap(scratch, 'precommit');
      const filter = trap(scratch, 'filter');
      git(`config core.fsmonitor '${fsmon.script}'`, root);
      git(`config filter.evil.clean '${filter.script}'`, root);
      mkdirSync(join(root, '.git', 'hooks'), { recursive: true });
      const preCommit = join(root, '.git', 'hooks', 'pre-commit');
      writeFileSync(preCommit, `#!/bin/sh\necho ran >> '${hook.marker}'\n`);
      chmodSync(preCommit, 0o755);
      const script = build();
      writeFileSync(join(workDir, '.gitattributes'), '* filter=evil\n');
      writeFileSync(join(workDir, 'report.md'), '# report\n');
      execSync(`true ${script}`, { shell: '/bin/sh', cwd: root });

      expect(git(`rev-list --count '${branch}' '^HEAD'`, root)).toBe('1');
      expect(existsSync(fsmon.marker)).toBe(false);
      expect(existsSync(hook.marker)).toBe(false);
      expect(existsSync(filter.marker)).toBe(false);
    });
  });

  describe('verifyWorktreeLink', () => {
    it('accepts the worktree git created and rejects a directory-form .git', () => {
      expect(verifyWorktreeLink(workDir, root, readWorktreeGitdirLink(workDir))).toEqual({ ok: true });
      rmSync(join(workDir, '.git'));
      mkdirSync(join(workDir, '.git'));
      expect(verifyWorktreeLink(workDir, root).ok).toBe(false);
    });
  });
});
