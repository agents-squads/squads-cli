/**
 * Release train (agents-squads/squads-cli#1320).
 *
 * Turns an **outcome** into one reviewable release PR:
 *   roadmap outcome → passing, independently verified items → changelog →
 *   semver bump → release-check
 *
 * A release is defined by an outcome, not by a count of merged PRs. The train
 * refuses unless every item the outcome names for this repo is `passing` with a
 * verification whose `model` differs from `builder_model` and whose `sha` is an
 * ancestor of the release source. Security patches keep a separate path:
 * `--patch` skips the outcome gate but only accepts `security…` / `fix…` PRs.
 *
 * Two constraints shape the implementation:
 *
 * 1. `develop` → `main` is squash-merged, so `git log <tag>..develop` surfaces
 *    the previous release again after every back-merge (see RELEASING.md,
 *    "Trap: squash-merge divergence"). PRs are therefore selected by merge
 *    time after the tag's commit, not by ancestry.
 * 2. The train never publishes. It prepares a branch and opens a PR; the
 *    maintainer merges, tags and dispatches `publish.yml`.
 *
 * Everything in this module except the readers is pure, so the gate, changelog
 * and version rules are tested against fixtures.
 */

import { readFileSync } from 'fs';
import { basename, join } from 'path';
import type { FeatureItem, FeatureList, FeatureVerification } from './features.js';

// ── Contract ─────────────────────────────────────────────────────────

export type Bump = 'major' | 'minor' | 'patch';

export interface PullRequest {
  number: number;
  title: string;
  url?: string;
  mergedAt?: string;
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

export interface ProposedVersion {
  version: string;
  bump: Bump;
  reason: string;
}

export interface ReleaseCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreparedReleaseFacts {
  version: string;
  prs: PullRequest[];
  /** The new `## [version]` section only — historical bullets must not count. */
  changelogEntry: string;
  /** The whole CHANGELOG.md, used to prove the entry landed. */
  changelogFile: string;
  packageVersion: string;
  packageLockVersion: string | null;
  skillReferenceVersion: string | null;
  /**
   * Outcome releases also list the outcome's items, so the changelog is not
   * one line per PR. `itemBullets` are the leading lines that carry issue
   * numbers, not PR numbers. Defaults to `prs` for patch releases.
   */
  changelogExpectation?: { bullets: number; prNumbers: number[]; itemBullets?: number };
}

export interface ReleaseBodyInput {
  tag: string;
  previousVersion: string;
  proposal: ProposedVersion;
  prs: PullRequest[];
  changelog: string;
  checks: ReleaseCheck[];
  source: string;
  sourceSha: string;
  /** Set when the release is defined by a roadmap outcome. */
  outcome?: { id: string; name: string; items: number };
  /** Set for the security-patch path (`--patch`). */
  patch?: boolean;
}

/** One outcome in the HQ repo's `.agents/roadmap.json`. */
export interface ReleaseOutcome {
  id: string;
  name: string;
  /** `<repo>:<id>` references across repos. */
  items: string[];
}

/** An outcome item resolved against this repo's `.agents/features.json`. */
export interface OutcomeItem {
  /** `squads-cli:R1`, as written in the roadmap. */
  ref: string;
  id: string;
  title: string;
  issue?: string;
  status: FeatureItem['status'];
  verifications: FeatureVerification[];
}

export interface OutcomeBlocker {
  /** `<repo>:<id>` the roadmap named. */
  ref: string;
  id: string;
  title: string;
  /** Why this item blocks the release, in maintainer terms. */
  reason: string;
}

export interface OutcomeGate {
  outcome: ReleaseOutcome;
  items: OutcomeItem[];
  blockers: OutcomeBlocker[];
  ok: boolean;
}

export interface PatchBlocker {
  number: number;
  title: string;
  reason: string;
}

export interface PatchGate {
  blockers: PatchBlocker[];
  ok: boolean;
}

export const CHANGELOG_PATH = 'CHANGELOG.md';
export const SKILL_REFERENCE_PATH = join(
  'templates',
  'seed',
  'skills',
  'squads-cli',
  'references',
  'commands.md',
);

// ── Semver ───────────────────────────────────────────────────────────

const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(value: string): Semver | null {
  const match = SEMVER_RE.exec(value.trim());
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(prerelease ? { prerelease } : {}),
  };
}

