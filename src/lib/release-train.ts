/**
 * Weekly release train (agents-squads/squads-cli#1320).
 *
 * Turns merged work into one reviewable release PR:
 *   last tag → merged PRs on develop → changelog → semver bump → release-check
 *
 * Two constraints shape the implementation:
 *
 * 1. `develop` → `main` is squash-merged, so `git log <tag>..develop` surfaces
 *    the previous release again after every back-merge (see RELEASING.md,
 *    "Trap: squash-merge divergence"). `--ancestry-path` keeps only commits
 *    that descend from the tag, which is precisely the work merged since the
 *    release entered develop.
 * 2. The train never publishes. It prepares a branch and opens a PR; the
 *    maintainer merges, tags and dispatches `publish.yml`.
 *
 * Everything in this module except the readers at the bottom is pure, so the
 * changelog and version rules are tested against fixture PR lists.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

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
  const expected = new Set(facts.prs.map((pr) => pr.number));

  const bullets = facts.changelogEntry
    .split('\n')
    .filter((line) => line.startsWith('- '));
  const numbers = bullets
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
    bullets.length === facts.prs.length &&
    missing.length === 0 &&
    extra.length === 0 &&
    !duplicates;

  const lineDetail = [
    `${bullets.length} line${bullets.length === 1 ? '' : 's'} for ${facts.prs.length} PR${facts.prs.length === 1 ? '' : 's'}`,
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

  return `${[
    '## Weekly release train',
    '',
    'Generated by `squads release train`. A maintainer approves this batch; publishing stays manual.',
    '',
    `- **From:** \`${input.tag}\` (v${input.previousVersion})`,
    `- **To:** v${input.proposal.version} (\`${input.proposal.bump}\` — ${input.proposal.reason})`,
    `- **Source:** \`${input.source}\` @ \`${input.sourceSha.slice(0, 12)}\``,
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
