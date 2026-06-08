/**
 * worktree.ts
 *
 * Per-squad-RUN git worktree isolation for `squads run` (issue #440).
 *
 * Problem: when a squad runs, its agents execute with cwd = the squad's repo
 * checkout. Workers have full git/gh, so they switch branches, drop files, and
 * even open PRs *in the user's working checkout*. During an org cycle multiple
 * squads mutate multiple repos at once — unsafe.
 *
 * Design: ONE worktree per squad RUN (not per agent). All agents in a single
 * squad conversation (plan → execute → review → verify) share the same worktree
 * so the worker's changes are visible to the reviewer/verifier within that run.
 * The original checkout is never touched. Any branch the agents pushed is
 * preserved on the remote; only the local worktree directory is removed on
 * cleanup.
 *
 * Graceful degradation: if the dir isn't a git repo, or `worktree add` fails,
 * we fall back to running in-place (the original cwd) with a dim warning. We
 * NEVER crash the run because of worktree issues.
 *
 * Escape hatch: set env var SQUADS_NO_WORKTREE=1 to disable isolation entirely
 * (run in-place). Useful for debugging or environments where worktrees are
 * undesirable.
 */

import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { colors, RESET, writeLine } from './terminal.js';

/**
 * Result of attempting to create a per-run worktree.
 * - `cwd`     — directory the squad's agents should run in (worktree path,
 *               or the original repoDir if isolation was skipped/failed).
 * - `cleanup` — idempotent, never-throwing function that removes the worktree.
 *               A no-op when isolation was skipped or fell back in-place.
 */
export interface RunWorktree {
  cwd: string;
  cleanup: () => void;
}

/** Monotonic counter to disambiguate two runs of the same squad in the same ms. */
let runCounter = 0;

/**
 * Resolve the base branch for the worktree: prefer `develop` if it exists on
 * the repo, else the repo's current branch (HEAD). Falls back to 'HEAD' if the
 * current branch can't be determined.
 */
function resolveBaseRef(repoDir: string): string {
  // Prefer develop when present (product repos branch off develop).
  try {
    execSync('git rev-parse --verify --quiet refs/heads/develop', {
      cwd: repoDir,
      stdio: 'pipe',
    });
    return 'develop';
  } catch {
    // develop doesn't exist locally — fall through to current branch.
  }

  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoDir,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // Detached HEAD reports "HEAD" — usable as a base ref directly.
    return branch || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * Create a per-squad-RUN git worktree of `repoDir` and return the path its
 * agents should use plus a cleanup callback.
 *
 * The worktree is created at `<repoDir>/../.worktrees/squads-run-<squad>-<shortid>`
 * on a fresh branch `squads/run-<squad>-<shortid>`, based off `develop` (if it
 * exists) or the repo's current branch.
 *
 * On ANY failure (not a git repo, worktree add failed) this returns the
 * original `repoDir` as cwd with a no-op cleanup — the run continues in-place.
 *
 * @param repoDir   the squad's resolved repo checkout
 * @param squadName the squad name (used in branch + dir naming)
 */
export function createRunWorktree(repoDir: string, squadName: string): RunWorktree {
  const noop: RunWorktree = { cwd: repoDir, cleanup: () => {} };

  // Escape hatch: SQUADS_NO_WORKTREE=1 disables isolation entirely.
  if (process.env.SQUADS_NO_WORKTREE === '1') {
    return noop;
  }

  // Only isolate real git repos. checkGitStatus-style guard without the extra
  // git calls: a worktree needs a .git entry (dir for a checkout, file for a
  // nested worktree).
  if (!existsSync(join(repoDir, '.git'))) {
    return noop;
  }

  // <shortid>: ms timestamp + monotonic counter. Date.now() is used elsewhere
  // in this repo; the counter guarantees uniqueness when two squads (org cycle)
  // create worktrees within the same millisecond, so their dirs/branches can
  // never collide.
  const shortId = `${Date.now().toString(36)}-${(runCounter++).toString(36)}`;
  const slug = squadName.replace(/[^a-zA-Z0-9_-]/g, '-');
  const branchName = `squads/run-${slug}-${shortId}`;
  const worktreesRoot = join(repoDir, '..', '.worktrees');
  const worktreePath = join(worktreesRoot, `squads-run-${slug}-${shortId}`);

  const base = resolveBaseRef(repoDir);

  try {
    mkdirSync(worktreesRoot, { recursive: true });
    execSync(
      `git -C '${repoDir}' worktree add '${worktreePath}' -b '${branchName}' '${base}'`,
      { stdio: 'pipe' }
    );
  } catch (e) {
    writeLine(
      `  ${colors.dim}warn: worktree isolation unavailable for ${squadName}, running in-place: ${e instanceof Error ? e.message : String(e)}${RESET}`
    );
    return noop;
  }

  const cleanup = () => {
    try {
      // --force removes the worktree even with uncommitted changes. Safe:
      // any branch the agents pushed lives on the remote; this only drops the
      // local worktree dir. The branch ref is left for inspection (it shares
      // objects with the main repo and is cheap; `git worktree prune` + branch
      // cleanup can reclaim it later).
      execSync(`git -C '${repoDir}' worktree remove '${worktreePath}' --force`, {
        stdio: 'pipe',
      });
    } catch {
      // Non-critical — `git worktree prune` will reclaim it later.
    }
  };

  return { cwd: worktreePath, cleanup };
}
