/**
 * No assumed branch names (#1247): the trunk comes from what the repo has
 * (develop, else origin/HEAD, else main/master), and `memory sync --push`
 * commits only .agents/memory/ and pushes the branch the operator is on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { integrationBranch } from '../src/lib/git.js';
import { resolveIntegrationBase } from '../src/lib/execution-engine.js';
import { createRunWorktree } from '../src/lib/worktree.js';
import { syncCommand } from '../src/commands/sync.js';
import { scanOpenPrs } from '../src/lib/inbox.js';

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, { encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

let root: string;

/** A bare remote whose default branch is `trunk` (neither develop nor main), cloned. */
function cloneWithTrunk(): string {
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git('init -q -b trunk', seed);
  git('config user.email t@t.t', seed);
  git('config user.name t', seed);
  mkdirSync(join(seed, '.agents', 'memory', 'cli'), { recursive: true });
  writeFileSync(join(seed, '.agents', 'memory', 'cli', 'state.md'), 'v1\n');
  writeFileSync(join(seed, 'README.md'), '# r\n');
  git('add -A', seed);
  git('commit -q -m init', seed);
  git(`clone -q --bare ${seed} ${remote}`, root);
  const work = join(root, 'work');
  git(`clone -q ${remote} ${work}`, root);
  git('config user.email t@t.t', work);
  git('config user.name t', work);
  return work;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-branches-'));
  delete process.env.SQUADS_NO_WORKTREE;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('integrationBranch', () => {
  function localRepo(branch: string): string {
    const dir = join(root, 'local');
    mkdirSync(dir);
    git(`init -q -b ${branch}`, dir);
    git('config user.email t@t.t', dir);
    git('config user.name t', dir);
    writeFileSync(join(dir, 'a.md'), 'a\n');
    git('add -A', dir);
    git('commit -q -m base', dir);
    return dir;
  }

  it('uses the remote default branch (origin/HEAD) when there is no develop', () => {
    expect(integrationBranch(cloneWithTrunk())).toBe('trunk');
  });

  it('prefers develop when the repo has one', () => {
    const work = cloneWithTrunk();
    git('update-ref refs/remotes/origin/develop HEAD', work);
    expect(integrationBranch(work)).toBe('develop');
  });

  it('falls back to master, then null, in a repo with no remote', () => {
    expect(integrationBranch(localRepo('master'))).toBe('master');
    rmSync(join(root, 'local'), { recursive: true, force: true });
    expect(integrationBranch(localRepo('feature'))).toBeNull();
  });
});

describe('run bases follow the repo trunk, not a hard-coded name', () => {
  it('provider-lane base is origin/<default branch>', () => {
    const work = cloneWithTrunk();
    git('checkout -q -b operator-wip', work);
    expect(resolveIntegrationBase(work)).toBe('origin/trunk');
  });

  it('run worktree branches from origin/<default branch>, not the operator branch', () => {
    const work = cloneWithTrunk();
    git('checkout -q -b operator-wip', work);
    writeFileSync(join(work, 'wip.md'), 'wip\n');
    git('add -A', work);
    git('commit -q -m wip', work);

    const { cwd, cleanup } = createRunWorktree(work, 'product');
    try {
      expect(cwd).not.toBe(work);
      expect(git('rev-parse HEAD', cwd)).toBe(git('rev-parse origin/trunk', work));
    } finally {
      cleanup();
    }
  });
});

describe('inbox PR scan', () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; });

  it("lists PRs against the repo's trunk, not a hard-coded develop", () => {
    const work = cloneWithTrunk();
    // Stub `gh`: record its argv, answer with one PR.
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const argsFile = join(root, 'gh-args');
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" > '${argsFile}'\necho '[{"number":7,"title":"t","createdAt":"2026-01-01T00:00:00Z","url":"u"}]'\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;

    const items = scanOpenPrs(work);
    expect(readFileSync(argsFile, 'utf-8')).toContain('--base trunk');
    expect(items).toHaveLength(1);
    expect(items[0].approveSemantics).toBe('merge to trunk (CI-gated squash)');
  });
});

describe('memory sync --push (#1247)', () => {
  it('commits only .agents/memory and pushes the current branch, not main', async () => {
    const work = cloneWithTrunk();
    git('checkout -q -b feature', work);
    git('push -q -u origin feature', work);

    // The operator has unrelated work staged; an agent updated memory.
    writeFileSync(join(work, 'README.md'), '# operator edit\n');
    git('add README.md', work);
    writeFileSync(join(work, '.agents', 'memory', 'cli', 'state.md'), 'v2\n');

    const cwd = process.cwd();
    process.chdir(work);
    try {
      await syncCommand({ push: true, pull: false });
    } finally {
      process.chdir(cwd);
    }

    // Memory committed and pushed to the operator's branch…
    expect(git('show origin/feature:.agents/memory/cli/state.md', work)).toBe('v2');
    expect(git('log -1 --format=%s', work)).toBe('chore: sync squad memory');
    const committed = git('show --name-only --format= HEAD', work).split('\n');
    expect(committed).toContain('.agents/memory/cli/state.md');
    for (const f of committed) expect(f.startsWith('.agents/memory/')).toBe(true);
    // …the operator's staged change is still staged, uncommitted…
    expect(git('diff --cached --name-only', work)).toBe('README.md');
    // …and no main branch was created or pushed on the remote.
    expect(git('ls-remote --heads origin', work)).not.toContain('refs/heads/main');
  });
});
