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
  buildOutcomeChangelog,
  changelogPullRequests,
  evaluateCommitGate,
  evaluateOutcomeGate,
  evaluatePatchGate,
  evaluateReleaseChecks,
  insertChangelogEntry,
  isReleaseHousekeeping,
  latestVersionTag,
  parseRoadmapOutcomes,
  proposeOutcomeVersion,
  proposeVersion,
  pullRequestsFromCommitSubjects,
  readPackageLockVersion,
  readPackageVersion,
  readSkillReferenceVersion,
  renderReleaseBody,
  repoLabels,
  type CommitBlocker,
  type OutcomeBlocker,
  type OutcomeGate,
  type OutcomeItem,
  type PatchBlocker,
  type PreparedReleaseFacts,
  type PullRequest,
  type ReleaseCheck,
  type ReleaseOutcome,
  type SiblingStatus,
} from '../lib/release-train.js';
import {
  FEATURES_FILE,
  ROADMAP_FILE,
  findFeatureFiles,
  gitShaExists,
  loadFeatureFile,
  parseFeatureList,
  type FeatureList,
  type ShaExists,
} from '../lib/features.js';
import { findOrgRoot } from '../lib/org-root.js';

const GIT_TIMEOUT_MS = 120_000;
const NPM_TIMEOUT_MS = 30 * 60 * 1000;

export interface ReleaseTrainOptions {
  dryRun?: boolean;
  source?: string;
  target?: string;
  tag?: string;
  json?: boolean;
  fetch?: boolean;
  /** Roadmap outcome that defines this release. */
  outcome?: string;
  /** Security-patch path: skips the outcome gate, accepts only security/fix. */
  patch?: boolean;
}

