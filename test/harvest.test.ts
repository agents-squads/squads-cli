import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
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

import { harvestProviderWork, cleanupWorktree } from '../src/lib/execution-engine.js';

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

describe('harvestProviderWork (#823 — executor output must never be lost)', () => {
  let root: string;
  let workDir: string;
  const branch = 'agent/testsquad/testagent-123';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'squads-harvest-root-'));
    git('init -b main', root);
    writeFileSync(join(root, 'README.md'), 'base\n');
    git('add -A', root);
    git('commit -m base', root);
    workDir = join(root, '..', `squads-harvest-wt-${Date.now()}`);
    git(`worktree add '${workDir}' -b '${branch}' HEAD`, root);
  });

  afterEach(() => {
    try { git(`worktree remove '${workDir}' --force`, root); } catch { /* may be gone */ }
    rmSync(root, { recursive: true, force: true });
    rmSync(workDir, { recursive: true, force: true });
  });

  it('commits dirty executor output and fast-forwards the project root', async () => {
    writeFileSync(join(workDir, 'report.md'), '# Agent report\n');

    const result = await harvestProviderWork(workDir, root, branch, {
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek',
    });

    expect(result.outcome).toBe('merged');
    expect(existsSync(join(root, 'report.md'))).toBe(true);
    expect(readFileSync(join(root, 'report.md'), 'utf-8')).toContain('Agent report');
    expect(git('log -1 --format=%s', root)).toContain('testsquad/testagent');
  });

  it('preserves the branch when the project root has diverged', async () => {
    writeFileSync(join(workDir, 'report.md'), '# Agent report\n');
    // Root moves on while the agent works → ff-merge impossible
    writeFileSync(join(root, 'other.md'), 'concurrent work\n');
    git('add -A', root);
    git('commit -m concurrent', root);

    const result = await harvestProviderWork(workDir, root, branch, {
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek',
    });

    expect(result.outcome).toBe('branch-preserved');
    // The work survives on the branch even though it did not merge
    expect(git(`rev-list --count '${branch}' '^HEAD'`, root)).toBe('1');
    expect(git(`show '${branch}:report.md'`, root)).toContain('Agent report');
  });

  it('reports nothing when the executor produced no changes', async () => {
    const result = await harvestProviderWork(workDir, root, branch, {
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek',
    });
    expect(result.outcome).toBe('nothing');
  });

  it('is a no-op when the agent ran in the project root directly', async () => {
    const result = await harvestProviderWork(root, root, branch, {
      squadName: 'testsquad', agentName: 'testagent', provider: 'deepseek',
    });
    expect(result.outcome).toBe('in-place');
  });

  it('cleanupWorktree keeps the agent branch when asked', () => {
    writeFileSync(join(workDir, 'x.md'), 'x\n');
    git('add -A', workDir);
    git('commit -m wip', workDir);

    cleanupWorktree(workDir, root, { keepBranch: true });

    expect(existsSync(workDir)).toBe(false);
    expect(git(`rev-list --count '${branch}'`, root)).toBe('2'); // base + wip
  });
});
