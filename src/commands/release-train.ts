/**
 * `squads release train` — the weekly release train (agents-squads/squads-cli#1320).
 *
 * Plans the release from the last version tag, builds the changelog, proposes
 * the semver bump, runs release-check, and opens the release PR. With
 * `--dry-run` it prints the same plan and changes nothing.
 *
 * It never tags, publishes, or dispatches a workflow: after the maintainer
 * squash-merges the PR, RELEASING.md's existing tag → publish steps take over.
 */

import { execFile } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { colors, RESET, bold, writeLine } from '../lib/terminal.js';
import {
  CHANGELOG_PATH,
  buildChangelog,
  evaluateReleaseChecks,
  insertChangelogEntry,
  isReleaseHousekeeping,
  latestVersionTag,
  proposeVersion,
  pullRequestsFromCommitSubjects,
  readPackageLockVersion,
  readPackageVersion,
  readSkillReferenceVersion,
  renderReleaseBody,
  type PreparedReleaseFacts,
  type PullRequest,
  type ReleaseCheck,
} from '../lib/release-train.js';

const GIT_TIMEOUT_MS = 120_000;
const NPM_TIMEOUT_MS = 30 * 60 * 1000;

export interface ReleaseTrainOptions {
  dryRun?: boolean;
  source?: string;
  target?: string;
  tag?: string;
  json?: boolean;
  fetch?: boolean;
}

export interface ReleaseTrainDeps {
  runner?: Runner;
  root?: string;
  today?: string;
}

export type Runner = (
  file: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<string>;

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    encoding?: BufferEncoding;
    windowsHide?: boolean;
  },
) => Promise<{ stdout: string; stderr: string }>;

export function defaultRunner(
  file: string,
  args: string[],
  options: { cwd?: string; timeout?: number } = {},
): Promise<string> {
  return execFileAsync(file, args, {
    cwd: options.cwd,
    timeout: options.timeout ?? GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  }).then((result) => result.stdout);
}

async function resolveRoot(runner: Runner, deps: ReleaseTrainDeps): Promise<string> {
  if (deps.root) return deps.root;
  const top = await runner('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    timeout: GIT_TIMEOUT_MS,
  });
  return top.trim();
}

async function readVersionAtRef(
  runner: Runner,
  root: string,
  ref: string,
): Promise<{ version: string; origin: string }> {
  try {
    const text = await runner('git', ['show', `${ref}:package.json`], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    });
    const pkg = JSON.parse(text) as { version?: string };
    if (pkg.version) return { version: pkg.version, origin: ref };
  } catch {
    // Local-only repos (or a test fixture) may not have the ref; the working
    // tree is the next best source and the caller reports it.
  }
  return { version: readPackageVersion(root), origin: 'working tree' };
}

async function collectPullRequests(
  runner: Runner,
  root: string,
  tag: string,
  source: string,
): Promise<PullRequest[]> {
  const tagDate = (
    await runner('git', ['log', '-1', '--format=%cI', tag], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    })
  ).trim();

  // Preferred source: GitHub's own merged-PR list for the branch. It is exact
  // even when develop has not been back-merged yet. The git fallback parses
  // squash subjects by commit date, so neither path resurfaces the previous
  // release the way `<tag>..develop` does after a squash merge.
  const base = source.replace(/^origin\//, '');
  try {
    const output = await runner(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'merged',
        '--base',
        base,
        '--limit',
        '1000',
        '--json',
        'number,title,mergedAt,url',
      ],
      { cwd: root, timeout: GIT_TIMEOUT_MS },
    );
    const merged = JSON.parse(output) as Array<{
      number: number;
      title: string;
      mergedAt: string;
      url?: string;
    }>;
    const cutoff = new Date(tagDate).getTime();
    const byNumber = new Map<number, PullRequest>();

    for (const pr of merged) {
      if (new Date(pr.mergedAt).getTime() <= cutoff) continue;
      if (isReleaseHousekeeping(pr.title)) continue;
      byNumber.set(pr.number, {
        number: pr.number,
        title: pr.title,
        mergedAt: pr.mergedAt,
        ...(pr.url ? { url: pr.url } : {}),
      });
    }

    return [...byNumber.values()].sort((a, b) => a.number - b.number);
  } catch {
    const subjects = await runner(
      'git',
      ['log', '--since', tagDate, '--format=%s', source],
      { cwd: root, timeout: GIT_TIMEOUT_MS },
    );
    return pullRequestsFromCommitSubjects(subjects.split('\n'));
  }
}

function printHumanPlan(input: {
  tag: string;
  source: string;
  sourceSha: string;
  version: string;
  bump: string;
  reason: string;
  prs: PullRequest[];
  changelog: string;
  dryRun: boolean;
}): void {
  writeLine();
  writeLine(
    `  ${bold}Release train${RESET}  ${input.tag} → v${input.version} ${colors.dim}(${input.bump}: ${input.reason})${RESET}`,
  );
  writeLine(
    `  ${colors.dim}source: ${input.source} @ ${input.sourceSha.slice(0, 12)} — ${input.prs.length} PR${input.prs.length === 1 ? '' : 's'}${RESET}`,
  );
  writeLine();
  for (const line of input.changelog.trimEnd().split('\n')) {
    writeLine(`  ${line}`);
  }
  writeLine();
  if (input.dryRun) {
    writeLine(`  ${colors.dim}release-check: not run (dry run — no files changed)${RESET}`);
    writeLine(`  ${colors.dim}Run without --dry-run to prepare the branch and gate it on release-check.${RESET}`);
  }
  writeLine();
}