export function formatSemver(version: Semver): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease ? `${base}-${version.prerelease}` : base;
}

export function bumpSemver(current: Semver, bump: Bump): Semver {
  if (bump === 'major') return { major: current.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor') return { major: current.major, minor: current.minor + 1, patch: 0 };
  return { major: current.major, minor: current.minor, patch: current.patch + 1 };
}

/** Highest valid `vX.Y.Z` in `git tag --sort=-v:refname` output. */
export function latestVersionTag(tags: string): string | null {
  return (
    tags
      .split('\n')
      .map((tag) => tag.trim())
      .filter((tag) => parseSemver(tag) !== null)
      .sort((a, b) => {
        const av = parseSemver(a)!;
        const bv = parseSemver(b)!;
        if (av.major !== bv.major) return av.major - bv.major;
        if (av.minor !== bv.minor) return av.minor - bv.minor;
        if (av.patch !== bv.patch) return av.patch - bv.patch;
        if (av.prerelease === bv.prerelease) return 0;
        if (!av.prerelease) return 1;
        if (!bv.prerelease) return -1;
        return av.prerelease.localeCompare(bv.prerelease);
      })
      .at(-1) ?? null
  );
}

// ── PR extraction ────────────────────────────────────────────────────

const CONVENTIONAL_RE = /^([a-z][a-z0-9-]*)(?:\([^)]*\))?(!)?:\s*/i;

export function conventionalType(title: string): string | null {
  const match = CONVENTIONAL_RE.exec(title.trim());
  return match ? match[1].toLowerCase() : null;
}

export function isBreakingChange(title: string): boolean {
  return (
    /^[a-z][a-z0-9-]*(?:\([^)]*\))?!:/i.test(title.trim()) ||
    /\bBREAKING[ -]CHANGE\b/i.test(title)
  );
}

/**
 * Commits that belong to the release machinery, not to the release. They are
 * real PRs in the history but adding them to every changelog would be noise.
 */
const HOUSEKEEPING_RE = [
  /^release:\s*v?\d/i,
  /^chore\(release\)/i,
  /^chore:\s*release\b/i,
  /^chore:\s*version packages/i,
  /^chore:\s*bump to /i,
  /^merge:\s*back-merge/i,
  /back-merge/i,
];

export function isReleaseHousekeeping(title: string): boolean {
  return HOUSEKEEPING_RE.some((pattern) => pattern.test(title.trim()));
}

/** Dependency bumps and chores are not release notes. */
export function isChoreOrDeps(title: string): boolean {
  const type = conventionalType(title);
  return type === 'chore' || type === 'deps';
}

/** PRs that can appear in an outcome changelog's "Also included" section. */
export function changelogPullRequests(prs: PullRequest[]): PullRequest[] {
  return prs.filter((pr) => !isReleaseHousekeeping(pr.title) && !isChoreOrDeps(pr.title));
}

/**
 * One commit subject → one PR. Handles squash-merge subjects ending in
 * `(#123)` and classic `Merge pull request #123 from ...` commits.
 */
