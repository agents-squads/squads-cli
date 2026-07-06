/**
 * Repo-scoped git identity fallback (#980).
 *
 * A fresh machine with no `user.name`/`user.email` configured (locally or
 * globally) makes every git write squads performs fail with "Author identity
 * unknown" — `squads init`'s scaffold commit ends with zero commits (while
 * still reporting success), and `squads run`'s worktree isolation silently
 * disables itself. gitIdentityArgs() supplies a commit-scoped `-c` fallback
 * ONLY when no identity is configured anywhere for the repo — never writing
 * to git config itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import * as terminal from '../src/lib/terminal';
import { gitIdentityArgs, resetGitIdentityFallbackHintForTests } from '../src/lib/git';
import { commitInitScaffold } from '../src/commands/init';
import { createRunWorktree } from '../src/lib/worktree';

const ISOLATED_ENV_KEYS = [
  'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
  'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
] as const;

/** Isolate git's identity resolution from the real machine/CI environment:
 *  fresh HOME (no ~/.gitconfig), no system config, no author/committer env
 *  vars (which would otherwise outrank our -c flags), and no hook-injected
 *  GIT_DIR/GIT_WORK_TREE pointing at some other repo. */
function isolateGitEnv(fakeHome: string, saved: Record<string, string | undefined>): void {
  for (const key of ISOLATED_ENV_KEYS) saved[key] = process.env[key];
  for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
  process.env.HOME = fakeHome;
  process.env.XDG_CONFIG_HOME = join(fakeHome, '.config');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
}

function restoreGitEnv(saved: Record<string, string | undefined>): void {
  for (const key of ISOLATED_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe('gitIdentityArgs (#980)', () => {
  let dir: string;
  let fakeHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'squads-git-identity-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'squads-git-identity-home-'));
    isolateGitEnv(fakeHome, saved);
    resetGitIdentityFallbackHintForTests();
  });

  afterEach(() => {
    restoreGitEnv(saved);
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns fallback -c flags when no identity is configured anywhere', () => {
    execSync('git init -q -b main', { cwd: dir, stdio: 'pipe' });
    const args = gitIdentityArgs(dir);
    expect(args).toContain("user.name='squads'");
    expect(args).toContain("user.email='squads-agent@localhost'");
  });

  it('returns empty string when a LOCAL repo identity is configured', () => {
    execSync('git init -q -b main', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.email dev@example.com', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name Dev', { cwd: dir, stdio: 'pipe' });
    expect(gitIdentityArgs(dir)).toBe('');
  });

  it('returns empty string when only a GLOBAL identity is configured (no local override)', () => {
    execSync('git init -q -b main', { cwd: dir, stdio: 'pipe' });
    execSync('git config --global user.email global@example.com', { cwd: dir, stdio: 'pipe' });
    execSync('git config --global user.name Global', { cwd: dir, stdio: 'pipe' });
    expect(gitIdentityArgs(dir)).toBe('');
  });

  it('never writes to local or global git config', () => {
    execSync('git init -q -b main', { cwd: dir, stdio: 'pipe' });
    gitIdentityArgs(dir);
    const local = execSync('git config --list --local', { cwd: dir, encoding: 'utf-8' });
    expect(local).not.toContain('user.name');
    expect(local).not.toContain('user.email');
    expect(existsSync(join(fakeHome, '.gitconfig'))).toBe(false);
  });

  it('prints the fallback hint exactly once across repeated calls', () => {
    execSync('git init -q -b main', { cwd: dir, stdio: 'pipe' });
    const spy = vi.spyOn(terminal, 'writeLine');
    gitIdentityArgs(dir);
    gitIdentityArgs(dir);
    gitIdentityArgs(dir);
    const hintCalls = spy.mock.calls.filter((c) => String(c[0]).includes('fallback git identity'));
    expect(hintCalls).toHaveLength(1);
    spy.mockRestore();
  });
});

describe('commitInitScaffold (#980) — squads init auto-commit', () => {
  let dir: string;
  let fakeHome: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'squads-init-commit-'));
    fakeHome = mkdtempSync(join(tmpdir(), 'squads-init-commit-home-'));
    isolateGitEnv(fakeHome, saved);
    resetGitIdentityFallbackHintForTests();
    execSync('git init -q -b main', { cwd: dir, stdio: 'pipe' });
    writeFileSync(join(dir, 'AGENTS.md'), '# scaffold\n');
  });

  afterEach(() => {
    restoreGitEnv(saved);
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('(a) succeeds with no git identity configured, authored as the fallback identity', () => {
    expect(() => commitInitScaffold(dir)).not.toThrow();

    const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' }).trim();
    expect(log.split('\n')).toHaveLength(1); // exactly one commit — not zero (#980's bug)

    const author = execSync("git log -1 --format='%an <%ae>'", { cwd: dir, encoding: 'utf-8' }).trim();
    expect(author).toBe('squads <squads-agent@localhost>');
  });

  it('(b) a subsequent `git worktree add` succeeds against a repo whose only commit came from the fallback identity', () => {
    commitInitScaffold(dir); // repo now has exactly 1 commit, authored via the fallback

    const { cwd, cleanup } = createRunWorktree(dir, 'demo');
    expect(cwd).not.toBe(dir);
    expect(existsSync(cwd)).toBe(true);

    const list = execSync(`git -C '${dir}' worktree list`, { encoding: 'utf-8' });
    expect(list).toContain(cwd);
    cleanup();
  });

  it('(c) when a repo identity is already configured, the commit uses it with no extra -c flags applied', () => {
    execSync('git config user.email dev@example.com', { cwd: dir, stdio: 'pipe' });
    execSync('git config user.name Dev', { cwd: dir, stdio: 'pipe' });

    expect(gitIdentityArgs(dir)).toBe('');

    commitInitScaffold(dir);
    const author = execSync("git log -1 --format='%an <%ae>'", { cwd: dir, encoding: 'utf-8' }).trim();
    expect(author).toBe('Dev <dev@example.com>');
  });

  it('is a no-op (does not throw) when there is nothing to commit', () => {
    commitInitScaffold(dir);
    expect(() => commitInitScaffold(dir)).not.toThrow(); // second call: clean tree, nothing staged
    const log = execSync('git log --oneline', { cwd: dir, encoding: 'utf-8' }).trim();
    expect(log.split('\n')).toHaveLength(1); // still exactly one commit
  });
});
