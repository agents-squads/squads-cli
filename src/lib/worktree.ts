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
 * The original checkout is never touched.
 *
 * No silent data loss (#875): cleanup never force-removes a worktree that still
 * holds uncommitted/untracked work. A run whose lead ended BLOCKED on git/gh
 * write-approval leaves its deliverable only in the worktree — earlier this was
 * destroyed by `worktree remove --force`. Cleanup now auto-commits any dirty
 * tree to the run branch (which lives in the shared .git object store and
 * survives worktree removal) and best-effort pushes it before removing the
 * directory. If the work cannot be preserved, the worktree is left in place.
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
 * - `cleanup` — idempotent, never-throwing function that preserves any
 *               uncommitted work (auto-commit to the run branch) then removes
 *               the worktree. A no-op when isolation was skipped/fell back.
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

  // Fail-safe (#448): `git worktree add` can report success yet leave no
  // directory at `worktreePath` — observed under parallel org runs where one
  // squad's cleanup (`worktree remove`/prune) races another's create against the
  // SAME shared repo `.git`, corrupting the new worktree's admin metadata. If
  // the dir isn't there when we're about to hand it to an agent, fall back to
  // running in-place rather than letting the agent spawn into a missing cwd.
  if (!existsSync(worktreePath)) {
    writeLine(
      `  ${colors.dim}warn: worktree for ${squadName} reported created but ${worktreePath} is missing, running in-place${RESET}`
    );
    return noop;
  }

  const cleanup = () => {
    try {
      // No silent data loss (#875): a worktree may still hold uncommitted or
      // untracked deliverables — e.g. the lead ended BLOCKED on git/gh
      // write-approval and never committed. `worktree remove --force` would
      // destroy them. Preserve first, remove second.
      let dirty = '';
      try {
        dirty = execSync(`git -C '${worktreePath}' status --porcelain`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
      } catch {
        // status failed (worktree dir already gone / corrupt) — nothing to
        // preserve; fall through to the removal attempt below.
      }

      if (dirty) {
        try {
          // Commit everything to the run branch. That branch ref lives in the
          // shared .git object store, so the commit survives worktree removal
          // and is recoverable with `git checkout <branch>`. The `-c` identity
          // makes the commit succeed even when the sandbox has no configured
          // git user; --no-verify skips hooks during cleanup.
          execSync(`git -C '${worktreePath}' add -A`, { stdio: 'pipe' });
          execSync(
            `git -C '${worktreePath}' -c user.name='squads-run[bot]' -c user.email='squads-run@agents-squads.local' commit --no-verify -m 'squads run: auto-save uncommitted deliverables on cleanup (#875)'`,
            { stdio: 'pipe' }
          );
          writeLine(
            `  ${colors.yellow}saved uncommitted work to branch ${branchName} before cleanup (#875). Recover: git -C '${repoDir}' checkout ${branchName}${RESET}`
          );
          // Best-effort push so the deliverable is recoverable off-machine too.
          // Never block or fail cleanup on this (no remote / no auth / offline);
          // the local commit on the branch already guarantees no loss.
          // GIT_TERMINAL_PROMPT=0 + timeout prevent a credential prompt hanging
          // the run's exit path.
          try {
            execSync(`git -C '${worktreePath}' push -u origin '${branchName}'`, {
              stdio: 'pipe',
              timeout: 30_000,
              env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
            });
          } catch {
            // Local branch commit already preserves the work.
          }
        } catch (e) {
          // Could not preserve the work — DO NOT delete it. Leave the worktree
          // in place and tell the operator exactly where the deliverable is.
          writeLine(
            `  ${colors.red}WARN: could not auto-save uncommitted work in ${worktreePath} (#875) — leaving worktree in place to avoid data loss: ${e instanceof Error ? e.message : String(e)}${RESET}`
          );
          return;
        }
      }

      // Safe now: the tree is clean (or its changes were committed to the run
      // branch above). --force is fine — there is nothing left to lose.
      execSync(`git -C '${repoDir}' worktree remove '${worktreePath}' --force`, {
        stdio: 'pipe',
      });
    } catch {
      // Non-critical — `git worktree prune` will reclaim it later.
    }
  };

  return { cwd: worktreePath, cleanup };
}