export function parseCommitSubject(subject: string): PullRequest | null {
  const trimmed = subject.trim();
  if (!trimmed) return null;

  const merge = /^Merge pull request #(\d+) from \S+/.exec(trimmed);
  if (merge) {
    return { number: Number(merge[1]), title: trimmed };
  }

  const suffixed = /^(.*\S)\s+\(#(\d+)\)$/.exec(trimmed);
  if (suffixed) {
    return { number: Number(suffixed[2]), title: suffixed[1].trim() };
  }

  return null;
}

/** Newest-first `git log --format=%s` output → deduped, oldest-first PR list. */
export function pullRequestsFromCommitSubjects(subjects: string[]): PullRequest[] {
  const byNumber = new Map<number, PullRequest>();

  for (const subject of subjects) {
    const pr = parseCommitSubject(subject);
    if (!pr || isReleaseHousekeeping(pr.title)) continue;
    if (!byNumber.has(pr.number)) byNumber.set(pr.number, pr);
  }

  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

// ── Version proposal ─────────────────────────────────────────────────

/**
 * Semver for a 0.x package: new features and announced breaking changes take
 * the minor slot (that is how 0.9.0 → 0.10.0 shipped), everything else takes
 * the patch slot. At 1.0.0+ the standard rules apply.
 */
export function proposeVersion(prs: PullRequest[], currentVersion: string): ProposedVersion | null {
  if (prs.length === 0) return null;

  const current = parseSemver(currentVersion);
  if (!current) {
    throw new Error(`Current version is not valid semver: ${currentVersion}`);
  }

  const breaking = prs.filter((pr) => isBreakingChange(pr.title));
  const features = prs.filter((pr) => conventionalType(pr.title) === 'feat');

  let bump: Bump;
  let reason: string;

  if (breaking.length > 0) {
    if (current.major === 0) {
      bump = 'minor';
      reason = `${breaking.length} breaking change${breaking.length === 1 ? '' : 's'} (pre-1.0 minor bump)`;
    } else {
      bump = 'major';
      reason = `${breaking.length} breaking change${breaking.length === 1 ? '' : 's'}`;
    }
  } else if (features.length > 0) {
    bump = 'minor';
    reason = `${features.length} feature PR${features.length === 1 ? '' : 's'}`;
  } else {
    bump = 'patch';
    reason = `${prs.length} PR${prs.length === 1 ? '' : 's'}, no new features`;
  }

  return {
    version: formatSemver(bumpSemver(current, bump)),
    bump,
    reason,
  };
}

/**
 * An outcome is a feature set even when its merged PRs are all fixes or the
 * commits landed without PRs; it never rides the patch slot.
 */
export function proposeOutcomeVersion(currentVersion: string, outcomeId: string): ProposedVersion {
  const current = parseSemver(currentVersion);
  if (!current) {
    throw new Error(`Current version is not valid semver: ${currentVersion}`);
  }
  const bump: Bump = 'minor';
  return {
    version: formatSemver(bumpSemver(current, bump)),
    bump,
    reason: `outcome ${outcomeId}`,
  };
}

// ── Changelog ────────────────────────────────────────────────────────

/**
 * One line per PR, oldest first, each carrying its PR number. Deliberately
 * flat: the release train is a review of a batch, not a second editorial pass.
 */
export function buildChangelog(
  prs: PullRequest[],
  options: { version: string; date: string },
): string {
  const seen = new Set<number>();
  const lines = [`## [${options.version}] — ${options.date}`, ''];

  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    const title = pr.title.replace(/\s+/g, ' ').trim() || `PR #${pr.number}`;
    lines.push(`- ${title} (#${pr.number})`);
  }

  return `${lines.join('\n')}\n`;
}

/** Insert the new section before the most recent release, never above the intro. */
export function insertChangelogEntry(changelog: string, entry: string): string {
  const match = /^## \[/m.exec(changelog);
  if (!match) {
    return `${changelog.trimEnd()}\n\n${entry.trim()}\n`;
  }

  const head = changelog.slice(0, match.index).trimEnd();
  const tail = changelog.slice(match.index);
  return `${head}\n\n${entry.trim()}\n\n${tail}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

// ── Outcome gate ─────────────────────────────────────────────────────

/**
 * Parse the outcomes of `.agents/roadmap.json` (object with `outcomes`, or a
 * bare array). Throws on a shape the release gate cannot reason about — an
 * unreadable roadmap must refuse the release, never silently pass it.
 */
export function parseRoadmapOutcomes(raw: string): ReleaseOutcome[] {
  const data: unknown = JSON.parse(raw);
  const list = Array.isArray(data) ? data : isRecord(data) ? data.outcomes : undefined;
  if (!Array.isArray(list)) {
    throw new Error('roadmap.json needs an "outcomes" array');
  }
  return list.map((entry, index) => {
    if (!isRecord(entry) || !isNonEmpty(entry.id) || !Array.isArray(entry.items)) {
      throw new Error(`roadmap outcomes[${index}] needs an id and an items array`);
    }
    return {
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : entry.id,
      items: entry.items.filter(isNonEmpty),
    };
  });
}

/** Read the outcome with `id` from a roadmap file. */
export function readRoadmapOutcome(path: string, id: string): ReleaseOutcome | null {
  return parseRoadmapOutcomes(readFileSync(path, 'utf8')).find((outcome) => outcome.id === id) ?? null;
}

/**
 * Labels a roadmap `<repo>:<id>` may use for this repo: the features.json
 * `repo` (full and short form) and the repo directory's name.
 */
export function repoLabels(list: FeatureList, repoDir: string): Set<string> {
  const labels = new Set<string>([list.repo, basename(repoDir)]);
  const short = list.repo.split('/').pop();
  if (short) labels.add(short);
  return labels;
}

export interface OutcomeItems {
  items: OutcomeItem[];
  /** `<repo>:<id>` refs for this repo that name no item in its features.json. */
  missing: string[];
}

/**
 * Resolve the outcome's refs that belong to this repo against its feature
 * list. Refs for other repos are someone else's release, not ours.
 */
export function outcomeItemsForRepo(
  outcome: ReleaseOutcome,
  list: FeatureList,
  labels: Set<string>,
): OutcomeItems {
  const items: OutcomeItem[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const ref of outcome.items) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const sep = ref.lastIndexOf(':');
    const label = sep > 0 ? ref.slice(0, sep) : '';
    if (!labels.has(label)) continue;
    const id = sep > 0 ? ref.slice(sep + 1) : ref;
    const item = list.items.find((candidate) => candidate.id === id);
    if (!item) {
      missing.push(ref);
      continue;
    }
    items.push({
      ref,
      id: item.id,
      title: item.title,
      ...(item.issue ? { issue: item.issue } : {}),
      status: item.status,
      verifications: item.verifications ?? [],
    });
  }

  return { items, missing };
}

export interface OutcomeGateInput {
  outcome: ReleaseOutcome;
  list: FeatureList;
  repoDir: string;
  /** True when `sha` is an ancestor of (or equal to) the release source. */
  isAncestor: (sha: string) => boolean;
  /** Ref named in the refusal, e.g. `origin/develop`. */
  source?: string;
}

/**
 * Refuse unless every item the outcome names for this repo is `passing` with a
 * verification by a model other than the builder's, whose sha is an ancestor
 * of the release source. Every blocking item is reported with its reason.
 */
export function evaluateOutcomeGate(input: OutcomeGateInput): OutcomeGate {
  const { items, missing } = outcomeItemsForRepo(
    input.outcome,
    input.list,
    repoLabels(input.list, input.repoDir),
  );
  const blockers: OutcomeBlocker[] = missing.map((ref) => ({
    ref,
    id: ref.slice(ref.lastIndexOf(':') + 1),
    title: ref,
    reason: "not listed in this repo's .agents/features.json",
  }));

  for (const item of items) {
    if (item.status !== 'passing') {
      blockers.push({
        ref: item.ref,
        id: item.id,
        title: item.title,
        reason: `status is "${item.status}"`,
      });
      continue;
    }

    const independent = item.verifications.filter((v) => v.model !== v.builder_model);
    if (independent.length === 0) {
      blockers.push({
        ref: item.ref,
        id: item.id,
        title: item.title,
        reason: 'passing without a verification by a model other than builder_model',
      });
      continue;
    }

    if (!independent.some((v) => input.isAncestor(v.sha))) {
      blockers.push({
        ref: item.ref,
        id: item.id,
        title: item.title,
        reason: `no verification sha is an ancestor of ${input.source ?? 'the release source'} (${independent
          .map((v) => `${v.sha.slice(0, 12)} by ${v.model}`)
          .join(', ')})`,
      });
    }
  }

  if (items.length === 0 && blockers.length === 0) {
    blockers.push({
      ref: input.outcome.id,
      id: input.outcome.id,
      title: input.outcome.name,
      reason: 'the outcome names no items for this repo',
    });
  }

  return { outcome: input.outcome, items, blockers, ok: blockers.length === 0 };
}

// ── Patch gate ───────────────────────────────────────────────────────

/** `security…` or `fix…`, in the conventional-commit forms the repo uses. */
export function isSecurityOrFix(title: string): boolean {
  return /^(security|fix)\b/i.test(title.trim());
}

/** Security patches bypass the outcome gate but accept only security/fix PRs. */
export function evaluatePatchGate(prs: PullRequest[]): PatchGate {
  const blockers = prs
    .filter((pr) => !isSecurityOrFix(pr.title))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      reason: 'title does not start with "security" or "fix"',
    }));
  return { blockers, ok: blockers.length === 0 };
}

// ── Outcome changelog ────────────────────────────────────────────────

export interface OutcomeChangelogInput {
  outcome: { id: string; name?: string };
  items: Array<{ id: string; title: string; issue?: string }>;
  /** Merged PRs not already represented by an outcome item. */
  otherPrs: PullRequest[];
}

function issueLabel(item: { id: string; issue?: string }): string {
  return item.issue?.trim() || item.id;
}

/**
 * Release notes grouped by the outcome's items (one line per item, title +
 * issue), then the other merged PRs. Chores and dependency bumps are dropped:
 * they are not release notes.
 */
export function buildOutcomeChangelog(
  input: OutcomeChangelogInput,
  options: { version: string; date: string },
): string {
  const lines = [`## [${options.version}] — ${options.date}`, ''];
  const heading = input.outcome.name
    ? `### ${input.outcome.name} (${input.outcome.id})`
    : `### ${input.outcome.id}`;
  lines.push(heading, '');

  for (const item of input.items) {
    const title = item.title.replace(/\s+/g, ' ').trim() || item.id;
    lines.push(`- ${title} (${issueLabel(item)})`);
  }

  const others = changelogPullRequests(input.otherPrs);
  if (others.length > 0) {
    lines.push('', '### Also included', '');
    for (const pr of [...others].sort((a, b) => a.number - b.number)) {
      const title = pr.title.replace(/\s+/g, ' ').trim() || `PR #${pr.number}`;
      lines.push(`- ${title} (#${pr.number})`);
    }
  }

  return `${lines.join('\n')}\n`;
}

// ── release-check ────────────────────────────────────────────────────

function check(name: string, ok: boolean, detail = ''): ReleaseCheck {
  return { name, ok, detail };
}

/**
 * File-level release-check. The command appends the npm gates (build, skill
 * regen, lint, typecheck, test) and refuses to open the PR unless every check
 * here passes too.
 */
export function evaluateReleaseChecks(facts: PreparedReleaseFacts): ReleaseCheck[] {
  const heading = `## [${facts.version}]`;
  const expectation = facts.changelogExpectation ?? {
    bullets: facts.prs.length,
    prNumbers: facts.prs.map((pr) => pr.number),
  };
  const expected = new Set(expectation.prNumbers);

  const bullets = facts.changelogEntry
    .split('\n')
    .filter((line) => line.startsWith('- '));
  // Outcome item lines carry issue numbers; only the PR section is checked
  // against the merged-PR list.
  const prBullets = bullets.slice(expectation.itemBullets ?? 0);
  const numbers = prBullets
    .map((line) => {
      const match = /\(#(\d+)\)\s*$/.exec(line);
      return match ? Number(match[1]) : null;
    })
    .filter((n): n is number => n !== null);
  const seen = new Set(numbers);
  const missing = [...expected].filter((n) => !seen.has(n));
  const extra = [...seen].filter((n) => !expected.has(n));
  const duplicates = numbers.length !== seen.size;
  const oneLinePerPr =
    bullets.length === expectation.bullets &&
    missing.length === 0 &&
    extra.length === 0 &&
    !duplicates;

  const lineDetail = [
    `${bullets.length} line${bullets.length === 1 ? '' : 's'} for ${expectation.bullets} expected`,
    missing.length ? `missing #${missing.join(', #')}` : '',
    extra.length ? `unexpected #${extra.join(', #')}` : '',
    duplicates ? 'duplicate PR numbers' : '',
  ]
    .filter(Boolean)
    .join('; ');

  return [
    check(
      'changelog entry present',
      facts.changelogFile.includes(heading),
      facts.changelogFile.includes(heading) ? heading : `${heading} not found`,
    ),
    check('changelog is one line per PR', oneLinePerPr, lineDetail),
    check(
      'package.json version',
      facts.packageVersion === facts.version,
      `expected ${facts.version}, found ${facts.packageVersion}`,
    ),
    check(
      'package-lock version',
      facts.packageLockVersion === facts.version,
      `expected ${facts.version}, found ${facts.packageLockVersion ?? 'missing'}`,
    ),
    check(
      'seed skill reference version',
      facts.skillReferenceVersion === facts.version,
      `expected ${facts.version}, found ${facts.skillReferenceVersion ?? 'missing'}`,
    ),
  ];
}

// ── PR body ──────────────────────────────────────────────────────────

export function renderReleaseBody(input: ReleaseBodyInput): string {
  const checkLines =
    input.checks.length > 0
      ? input.checks.map(
          (c) =>
            `- ${c.ok ? 'pass' : 'FAIL'} — ${c.name}${c.detail ? `: ${c.detail}` : ''}`,
        )
      : ['- not run (dry run)'];

  const title = input.patch ? '## Security patch release' : '## Weekly release train';
  const origin = input.patch
    ? 'Generated by `squads release train --patch`. A maintainer approves this batch; publishing stays manual.'
    : 'Generated by `squads release train --outcome`. A maintainer approves this batch; publishing stays manual.';
  const outcomeLines = input.outcome
    ? [`- **Outcome:** \`${input.outcome.id}\` — ${input.outcome.name} (${input.outcome.items} item${input.outcome.items === 1 ? '' : 's'})`]
    : [];

  return `${[
    title,
    '',
    origin,
    '',
    `- **From:** \`${input.tag}\` (v${input.previousVersion})`,
    `- **To:** v${input.proposal.version} (\`${input.proposal.bump}\` — ${input.proposal.reason})`,
    `- **Source:** \`${input.source}\` @ \`${input.sourceSha.slice(0, 12)}\``,
    ...outcomeLines,
    `- **PRs:** ${input.prs.length}`,
    '',
    '### Changelog',
    '',
    input.changelog.trimEnd(),
    '',
    '### release-check',
    '',
    ...checkLines,
    '',
    '### Release steps (maintainer)',
    '',
    '1. Review the changelog and release-check results above.',
    '2. Squash-merge this PR into `main`.',
    `3. Tag \`v${input.proposal.version}\` on the merge commit and push the tag.`,
    '4. Dispatch `publish.yml` with `confirm=PUBLISH` when ready.',
    '5. Back-merge `main` → `develop`.',
    '',
    'This PR does not tag, publish, or dispatch any workflow.',
  ].join('\n')}\n`;
}

// ── Readers (filesystem only) ────────────────────────────────────────

export function readPackageVersion(root: string): string {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    version?: string;
  };
  if (!pkg.version) {
    throw new Error(`No version in ${join(root, 'package.json')}`);
  }
  return pkg.version;
}

export function readPackageLockVersion(root: string): string | null {
  const lockPath = join(root, 'package-lock.json');
  let lock: {
    version?: string;
    packages?: Record<string, { version?: string } | undefined>;
  };
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }

  const rootVersion = lock.version ?? null;
  const workspaceVersion = lock.packages?.['']?.version ?? null;
  if (rootVersion && workspaceVersion && rootVersion !== workspaceVersion) {
    return `${rootVersion} (root) / ${workspaceVersion} (packages[""])`;
  }
  return workspaceVersion ?? rootVersion;
}

export function readSkillReferenceVersion(root: string): string | null {
  try {
    const contents = readFileSync(join(root, SKILL_REFERENCE_PATH), 'utf8');
    const match = /squads-cli v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(contents);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}
