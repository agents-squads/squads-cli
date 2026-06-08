import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { createRunWorktree } from '../src/lib/worktree';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

// Clear git env vars set by the pre-commit hook so git commands in temp
// directories do not operate on the squads-cli repo (hook recursion bug).
beforeAll(() => {
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
});

/** Initialize a git repo with one commit on `branch` (default: main). */
function initRepo(dir: string, branch = 'main'): void {
  execSync(`git init -b ${branch}`, { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email test@example.com', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name Test', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execSync('git add -A', { cwd: dir, stdio: 'pipe' });
  execSync('git commit -m init', { cwd: dir, stdio: 'pipe' });
}

describe('createRunWorktree (#440)', () => {
  let parent: string;   // sibling of repo; .worktrees lands here
  let repoDir: string;
  const savedNoWorktree = process.env.SQUADS_NO_WORKTREE;

  beforeEach(() => {
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    delete process.env.SQUADS_NO_WORKTREE;
    parent = mkdtempSync(join(tmpdir(), 'squads-wt-test-'));
    repoDir = join(parent, 'repo');
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    if (savedNoWorktree === undefined) delete process.env.SQUADS_NO_WORKTREE;
    else process.env.SQUADS_NO_WORKTREE = savedNoWorktree;
    rmSync(parent, { recursive: true, force: true });
  });

  it('falls back to in-place for a non-git directory', () => {
    const { cwd, cleanup } = createRunWorktree(repoDir, 'product');
    expect(cwd).toBe(repoDir);
    // cleanup must be a safe no-op
    expect(() => cleanup()).not.toThrow();
  });

  it('creates an isolated worktree for a git repo and cleans it up', () => {
    initRepo(repoDir);
    const { cwd, cleanup } = createRunWorktree(repoDir, 'product');

    // cwd is a distinct, existing directory (not the original repo)
    expect(cwd).not.toBe(repoDir);
    expect(existsSync(cwd)).toBe(true);
    expect(cwd).toContain('.worktrees');
    expect(cwd).toContain('squads-run-product-');

    // git sees it as a registered worktree
    const list = execSync(`git -C '${repoDir}' worktree list`, { encoding: 'utf-8' });
    expect(list).toContain(cwd);

    // branch follows the squads/run-<squad>-<id> convention
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim();
    expect(branch).toMatch(/^squads\/run-product-/);

    cleanup();
    expect(existsSync(cwd)).toBe(false);
    const listAfter = execSync(`git -C '${repoDir}' worktree list`, { encoding: 'utf-8' });
    expect(listAfter).not.toContain(cwd);
  });

  it('bases the worktree on develop when it exists', () => {
    initRepo(repoDir, 'main');
    execSync('git branch develop', { cwd: repoDir, stdio: 'pipe' });

    const { cwd, cleanup } = createRunWorktree(repoDir, 'product');
    // The new branch should descend from develop (same tip commit here).
    const developSha = execSync('git rev-parse develop', { cwd: repoDir, encoding: 'utf-8' }).trim();
    const wtSha = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
    expect(wtSha).toBe(developSha);
    cleanup();
  });

  it('bases on the current branch when develop is absent', () => {
    initRepo(repoDir, 'trunk');
    const { cwd, cleanup } = createRunWorktree(repoDir, 'product');
    const trunkSha = execSync('git rev-parse trunk', { cwd: repoDir, encoding: 'utf-8' }).trim();
    const wtSha = execSync('git rev-parse HEAD', { cwd, encoding: 'utf-8' }).trim();
    expect(wtSha).toBe(trunkSha);
    cleanup();
  });

  it('SQUADS_NO_WORKTREE=1 disables isolation (runs in-place)', () => {
    initRepo(repoDir);
    process.env.SQUADS_NO_WORKTREE = '1';
    const { cwd, cleanup } = createRunWorktree(repoDir, 'product');
    expect(cwd).toBe(repoDir);
    expect(() => cleanup()).not.toThrow();
  });

  it('gives parallel squads non-colliding worktree paths and branches', () => {
    initRepo(repoDir);
    const a = createRunWorktree(repoDir, 'product');
    const b = createRunWorktree(repoDir, 'product');
    expect(a.cwd).not.toBe(b.cwd);
    const branchA = execSync('git rev-parse --abbrev-ref HEAD', { cwd: a.cwd, encoding: 'utf-8' }).trim();
    const branchB = execSync('git rev-parse --abbrev-ref HEAD', { cwd: b.cwd, encoding: 'utf-8' }).trim();
    expect(branchA).not.toBe(branchB);
    a.cleanup();
    b.cleanup();
  });

  it('sanitizes squad names with unsafe characters', () => {
    initRepo(repoDir);
    const { cwd, cleanup } = createRunWorktree(repoDir, 'my squad/name');
    expect(existsSync(cwd)).toBe(true);
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8' }).trim();
    expect(branch).toMatch(/^squads\/run-my-squad-name-/);
    cleanup();
  });
});
