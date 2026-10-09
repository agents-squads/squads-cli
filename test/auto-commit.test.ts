import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
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
  isGhAuthFailure: vi.fn(() => false),
  buildBotGitCredentialEnv: vi.fn(() => ({})),
}));

vi.mock('../src/lib/run-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/run-utils.js')>()),
  getProjectRoot: vi.fn(),
}));

import { autoCommitAgentWork } from '../src/lib/execution-engine.js';
import { getProjectRoot } from '../src/lib/run-utils.js';
import { getBotPushUrl, detectGitHubRepo } from '../src/lib/github.js';

function git(cmd: string, cwd: string): string {
  return execSync(`git ${cmd}`, {
    encoding: 'utf-8',
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
}

describe('autoCommitAgentWork — opt-in, memory-only', () => {
  let root: string;
  let remote: string;
  const memoryFile = join('.agents', 'memory', 'demo', 'agent', 'state.md');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'squads-autocommit-'));
    remote = mkdtempSync(join(tmpdir(), 'squads-autocommit-remote-'));
    git('init -q --bare', remote);
    git('init -q -b main', root);
    writeFileSync(join(root, 'README.md'), 'base\n');
    git('add -A', root);
    git('commit -q -m base', root);
    git(`remote add origin '${remote}'`, root);
    git('push -q origin main', root);
    vi.mocked(getProjectRoot).mockReturnValue(root);
    // The agent wrote its memory; the operator has their own work in progress.
    mkdirSync(join(root, '.agents', 'memory', 'demo', 'agent'), { recursive: true });
    writeFileSync(join(root, memoryFile), 'last_run: now\n');
    writeFileSync(join(root, 'wip.ts'), 'operator work in progress\n');
    writeFileSync(join(root, 'staged.ts'), 'operator staged this\n');
    git('add staged.ts', root);
    delete process.env.SQUADS_AUTO_COMMIT;
    delete process.env.SQUADS_AUTO_PUSH;
  });

  afterEach(() => {
    delete process.env.SQUADS_AUTO_COMMIT;
    delete process.env.SQUADS_AUTO_PUSH;
    rmSync(root, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  });

  it('commits nothing by default and says where the memory changed', async () => {
    const head = git('rev-parse HEAD', root);
    const res = await autoCommitAgentWork('demo', 'agent', 'exec-1234567890');
    expect(res.committed).toBe(false);
    expect(res.message).toContain('SQUADS_AUTO_COMMIT=1');
    expect(git('rev-parse HEAD', root)).toBe(head);
  });

  it('with SQUADS_AUTO_COMMIT=1 commits ONLY the squad memory — operator work untouched, nothing pushed', async () => {
    process.env.SQUADS_AUTO_COMMIT = '1';
    const res = await autoCommitAgentWork('demo', 'agent', 'exec-1234567890');

    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(false);
    expect(git('show --name-only --format= HEAD', root).split('\n')).toEqual([memoryFile.split('\\').join('/')]);
    expect(git('log -1 --format=%s', root)).toMatch(/^memory\(demo\/agent\)/);
    // operator's staged file is still staged, untracked file still untracked
    expect(git('diff --cached --name-only', root)).toBe('staged.ts');
    expect(git('status --porcelain', root)).toContain('?? wip.ts');
    // nothing reached the remote
    expect(git('rev-parse main', remote)).toBe(git('rev-parse HEAD~1', root));
  });

  it('pushes only with SQUADS_AUTO_PUSH=1 as well', async () => {
    process.env.SQUADS_AUTO_COMMIT = '1';
    process.env.SQUADS_AUTO_PUSH = '1';
    const res = await autoCommitAgentWork('demo', 'agent', 'exec-1234567890');
    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(true);
    expect(git('rev-parse main', remote)).toBe(git('rev-parse HEAD', root));
  });

  it('never builds a token-bearing push URL (argv is visible in ps)', async () => {
    process.env.SQUADS_AUTO_COMMIT = '1';
    process.env.SQUADS_AUTO_PUSH = '1';
    vi.mocked(detectGitHubRepo).mockReturnValueOnce('org/repo');
    const res = await autoCommitAgentWork('demo', 'agent', 'exec-1234567890');
    expect(res.pushed).toBe(true); // no GitHub App configured -> pushed to origin as-is
    expect(vi.mocked(getBotPushUrl)).not.toHaveBeenCalled();
  });

  it('does nothing when the squad memory did not change, even if the operator has changes', async () => {
    process.env.SQUADS_AUTO_COMMIT = '1';
    rmSync(join(root, '.agents'), { recursive: true, force: true });
    const head = git('rev-parse HEAD', root);
    const res = await autoCommitAgentWork('demo', 'agent', 'exec-1234567890');
    expect(res).toEqual({ committed: false });
    expect(git('rev-parse HEAD', root)).toBe(head);
  });

  it('refuses to commit memory containing a secret, and unstages it', async () => {
    process.env.SQUADS_AUTO_COMMIT = '1';
    writeFileSync(join(root, memoryFile), `token: ghp_${'a'.repeat(36)}\n`);
    const head = git('rev-parse HEAD', root);
    const res = await autoCommitAgentWork('demo', 'agent', 'exec-1234567890');
    expect(res.committed).toBe(false);
    expect(res.error).toMatch(/blocked/);
    expect(git('rev-parse HEAD', root)).toBe(head);
    expect(git('diff --cached --name-only', root)).toBe('staged.ts');
  });

  it('rejects squad names that could escape the pathspec', async () => {
    process.env.SQUADS_AUTO_COMMIT = '1';
    for (const name of ['../demo', '..', '.', '.hidden']) {
      expect(await autoCommitAgentWork(name, 'agent', 'exec-1234567890')).toEqual({ committed: false });
    }
    expect(git('diff --cached --name-only', root)).toBe('staged.ts');
  });
});
