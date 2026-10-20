/**
 * Harvest git hardening (#1311).
 *
 * After a lane finishes, the harness runs git in the lane's worktree OUTSIDE
 * any sandbox. The lane controls everything in that directory — including the
 * `.git` *file* that points at the gitdir. Rewriting it to a gitdir the lane
 * built (config with core.fsmonitor / core.hooksPath / a filter driver) would
 * make the next harness git call execute lane-chosen code with the operator's
 * rights. Two layers close that:
 *
 *  1. verifyWorktreeLink() — refuse to run ANY git in the worktree unless its
 *     `.git` file still points at <common-dir>/worktrees/<name>, the gitdir
 *     git created for it (and, when the creation-time link was recorded, that
 *     exact path).
 *  2. hardenedGitArgs()/hardenedGitFlags() — every harvest git call runs with
 *     hooks, fsmonitor, external diff, ssh command and filter drivers
 *     neutralised, so even a verified gitdir's config cannot run code. Only
 *     harvest calls get this: the operator's own commits keep their hooks
 *     (e.g. core.hooksPath=.husky).
 */

import { execFileSync } from 'child_process';
import { lstatSync, readFileSync, realpathSync } from 'fs';
import { dirname, join, resolve } from 'path';

export type WorktreeLinkCheck =
  | { ok: true; gitdir: string; commonDir: string }
  | { ok: false; reason: string };

/**
 * Read the `gitdir:` target out of a worktree's `.git` file. Call right after
 * `git worktree add` to record the creation-time link. Null when `.git` is
 * missing, not a regular file, or malformed.
 */
export function readWorktreeGitdirLink(workDir: string): string | null {
  const gitFile = join(workDir, '.git');
  try {
    const st = lstatSync(gitFile);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const match = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(gitFile, 'utf-8'));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function sameRealPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * Verify the worktree still belongs to projectRoot's repository: `.git` is a
 * regular file whose gitdir is a direct child of <common-dir>/worktrees/ and
 * whose back-link (`<gitdir>/gitdir`, written by git into the real common
 * dir) names this worktree. `expectedLink` — the `gitdir:` value recorded at
 * creation — must additionally match when supplied.
 */
export function verifyWorktreeLink(
  workDir: string,
  projectRoot: string,
  expectedLink?: string | null,
): WorktreeLinkCheck {
  const link = readWorktreeGitdirLink(workDir);
  if (!link) return { ok: false, reason: '.git is not a regular gitdir link file' };
  const gitdir = resolve(workDir, link);

  if (expectedLink && !sameRealPath(gitdir, resolve(workDir, expectedLink))) {
    return { ok: false, reason: `.git points at ${gitdir}, not the recorded ${expectedLink}` };
  }

  let commonDir: string;
  try {
    const out = execFileSync('git', ['-C', projectRoot, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    commonDir = resolve(projectRoot, out);
  } catch {
    return { ok: false, reason: `cannot resolve the common git dir of ${projectRoot}` };
  }

  if (!sameRealPath(dirname(gitdir), join(commonDir, 'worktrees'))) {
    return { ok: false, reason: `.git points at ${gitdir}, outside ${join(commonDir, 'worktrees')}` };
  }

  // The admin dir's back-link must name THIS worktree — stops a lane from
  // pointing at a sibling lane's (legitimate) admin dir.
  try {
    const back = readFileSync(join(gitdir, 'gitdir'), 'utf-8').trim();
    if (!sameRealPath(dirname(resolve(gitdir, back)), workDir)) {
      return { ok: false, reason: `${gitdir} belongs to a different worktree (${back})` };
    }
  } catch {
    return { ok: false, reason: `${gitdir} has no readable back-link to the worktree` };
  }

  // The admin dir lives inside the writable git common dir, so the lane can
  // edit it: `commondir` redirects git to a decoy common dir (its config's
  // filter drivers then run in harness git — verified), and `config.worktree`
  // injects config when extensions.worktreeConfig is on. squads never creates
  // either variant, so anything but the real common dir refuses.
  try {
    const cd = readFileSync(join(gitdir, 'commondir'), 'utf-8').trim();
    if (!sameRealPath(resolve(gitdir, cd), commonDir)) {
      return { ok: false, reason: `${gitdir}/commondir redirects to ${cd}, not ${commonDir}` };
    }
  } catch {
    return { ok: false, reason: `${gitdir} has no readable commondir` };
  }
  try {
    lstatSync(join(gitdir, 'config.worktree'));
    return { ok: false, reason: `${gitdir}/config.worktree exists (per-worktree config is never created by squads)` };
  } catch { /* absent — expected */ }
  return { ok: true, gitdir, commonDir };
}

/**
 * Env that pins git to the verified admin dir and the REAL common dir, so a
 * later edit of the `.git` file or of `commondir` cannot redirect harvest git
 * (GIT_COMMON_DIR outranks the commondir file). Apply to calls run in the
 * worktree only.
 */
export function pinnedGitEnv(workDir: string, gitdir: string, commonDir: string): Record<string, string> {
  return { GIT_DIR: gitdir, GIT_COMMON_DIR: commonDir, GIT_WORK_TREE: workDir };
}

/** Same pin as a shell env-assignment prefix (single-quoted values). */
export function pinnedGitEnvShell(workDir: string, gitdir: string, commonDir: string): string {
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  return Object.entries(pinnedGitEnv(workDir, gitdir, commonDir)).map(([k, v]) => `${k}=${q(v)}`).join(' ');
}

/**
 * Filter drivers named in the operator's repo config. `filter.<name>.*` has no
 * wildcard override, so each configured driver is neutralised by name; a
 * driver the lane invents has no command anywhere and is inert.
 */
function configuredFilterNames(projectRoot: string): string[] {
  try {
    const out = execFileSync(
      'git',
      ['-C', projectRoot, 'config', '--name-only', '--get-regexp', '^filter\\..+\\.(clean|smudge|process|required)$'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const names = new Set<string>();
    for (const key of out.split('\n')) {
      const m = /^filter\.([A-Za-z0-9_-]+)\.[a-z]+$/.exec(key.trim());
      if (m) names.add(m[1]);
    }
    return [...names];
  } catch {
    return []; // exit 1 = no matching keys
  }
}

/** `-c key=value` pairs (as argv) applied to every harvest git call. */
export function hardenedGitArgs(projectRoot: string): string[] {
  const overrides = [
    'core.hooksPath=/dev/null',
    'core.fsmonitor=false',
    'core.sshCommand=false',
    'diff.external=',
    'core.pager=cat',
    'protocol.ext.allow=never',
  ];
  for (const name of configuredFilterNames(projectRoot)) {
    // `cat` is a pass-through clean/smudge; process (long-running) is blanked.
    overrides.push(
      `filter.${name}.clean=cat`,
      `filter.${name}.smudge=cat`,
      `filter.${name}.process=`,
      `filter.${name}.required=false`,
    );
  }
  return overrides.flatMap((o) => ['-c', o]);
}

/** Same overrides as a shell fragment (single-quoted) for the detached wrapper. */
export function hardenedGitFlags(projectRoot: string): string {
  return hardenedGitArgs(projectRoot)
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ');
}