async function runGate(
  runner: Runner,
  cwd: string,
  name: string,
  file: string,
  args: string[],
): Promise<ReleaseCheck> {
  try {
    await runner(file, args, { cwd, timeout: NPM_TIMEOUT_MS });
    return { name, ok: true, detail: '' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name, ok: false, detail: message.split('\n')[0] ?? message };
  }
}

/** Bump both files without `npm version`, which refuses to run on a dirty tree. */
export function bumpPackageFiles(worktree: string, version: string): void {
  const packagePath = join(worktree, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string };
  pkg.version = version;
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const lockPath = join(worktree, 'package-lock.json');
  if (!existsSync(lockPath)) return;
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    version?: string;
    packages?: Record<string, { version?: string } | undefined>;
  };
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function linkNodeModules(root: string, worktree: string): void {
  const modules = join(root, 'node_modules');
  if (!existsSync(modules)) {
    throw new Error(
      `node_modules not found at ${modules}. Run "npm install" in the repo root before preparing a release.`,
    );
  }
  symlinkSync(
    modules,
    join(worktree, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

/**
 * Prepare the release branch from `main` and set its tree to `develop`, so the
 * squash-merge does not resurface the previous release (RELEASING.md's
 * divergence trap). Package bump and changelog then ride on that tree.
 */
async function prepareReleaseWorktree(
  runner: Runner,
  root: string,
  source: string,
  target: string,
  branch: string,
  version: string,
  changelogEntry: string,
): Promise<{ worktree: string; gates: ReleaseCheck[] }> {
  const worktree = mkdtempSync(join(tmpdir(), 'squads-release-train-'));
  const targetRef = target.includes('/') ? target : `origin/${target}`;

  try {
    await runner('git', ['worktree', 'add', '-b', branch, worktree, targetRef], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    });

    await runner('git', ['restore', `--source=${source}`, '--worktree', '--staged', ':/'], {
      cwd: worktree,
      timeout: GIT_TIMEOUT_MS,
    });

    linkNodeModules(root, worktree);

    bumpPackageFiles(worktree, version);

    const changelogPath = join(worktree, CHANGELOG_PATH);
    const existing = readFileSync(changelogPath, 'utf8');
    writeFileSync(changelogPath, insertChangelogEntry(existing, changelogEntry));

    const gates: ReleaseCheck[] = [];
    gates.push(await runGate(runner, worktree, 'npm run build', 'npm', ['run', 'build']));
    if (gates.at(-1)?.ok) {
      gates.push(
        await runGate(runner, worktree, 'npm run gen:skill', 'npm', ['run', 'gen:skill']),
      );
    }
    if (gates.every((gate) => gate.ok)) {
      gates.push(await runGate(runner, worktree, 'npm run lint', 'npm', ['run', 'lint']));
      gates.push(
        await runGate(runner, worktree, 'npm run typecheck', 'npm', ['run', 'typecheck']),
      );
      gates.push(await runGate(runner, worktree, 'npm test', 'npm', ['test']));
    }

    return { worktree, gates };
  } catch (error) {
    try {
      await runner('git', ['worktree', 'remove', '--force', worktree], {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
      });
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
    throw error;
  }
}

function readPreparedFacts(
  worktree: string,
  version: string,
  prs: PullRequest[],
  changelogEntry: string,
): PreparedReleaseFacts {
  return {
    version,
    prs,
    changelogEntry,
    changelogFile: readFileSync(join(worktree, CHANGELOG_PATH), 'utf8'),
    packageVersion: readPackageVersion(worktree),
    packageLockVersion: readPackageLockVersion(worktree),
    skillReferenceVersion: readSkillReferenceVersion(worktree),
  };
}

function printChecks(checks: ReleaseCheck[]): void {
  writeLine();
  writeLine(`  ${bold}release-check${RESET}`);
  for (const check of checks) {
    const marker = check.ok ? `${colors.green}pass${RESET}` : `${colors.red}FAIL${RESET}`;
    writeLine(`    ${marker}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }
  writeLine();
}

/** The maintainer's calendar date; `toISOString` would give UTC's. */
function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function releaseTrainCommand(
  options: ReleaseTrainOptions = {},
  deps: ReleaseTrainDeps = {},
): Promise<number> {
  const runner = deps.runner ?? defaultRunner;
  const root = await resolveRoot(runner, deps);
  const source = options.source ?? 'origin/develop';
  const target = options.target ?? 'main';
  const dryRun = options.dryRun === true;
  const today = deps.today ?? localDate(new Date());

  if (options.fetch) {
    await runner('git', ['fetch', 'origin', '--tags', '--quiet'], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    });
  }

  const tag =
    options.tag ??
    latestVersionTag(
      await runner('git', ['tag', '--sort=-v:refname', '--list', 'v[0-9]*'], {
        cwd: root,
        timeout: GIT_TIMEOUT_MS,
      }),
    );

  if (!tag) {
    throw new Error('No version tag found (expected vX.Y.Z).');
  }

  const previousVersion = tag.replace(/^v/, '');
  const current = await readVersionAtRef(runner, root, source);
  const prs = await collectPullRequests(runner, root, tag, source);
  const sourceSha = (
    await runner('git', ['rev-parse', source], { cwd: root, timeout: GIT_TIMEOUT_MS })
  ).trim();

  if (prs.length === 0) {
    if (options.json) {
      writeLine(
        JSON.stringify(
          { from_tag: tag, source, source_sha: sourceSha, prs: [], proposed_version: null },
          null,
          2,
        ),
      );
    } else {
      writeLine();
      writeLine(`  ${colors.dim}Nothing to release — no PRs merged to ${source} since ${tag}.${RESET}`);
      writeLine();
    }
    return 0;
  }

  const proposal = proposeVersion(prs, current.version);
  if (!proposal) return 0;

  const changelog = buildChangelog(prs, { version: proposal.version, date: today });

  if (dryRun) {
    if (options.json) {
      writeLine(
        JSON.stringify(
          {
            dry_run: true,
            from_tag: tag,
            previous_version: previousVersion,
            current_version: current.version,
            current_version_source: current.origin,
            proposed_version: proposal.version,
            bump: proposal.bump,
            reason: proposal.reason,
            source,
            source_sha: sourceSha,
            prs,
            changelog,
          },
          null,
          2,
        ),
      );
    } else {
      printHumanPlan({
        tag,
        source,
        sourceSha,
        version: proposal.version,
        bump: proposal.bump,
        reason: proposal.reason,
        prs,
        changelog,
        dryRun: true,
      });
    }
    return 0;
  }

  const branch = `release/v${proposal.version}`;
  let worktree: string | null = null;
  let pushed = false;

  try {
    const prepared = await prepareReleaseWorktree(
      runner,
      root,
      source,
      target,
      branch,
      proposal.version,
      changelog,
    );
    worktree = prepared.worktree;

    const fileChecks = evaluateReleaseChecks(
      readPreparedFacts(worktree, proposal.version, prs, changelog),
    );
    const checks = [...fileChecks, ...prepared.gates];

    if (!checks.every((check) => check.ok)) {
      printChecks(checks);
      throw new Error('release-check failed — the release PR was not opened.');
    }

    const body = renderReleaseBody({
      tag,
      previousVersion,
      proposal,
      prs,
      changelog,
      checks,
      source,
      sourceSha,
    });

    await runner('git', ['add', '-A'], { cwd: worktree, timeout: GIT_TIMEOUT_MS });
    // `node_modules` is a symlink here, and `.gitignore`'s `node_modules/`
    // only matches directories, so `add -A` stages the link. Unstage it; an
    // exclude pathspec instead errors when a global ignore already hides it.
    await runner('git', ['rm', '--cached', '--ignore-unmatch', '-q', 'node_modules'], {
      cwd: worktree,
      timeout: GIT_TIMEOUT_MS,
    });
    await runner('git', ['commit', '-m', `release: v${proposal.version}`], {
      cwd: worktree,
      timeout: GIT_TIMEOUT_MS,
    });
    await runner('git', ['push', '-u', 'origin', branch], {
      cwd: worktree,
      timeout: GIT_TIMEOUT_MS,
    });
    pushed = true;

    const url = (
      await runner(
        'gh',
        [
          'pr',
          'create',
          '--base',
          target,
          '--head',
          branch,
          '--title',
          `release: v${proposal.version}`,
          '--body',
          body,
        ],
        { cwd: worktree, timeout: GIT_TIMEOUT_MS },
      )
    ).trim();

    if (options.json) {
      writeLine(
        JSON.stringify(
          {
            dry_run: false,
            from_tag: tag,
            proposed_version: proposal.version,
            bump: proposal.bump,
            branch,
            url,
            checks,
          },
          null,
          2,
        ),
      );
    } else {
      printChecks(checks);
      writeLine(`  ${colors.green}Release PR opened${RESET} ${url}`);
      writeLine(`  ${colors.dim}No tag, publish, or workflow dispatch was performed.${RESET}`);
      writeLine();
    }

    return 0;
  } finally {
    if (worktree) {
      try {
        await runner(
          'git',
          ['worktree', 'remove', '--force', worktree],
          { cwd: root, timeout: GIT_TIMEOUT_MS },
        );
      } catch {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
    if (!pushed) {
      try {
        await runner('git', ['branch', '-D', branch], {
          cwd: root,
          timeout: GIT_TIMEOUT_MS,
        });
      } catch {
        // The branch may not exist when preparation failed early.
      }
    }
  }
}