export interface ReleaseTrainDeps {
  runner?: Runner;
  root?: string;
  today?: string;
  /** Org root holding the control (HQ) repo; discovered when unset. */
  orgRoot?: string;
  /** Override the features.json sha-existence check in fixtures. */
  shaExists?: ShaExists;
  /** Override the ancestry check in fixtures without real history. */
  isAncestor?: (sha: string, source: string) => Promise<boolean>;
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

/** `<org root>/<control repo>/.agents/roadmap.json`, else directly under the root. */
export function roadmapPathFor(orgRoot: string, controlRepo = 'hq'): string {
  const direct = join(orgRoot, ROADMAP_FILE);
  return existsSync(direct) ? direct : join(orgRoot, controlRepo, ROADMAP_FILE);
}

async function shaIsAncestor(
  runner: Runner,
  root: string,
  sha: string,
  source: string,
): Promise<boolean> {
  try {
    await runner('git', ['merge-base', '--is-ancestor', sha, source], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** Read `ref:path` from git; null when the ref or path does not exist. */
async function readFileAtSource(
  runner: Runner,
  root: string,
  source: string,
  path: string,
): Promise<string | null> {
  try {
    return await runner('git', ['show', `${source}:${path}`], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return null;
  }
}

/**
 * Resolve an outcome against the HQ roadmap and this repo's feature list, and
 * check every item's verification ancestry. Throws for configuration errors
 * (no org root, no roadmap, unknown outcome, invalid features file); item-level
 * failures come back as blockers so the refusal can name each one.
 *
 * The gate reads both files from the release source ref, never the operator's
 * working tree: a doctored checkout must not satisfy a gate for data the
 * release does not ship (review F2).
 */
async function resolveOutcomeGate(input: {
  runner: Runner;
  root: string;
  source: string;
  outcomeId: string;
  deps: ReleaseTrainDeps;
}): Promise<OutcomeGate> {
  const { runner, root, source, outcomeId, deps } = input;

  // When the project itself holds the roadmap, it must be the roadmap on the
  // release source. Otherwise look for the HQ repo in the org root (that file
  // is outside this release's tree).
  let roadmapText: string | null = await readFileAtSource(runner, root, source, ROADMAP_FILE);
  let roadmapLabel = `${source}:${ROADMAP_FILE}`;
  if (roadmapText === null) {
    const org = deps.orgRoot
      ? { root: deps.orgRoot, controlRepo: 'hq' }
      : findOrgRoot(root);
    if (!org) {
      throw new Error(
        'Could not find the org root (set SQUADS_ORG_ROOT, or keep the repos under one parent directory).',
      );
    }
    const roadmap = roadmapPathFor(org.root, org.controlRepo);
    if (!existsSync(roadmap)) {
      throw new Error(`No roadmap found at ${roadmap}.`);
    }
    roadmapText = readFileSync(roadmap, 'utf8');
    roadmapLabel = roadmap;
  }

  const outcomes = parseRoadmapOutcomes(roadmapText);
  const outcome = outcomes.find((candidate) => candidate.id === outcomeId);
  if (!outcome) {
    throw new Error(
      `Outcome "${outcomeId}" not found in ${roadmapLabel} (known: ${outcomes.map((o) => o.id).join(', ') || 'none'}).`,
    );
  }

  const featuresRaw = await readFileAtSource(runner, root, source, FEATURES_FILE);
  if (featuresRaw === null) {
    throw new Error(
      `No ${FEATURES_FILE} at ${source}; the outcome gate has nothing to verify.`,
    );
  }
  const loaded = parseFeatureList(
    featuresRaw,
    root,
    `${source}:${FEATURES_FILE}`,
    deps.shaExists ?? gitShaExists,
  );
  // `passing-without-verification` is re-evaluated below with the stricter
  // ancestry rule; every other validator problem makes the file untrustworthy.
  const fatal = loaded.problems.filter((p) => p.code !== 'passing-without-verification');
  if (!loaded.list || fatal.length > 0) {
    throw new Error(
      `Invalid ${FEATURES_FILE} at ${source}: ${(fatal.length > 0 ? fatal : loaded.problems)
        .map((p) => p.message)
        .join('; ')}`,
    );
  }

  const list: FeatureList = loaded.list;
  const candidateShas = [
    ...new Set(
      list.items
        .flatMap((item) => item.verifications ?? [])
        .filter((v) => v.model !== v.builder_model)
        .map((v) => v.sha),
    ),
  ];
  const ancestor = new Map<string, boolean>();
  for (const sha of candidateShas) {
    ancestor.set(
      sha,
      deps.isAncestor ? await deps.isAncestor(sha, source) : await shaIsAncestor(runner, root, sha, source),
    );
  }

  return evaluateOutcomeGate({
    outcome,
    list,
    repoDir: root,
    source,
    isAncestor: (sha) => ancestor.get(sha) === true,
  });
}

/**
 * Outcome items owned by sibling repos. They are not part of this repo's gate;
 * report their status in the release body so the PR never overstates the claim.
 */
function siblingOutcomeItems(
  outcome: ReleaseOutcome,
  thisRepoRefs: Set<string>,
  root: string,
  deps: ReleaseTrainDeps,
): Array<{ ref: string; status: SiblingStatus }> {
  const refs = [...new Set(outcome.items)].filter((ref) => {
    if (thisRepoRefs.has(ref)) return false;
    const sep = ref.lastIndexOf(':');
    return sep > 0 && ref.slice(sep + 1).length > 0;
  });
  if (refs.length === 0) return [];

  const orgRoot = deps.orgRoot ?? findOrgRoot(root)?.root ?? null;
  if (!orgRoot) return refs.map((ref) => ({ ref, status: 'unknown' as const }));

  const statuses = new Map<string, SiblingStatus>();
  for (const file of findFeatureFiles(orgRoot)) {
    const loaded = loadFeatureFile(file, file, deps.shaExists ?? gitShaExists);
    if (!loaded.list || loaded.problems.length > 0) continue;
    const labels = repoLabels(loaded.list, loaded.repoDir);
    for (const ref of refs) {
      const sep = ref.lastIndexOf(':');
      const label = ref.slice(0, sep);
      const id = ref.slice(sep + 1);
      if (!labels.has(label)) continue;
      const item = loaded.list.items.find((candidate) => candidate.id === id);
      if (item) statuses.set(ref, item.status);
    }
  }
  return refs.map((ref) => ({ ref, status: statuses.get(ref) ?? 'unknown' }));
}

function printCommitRefusal(blockers: CommitBlocker[]): number {
  writeLine();
  writeLine(
    `  ${colors.red}Release train refused${RESET} — the release range contains commits that no PR accounts for.`,
  );
  for (const blocker of blockers) {
    writeLine(`    ${colors.red}blocked${RESET}  ${blocker.subject}: ${blocker.reason}`);
  }
  writeLine();
  writeLine(`  ${colors.dim}No branch, commit, push, or PR was created.${RESET}`);
  writeLine();
  return 1;
}

function printOutcomeRefusal(outcome: ReleaseOutcome, blockers: OutcomeBlocker[]): number {
  writeLine();
  writeLine(
    `  ${colors.red}Release train refused${RESET} — outcome ${outcome.id} (${outcome.name}) is not shipped.`,
  );
  for (const blocker of blockers) {
    writeLine(`    ${colors.red}blocked${RESET}  ${blocker.ref} — ${blocker.title}: ${blocker.reason}`);
  }
  writeLine();
  writeLine(`  ${colors.dim}No branch, commit, push, or PR was created.${RESET}`);
  writeLine();
  return 1;
}

function printPatchRefusal(blockers: PatchBlocker[]): number {
  writeLine();
  writeLine(`  ${colors.red}Release train refused${RESET} — --patch accepts only security or fix PRs.`);
  for (const blocker of blockers) {
    writeLine(`    ${colors.red}blocked${RESET}  #${blocker.number} — ${blocker.title}: ${blocker.reason}`);
  }
  writeLine();
  writeLine(`  ${colors.dim}No branch, commit, push, or PR was created.${RESET}`);
  writeLine();
  return 1;
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

/**
 * Commit subjects that will actually ship: `<merge-base(target, source)>..source`.
 * Used to prove every shipped commit is attributable to a PR (review F3).
 */
async function collectReleaseCommitSubjects(
  runner: Runner,
  root: string,
  target: string,
  source: string,
): Promise<string[]> {
  const targetRef = target.includes('/') ? target : `origin/${target}`;
  const base = (
    await runner('git', ['merge-base', targetRef, source], {
      cwd: root,
      timeout: GIT_TIMEOUT_MS,
    })
  ).trim();
  const output = await runner('git', ['log', '--format=%s', `${base}..${source}`], {
    cwd: root,
    timeout: GIT_TIMEOUT_MS,
  });
  return output.split('\n');
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
  changelogExpectation?: PreparedReleaseFacts['changelogExpectation'],
): PreparedReleaseFacts {
  return {
    version,
    prs,
    changelogEntry,
    changelogFile: readFileSync(join(worktree, CHANGELOG_PATH), 'utf8'),
    packageVersion: readPackageVersion(worktree),
    packageLockVersion: readPackageLockVersion(worktree),
    skillReferenceVersion: readSkillReferenceVersion(worktree),
    ...(changelogExpectation ? { changelogExpectation } : {}),
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
  const mode: 'outcome' | 'patch' | null = options.outcome
    ? 'outcome'
    : options.patch
      ? 'patch'
      : null;

  if (options.outcome && options.patch) {
    throw new Error('Use either --outcome <id> or --patch, not both.');
  }
  if (!mode) {
    throw new Error(
      'A release is defined by an outcome: pass --outcome <id> (or --patch for a security patch).',
    );
  }

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

  let outcome: ReleaseOutcome | null = null;
  let items: OutcomeItem[] = [];
  let otherPrs: PullRequest[] = prs;

  if (mode === 'outcome' && options.outcome) {
    const gate = await resolveOutcomeGate({
      runner,
      root,
      source,
      outcomeId: options.outcome,
      deps,
    });
    if (!gate.ok) {
      if (options.json) {
        writeLine(
          JSON.stringify(
            {
              refused: true,
              outcome: { id: gate.outcome.id, name: gate.outcome.name },
              blockers: gate.blockers,
            },
            null,
            2,
          ),
        );
      } else {
        printOutcomeRefusal(gate.outcome, gate.blockers);
      }
      return 1;
    }
    outcome = gate.outcome;
    items = gate.items;
    otherPrs = changelogPullRequests(prs);
  } else {
    const gate = evaluatePatchGate(prs);
    if (!gate.ok) {
      if (options.json) {
        writeLine(JSON.stringify({ refused: true, patch: true, blockers: gate.blockers }, null, 2));
      } else {
        printPatchRefusal(gate.blockers);
      }
      return 1;
    }
  }

  const commitSubjects = await collectReleaseCommitSubjects(runner, root, target, source);
  const commitGate = evaluateCommitGate(commitSubjects, prs, mode);
  if (!commitGate.ok) {
    if (options.json) {
      writeLine(
        JSON.stringify(
          { refused: true, unattributed_commits: commitGate.blockers },
          null,
          2,
        ),
      );
    } else {
      printCommitRefusal(commitGate.blockers);
    }
    return 1;
  }

  if (prs.length === 0 && items.length === 0) {
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

  const proposal =
    mode === 'outcome'
      ? proposeOutcomeVersion(current.version, outcome?.id ?? 'outcome')
      : proposeVersion(prs, current.version);
  if (!proposal) return 0;

  const siblingItems =
    outcome !== null
      ? siblingOutcomeItems(outcome, new Set(items.map((item) => item.ref)), root, deps)
      : [];

  const changelog =
    mode === 'outcome' && outcome
      ? buildOutcomeChangelog(
          {
            outcome: { id: outcome.id, name: outcome.name },
            items,
            otherPrs,
          },
          { version: proposal.version, date: today },
        )
      : buildChangelog(prs, { version: proposal.version, date: today });

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
            other_prs: otherPrs,
            ...(outcome
              ? {
                  outcome: { id: outcome.id, name: outcome.name },
                  outcome_items: items.map((item) => ({
                    ref: item.ref,
                    id: item.id,
                    title: item.title,
                    issue: item.issue ?? null,
                    status: item.status,
                  })),
                  sibling_items: siblingItems,
                }
              : { patch: true }),
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
        prs: otherPrs,
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

    const changelogExpectation =
      mode === 'outcome'
        ? {
            bullets: items.length + otherPrs.length,
            prNumbers: otherPrs.map((pr) => pr.number),
            itemBullets: items.length,
          }
        : undefined;
    const fileChecks = evaluateReleaseChecks(
      readPreparedFacts(worktree, proposal.version, prs, changelog, changelogExpectation),
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
      ...(outcome
        ? {
            outcome: { id: outcome.id, name: outcome.name, items: items.length },
            ...(siblingItems.length > 0 ? { siblingItems } : {}),
          }
        : { patch: true }),
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
            ...(outcome ? { outcome: { id: outcome.id, name: outcome.name }, items: items.length } : { patch: true }),
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
