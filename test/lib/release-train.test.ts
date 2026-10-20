/**
 * Tests for the weekly release train (#1320).
 *
 * The changelog/version rules run against fixture PR lists; the dry-run tests
 * inject a git runner so they never touch the real repository. The full-run
 * test drives real git against a throwaway repo and bare origin, with npm and
 * gh stubbed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildChangelog,
  buildOutcomeChangelog,
  changelogPullRequests,
  conventionalType,
  evaluateOutcomeGate,
  evaluatePatchGate,
  evaluateReleaseChecks,
  insertChangelogEntry,
  isBreakingChange,
  isChoreOrDeps,
  isReleaseHousekeeping,
  latestVersionTag,
  parseCommitSubject,
  proposeVersion,
  pullRequestsFromCommitSubjects,
  readPackageLockVersion,
  readSkillReferenceVersion,
  renderReleaseBody,
  type PreparedReleaseFacts,
  type PullRequest,
  type ReleaseOutcome,
} from '../../src/lib/release-train.js';
import type { FeatureList } from '../../src/lib/features.js';
import {
  bumpPackageFiles,
  defaultRunner,
  releaseTrainCommand,
  type Runner,
} from '../../src/commands/release-train.js';

const PRS: PullRequest[] = [
  { number: 1315, title: 'feat(providers): opencode selects the opencode harness' },
  { number: 1261, title: "fix(portability): drop probes for one company's layout and names" },
  { number: 1303, title: 'security(events): redaction at write time and sensitivity on every event' },
  { number: 1304, title: 'feat(events): message events, running usage, run titles' },
];

const DATE = '2026-10-19';

describe('pull request extraction', () => {
  it('parses squash and merge-commit subjects', () => {
    expect(parseCommitSubject('feat(run): ship it (#123)')).toEqual({
      number: 123,
      title: 'feat(run): ship it',
    });
    expect(parseCommitSubject('Merge pull request #124 from agents-squads/topic')).toEqual({
      number: 124,
      title: 'Merge pull request #124 from agents-squads/topic',
    });
    expect(parseCommitSubject('chore: no PR number')).toBeNull();
  });

  it('keeps the last number when a subject names more than one PR', () => {
    expect(parseCommitSubject('fix: multi ref PR (#1299) (#1302)')).toEqual({
      number: 1302,
      title: 'fix: multi ref PR (#1299)',
    });
  });

  it('deduplicates, sorts by number and drops release housekeeping', () => {
    const prs = pullRequestsFromCommitSubjects([
      'chore(deps): bump actions/checkout from 4.4.0 to 7.0.1 (#1294)',
      'feat(events): message events (#1304)',
      'Merge pull request #1288 from agents-squads/merge/back-merge-v0.10.0',
      'chore(release): v0.10.0 prep — bump, changelog, skill reference regen (#1285)',
      'release: v0.10.0 (#1286)',
      'fix(plan): read refs outside the plan sub-issue graph (#1302)',
      'fix(plan): read refs outside the plan sub-issue graph (#1302)',
      'chore: no PR number',
    ]);

    expect(prs.map((pr) => pr.number)).toEqual([1294, 1302, 1304]);
  });

  it('recognises housekeeping and conventional types', () => {
    expect(isReleaseHousekeeping('release: v0.10.0 (#1286)')).toBe(true);
    expect(isReleaseHousekeeping('chore(release): v0.10.0 prep (#1285)')).toBe(true);
    expect(isReleaseHousekeeping('Merge pull request #1 from x/back-merge-y')).toBe(true);
    expect(isReleaseHousekeeping('fix(run): a real fix (#1)')).toBe(false);

    expect(conventionalType('feat(providers): x')).toBe('feat');
    expect(conventionalType('security(events): x')).toBe('security');
    expect(conventionalType('not conventional')).toBeNull();
  });
});

describe('semver proposal', () => {
  it('bumps minor for features on a 0.x line', () => {
    expect(proposeVersion(PRS, '0.10.0')).toEqual({
      version: '0.11.0',
      bump: 'minor',
      reason: '2 feature PRs',
    });
  });

  it('bumps patch when no feature PR is in the batch', () => {
    const fixes = PRS.filter((pr) => pr.number === 1261);
    expect(proposeVersion(fixes, '0.10.0')).toEqual({
      version: '0.10.1',
      bump: 'patch',
      reason: '1 PR, no new features',
    });
  });

  it('treats breaking changes as minor before 1.0 and major after', () => {
    const breaking = [{ number: 1, title: 'feat(api)!: drop the legacy endpoint' }];
    expect(isBreakingChange(breaking[0].title)).toBe(true);
    expect(proposeVersion(breaking, '0.10.0')?.bump).toBe('minor');
    expect(proposeVersion(breaking, '0.10.0')?.version).toBe('0.11.0');
    expect(proposeVersion(breaking, '1.2.3')?.version).toBe('2.0.0');
  });

  it('bumps minor for features after 1.0', () => {
    expect(proposeVersion(PRS, '1.2.3')?.version).toBe('1.3.0');
  });

  it('returns null when there is no work', () => {
    expect(proposeVersion([], '0.10.0')).toBeNull();
  });

  it('refuses a non-semver current version', () => {
    expect(() => proposeVersion(PRS, 'latest')).toThrow(/not valid semver/i);
  });
});

describe('changelog builder', () => {
  it('writes one line per PR with its number, oldest first', () => {
    expect(buildChangelog(PRS, { version: '0.11.0', date: DATE })).toBe(
      [
        '## [0.11.0] — 2026-10-19',
        '',
        "- fix(portability): drop probes for one company's layout and names (#1261)",
        '- security(events): redaction at write time and sensitivity on every event (#1303)',
        '- feat(events): message events, running usage, run titles (#1304)',
        '- feat(providers): opencode selects the opencode harness (#1315)',
        '',
      ].join('\n'),
    );
  });

  it('emits exactly one bullet per unique PR', () => {
    const changelog = buildChangelog([...PRS, PRS[0]], { version: '0.11.0', date: DATE });
    const bullets = changelog.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets).toHaveLength(PRS.length);
    expect(new Set(bullets).size).toBe(PRS.length);
  });

  it('inserts the new entry below the changelog intro and above the last release', () => {
    const existing = [
      '# Changelog',
      '',
      'All notable changes are documented here.',
      '',
      '## [0.10.0] — 2026-10-14',
      '',
      '- old change (#1)',
      '',
    ].join('\n');
    const entry = buildChangelog(PRS, { version: '0.11.0', date: DATE });

    const updated = insertChangelogEntry(existing, entry);
    expect(updated.startsWith('# Changelog\n\nAll notable changes')).toBe(true);
    expect(updated.indexOf('## [0.11.0]')).toBeLessThan(updated.indexOf('## [0.10.0]'));
    expect(updated).toContain('- old change (#1)');
  });
});

describe('outcome gate', () => {
  const OUTCOME: ReleaseOutcome = {
    id: 'O0',
    name: 'The org is organized as code',
    items: ['squads-cli:R1', 'squads-cli:Z5', 'other-repo:X'],
  };

  function features(items: FeatureList['items']): FeatureList {
    return { schema: 1, repo: 'agents-squads/squads-cli', items };
  }

  const PASSING = {
    id: 'Z5',
    outcome: 'O0',
    title: 'Feature lists as code',
    issue: '#1332',
    status: 'passing' as const,
    verifications: [
      {
        model: 'verifier-model',
        builder_model: 'builder-model',
        sha: 'abc1234',
        at: '2026-10-20T00:00:00Z',
      },
    ],
  };

  it('refuses and names a failing item', () => {
    const gate = evaluateOutcomeGate({
      outcome: OUTCOME,
      list: features([
        {
          id: 'R1',
          outcome: 'O0',
          title: 'Release train ships an outcome',
          issue: '#1320',
          status: 'failing',
        },
        PASSING,
      ]),
      repoDir: '/repos/squads-cli',
      isAncestor: () => true,
    });

    expect(gate.ok).toBe(false);
    expect(gate.blockers).toHaveLength(1);
    expect(gate.blockers[0].id).toBe('R1');
    expect(gate.blockers[0].title).toBe('Release train ships an outcome');
    expect(gate.blockers[0].reason).toContain('failing');
    // Other repos' items are not this release's problem.
    expect(gate.items.map((item) => item.id)).toEqual(['R1', 'Z5']);
  });

  it('passes only when the verification model differs and its sha is an ancestor', () => {
    const list = features([PASSING]);
    const outcome = { ...OUTCOME, items: ['squads-cli:Z5', 'other-repo:X'] };

    expect(
      evaluateOutcomeGate({ outcome, list, repoDir: '/repos/squads-cli', isAncestor: () => true }).ok,
    ).toBe(true);

    const notAncestor = evaluateOutcomeGate({
      outcome,
      list,
      repoDir: '/repos/squads-cli',
      isAncestor: () => false,
    });
    expect(notAncestor.ok).toBe(false);
    expect(notAncestor.blockers[0].reason).toContain('ancestor');

    const sameModel = features([
      {
        ...PASSING,
        verifications: [{ ...PASSING.verifications[0], model: 'builder-model' }],
      },
    ]);
    const selfVerified = evaluateOutcomeGate({
      outcome,
      list: sameModel,
      repoDir: '/repos/squads-cli',
      isAncestor: () => true,
    });
    expect(selfVerified.ok).toBe(false);
    expect(selfVerified.blockers[0].reason).toContain('builder_model');
  });

  it('refuses an outcome with no items for this repo', () => {
    const gate = evaluateOutcomeGate({
      outcome: { ...OUTCOME, items: ['other-repo:X'] },
      list: features([PASSING]),
      repoDir: '/repos/squads-cli',
      isAncestor: () => true,
    });
    expect(gate.ok).toBe(false);
    expect(gate.blockers[0].reason).toContain('no items');
  });
});

describe('patch gate', () => {
  it('accepts only security and fix PRs', () => {
    expect(evaluatePatchGate([{ number: 1, title: 'fix(run): a fix' }]).ok).toBe(true);
    expect(evaluatePatchGate([{ number: 2, title: 'security(events): redact' }]).ok).toBe(true);

    const gate = evaluatePatchGate([
      { number: 3, title: 'feat(plan): new command' },
      { number: 4, title: 'chore(deps): bump x' },
    ]);
    expect(gate.ok).toBe(false);
    expect(gate.blockers.map((b) => b.number)).toEqual([3, 4]);
  });
});

describe('outcome changelog', () => {
  it('lists the outcome items, then other PRs, dropping chores and dependency bumps', () => {
    const changelog = buildOutcomeChangelog(
      {
        outcome: { id: 'O0', name: 'The org is organized as code' },
        items: [
          { id: 'Z5', title: 'Feature lists as code', issue: '#1332' },
          { id: 'R1', title: 'Release train ships an outcome', issue: '#1320' },
        ],
        otherPrs: [
          { number: 1294, title: 'chore(deps): bump actions/checkout' },
          { number: 1304, title: 'feat(events): message events' },
          { number: 1261, title: 'fix(portability): drop probes' },
        ],
      },
      { version: '0.11.0', date: DATE },
    );

    expect(changelog).toContain('## [0.11.0] — 2026-10-19');
    expect(changelog).toContain('### The org is organized as code (O0)');
    expect(changelog).toContain('- Feature lists as code (#1332)');
    expect(changelog).toContain('- Release train ships an outcome (#1320)');
    expect(changelog.indexOf('Feature lists as code')).toBeLessThan(changelog.indexOf('### Also included'));
    expect(changelog).toContain('- feat(events): message events (#1304)');
    expect(changelog).toContain('- fix(portability): drop probes (#1261)');
    expect(changelog).not.toContain('bump actions/checkout');
  });

  it('drops chores and deps from the PR list (but keeps release housekeeping out too)', () => {
    expect(isChoreOrDeps('chore(deps): bump x')).toBe(true);
    expect(isChoreOrDeps('deps: bump y')).toBe(true);
    expect(isChoreOrDeps('fix(x): y')).toBe(false);
    expect(
      changelogPullRequests([
        { number: 1, title: 'chore(deps): bump' },
        { number: 2, title: 'feat: real work' },
      ]).map((pr) => pr.number),
    ).toEqual([2]);
  });
});

describe('release-check', () => {
  function facts(overrides: Partial<PreparedReleaseFacts> = {}): PreparedReleaseFacts {
    const entry = buildChangelog(PRS, { version: '0.11.0', date: DATE });
    return {
      version: '0.11.0',
      prs: PRS,
      changelogEntry: entry,
      changelogFile: `# Changelog\n\n${entry}`,
      packageVersion: '0.11.0',
      packageLockVersion: '0.11.0',
      skillReferenceVersion: '0.11.0',
      ...overrides,
    };
  }

  it('passes when every file matches the release', () => {
    const results = evaluateReleaseChecks(facts());
    expect(results).toHaveLength(5);
    expect(results.every((check) => check.ok)).toBe(true);
  });

  it('fails the changelog when a merged PR has no line', () => {
    const entry = buildChangelog(
      PRS.filter((pr) => pr.number !== 1261),
      { version: '0.11.0', date: DATE },
    );
    const results = evaluateReleaseChecks(
      facts({ changelogEntry: entry, changelogFile: `# Changelog\n\n${entry}` }),
    );
    const lineCheck = results.find((check) => check.name === 'changelog is one line per PR');
    expect(lineCheck?.ok).toBe(false);
    expect(lineCheck?.detail).toContain('missing #1261');
  });

  it('fails when a PR number is duplicated', () => {
    const entry =
      buildChangelog(PRS, { version: '0.11.0', date: DATE }) +
      `- feat(events): message events (#1304)\n`;
    const results = evaluateReleaseChecks(
      facts({ changelogEntry: entry, changelogFile: `# Changelog\n\n${entry}` }),
    );
    const lineCheck = results.find((check) => check.name === 'changelog is one line per PR');
    expect(lineCheck?.ok).toBe(false);
    expect(lineCheck?.detail).toContain('duplicate');
  });

  it('fails when package, lock, or skill reference versions drift', () => {
    const results = evaluateReleaseChecks(
      facts({ packageVersion: '0.10.0', packageLockVersion: null, skillReferenceVersion: '0.10.0' }),
    );
    expect(results.find((check) => check.name === 'package.json version')?.ok).toBe(false);
    expect(results.find((check) => check.name === 'package-lock version')?.ok).toBe(false);
    expect(results.find((check) => check.name === 'seed skill reference version')?.ok).toBe(false);
  });
});

describe('release body', () => {
  it('carries the changelog, every check result and the maintainer steps', () => {
    const body = renderReleaseBody({
      tag: 'v0.10.0',
      previousVersion: '0.10.0',
      proposal: { version: '0.11.0', bump: 'minor', reason: '2 feature PRs' },
      prs: PRS,
      changelog: buildChangelog(PRS, { version: '0.11.0', date: DATE }),
      checks: [
        { name: 'npm run build', ok: true, detail: '' },
        { name: 'npm test', ok: false, detail: 'one failure' },
      ],
      source: 'origin/develop',
      sourceSha: 'abcdef1234567890',
    });

    expect(body).toContain('## Weekly release train');
    expect(body).toContain('v0.11.0');
    expect(body).toContain('- feat(providers)');
    expect(body).toContain('### release-check');
    expect(body).toContain('pass — npm run build');
    expect(body).toContain('FAIL — npm test: one failure');
    expect(body).toContain('does not tag, publish, or dispatch any workflow');
  });

  it('names the outcome and marks the security-patch path', () => {
    const outcomeBody = renderReleaseBody({
      tag: 'v0.10.0',
      previousVersion: '0.10.0',
      proposal: { version: '0.11.0', bump: 'minor', reason: 'outcome O0' },
      prs: [],
      changelog: buildOutcomeChangelog(
        {
          outcome: { id: 'O0', name: 'The org is organized as code' },
          items: [{ id: 'R1', title: 'Release train ships an outcome', issue: '#1320' }],
          otherPrs: [],
        },
        { version: '0.11.0', date: DATE },
      ),
      checks: [],
      source: 'origin/develop',
      sourceSha: 'abcdef1234567890',
      outcome: { id: 'O0', name: 'The org is organized as code', items: 1 },
    });
    expect(outcomeBody).toContain('- **Outcome:** `O0` — The org is organized as code (1 item)');
    expect(outcomeBody).toContain('- Release train ships an outcome (#1320)');

    const patchBody = renderReleaseBody({
      tag: 'v0.10.0',
      previousVersion: '0.10.0',
      proposal: { version: '0.10.1', bump: 'patch', reason: '1 PR, no new features' },
      prs: [{ number: 9, title: 'security(events): redact' }],
      changelog: buildChangelog([{ number: 9, title: 'security(events): redact' }], {
        version: '0.10.1',
        date: DATE,
      }),
      checks: [],
      source: 'origin/develop',
      sourceSha: 'abcdef1234567890',
      patch: true,
    });
    expect(patchBody).toContain('## Security patch release');
  });
});

describe('latest version tag', () => {
  it('picks the highest semver, not the lexical last line', () => {
    expect(latestVersionTag('v0.9.0\nv0.10.0\nv0.10.0-rc.1\n')).toBe('v0.10.0');
    expect(latestVersionTag('not-a-tag\n')).toBeNull();
  });
});

describe('readers', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('reads lockfile versions and reports a split root/workspace version', () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-readers-'));
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({ version: '0.11.0', packages: { '': { version: '0.11.0' } } }),
    );
    expect(readPackageLockVersion(root)).toBe('0.11.0');

    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({ version: '0.11.0', packages: { '': { version: '0.10.0' } } }),
    );
    expect(readPackageLockVersion(root)).toContain('0.10.0');

    mkdirSync(join(root, 'templates/seed/skills/squads-cli/references'), { recursive: true });
    writeFileSync(
      join(root, 'templates/seed/skills/squads-cli/references/commands.md'),
      '> GENERATED from `squads commands --json` (squads-cli v0.11.0) — do not edit.\n',
    );
    expect(readSkillReferenceVersion(root)).toBe('0.11.0');
  });

  it('bumps package.json and both package-lock version fields', () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-bump-'));
    writeFileSync(
      join(root, 'package.json'),
      `${JSON.stringify({ name: 'squads-cli', version: '0.10.0' }, null, 2)}\n`,
    );
    writeFileSync(
      join(root, 'package-lock.json'),
      `${JSON.stringify({ version: '0.10.0', packages: { '': { version: '0.10.0' } } }, null, 2)}\n`,
    );

    bumpPackageFiles(root, '0.11.0');

    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version).toBe('0.11.0');
    expect(readPackageLockVersion(root)).toBe('0.11.0');
  });
});

describe('releaseTrainCommand --dry-run', () => {
  let root: string;
  let out: string[];
  let outSpy: ReturnType<typeof vi.spyOn>;

  const PATCH_PRS: PullRequest[] = PRS.filter((pr) => /^(security|fix)\b/i.test(pr.title));

  afterEach(() => {
    outSpy?.mockRestore();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function fixtureRunner(prs: PullRequest[] = PATCH_PRS): Runner {
    return async (file, args) => {
      const key = `${file} ${args.join(' ')}`;
      if (key === 'git tag --sort=-v:refname --list v[0-9]*') {
        return 'v0.9.0\nv0.10.0\n';
      }
      if (key === 'git log -1 --format=%cI v0.10.0') return '2026-10-14T18:23:28-03:00\n';
      if (key === 'git show origin/develop:package.json') {
        return JSON.stringify({ version: '0.10.0' });
      }
      if (
        key ===
        'git log --since 2026-10-14T18:23:28-03:00 --format=%s origin/develop'
      ) {
        return prs.map((pr) => `${pr.title} (#${pr.number})`).join('\n');
      }
      if (key === 'git rev-parse origin/develop') return 'abcdef1234567890\n';
      throw new Error(`unexpected command: ${key}`);
    };
  }

  function captureStdout(): void {
    out = [];
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
  }

  function writeOutcomeFixture(
    items: FeatureList['items'],
    outcomeItems: string[],
  ): { repoRoot: string; orgRoot: string } {
    const orgRoot = mkdtempSync(join(tmpdir(), 'release-train-org-'));
    const repoRoot = join(orgRoot, 'squads-cli');
    mkdirSync(join(repoRoot, '.agents'), { recursive: true });
    mkdirSync(join(orgRoot, 'hq', '.agents'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.agents', 'features.json'),
      JSON.stringify({ schema: 1, repo: 'agents-squads/squads-cli', items }, null, 2),
    );
    writeFileSync(
      join(orgRoot, 'hq', '.agents', 'roadmap.json'),
      JSON.stringify(
        { schema: 1, outcomes: [{ id: 'O0', name: 'The org is organized as code', items: outcomeItems }] },
        null,
        2,
      ),
    );
    return { repoRoot, orgRoot };
  }

  it('prints the patch plan and changes nothing', async () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-dry-'));
    captureStdout();

    const code = await releaseTrainCommand(
      { dryRun: true, json: true, patch: true },
      { runner: fixtureRunner(), root, today: DATE },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(out.join(''));
    expect(payload.dry_run).toBe(true);
    expect(payload.patch).toBe(true);
    expect(payload.from_tag).toBe('v0.10.0');
    expect(payload.proposed_version).toBe('0.10.1');
    expect(payload.bump).toBe('patch');
    expect(payload.prs).toHaveLength(PATCH_PRS.length);
    expect(payload.changelog).toContain('- fix(portability): drop probes');
    expect(payload.changelog).not.toContain('feat(providers)');
  });

  it('refuses --patch when a feature PR is in the batch', async () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-patch-'));
    captureStdout();

    const code = await releaseTrainCommand(
      { dryRun: true, json: true, patch: true },
      { runner: fixtureRunner(PRS), root, today: DATE },
    );

    expect(code).toBe(1);
    const payload = JSON.parse(out.join(''));
    expect(payload.refused).toBe(true);
    expect(payload.blockers.map((b: { number: number }) => b.number)).toEqual([1304, 1315]);
  });

  it('prefers gh merged-PR data and keeps only PRs merged after the tag', async () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-gh-'));
    captureStdout();

    const runner: Runner = async (file, args) => {
      const key = `${file} ${args.join(' ')}`;
      if (key === 'git tag --sort=-v:refname --list v[0-9]*') return 'v0.10.0\n';
      if (key === 'git log -1 --format=%cI v0.10.0') return '2026-10-14T18:23:28-03:00\n';
      if (key === 'git show origin/develop:package.json') {
        return JSON.stringify({ version: '0.10.0' });
      }
      if (key === 'gh pr list --state merged --base develop --limit 1000 --json number,title,mergedAt,url') {
        return JSON.stringify([
          { number: 1200, title: 'fix(old): already released', mergedAt: '2026-10-01T00:00:00Z' },
          { number: 1304, title: 'fix(events): new work', mergedAt: '2026-10-15T00:00:00Z' },
        ]);
      }
      if (key === 'git rev-parse origin/develop') return 'abcdef1234567890\n';
      throw new Error(`unexpected command: ${key}`);
    };

    const code = await releaseTrainCommand(
      { dryRun: true, json: true, patch: true },
      { runner, root, today: DATE },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(out.join(''));
    expect(payload.prs.map((pr: PullRequest) => pr.number)).toEqual([1304]);
    expect(payload.changelog).toContain('- fix(events): new work (#1304)');
    expect(payload.changelog).not.toContain('#1200');
  });

  it('reports nothing to release when the branch has no new PRs', async () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-empty-'));
    captureStdout();

    const runner: Runner = async (file, args) => {
      const key = `${file} ${args.join(' ')}`;
      if (key === 'git tag --sort=-v:refname --list v[0-9]*') return 'v0.10.0\n';
      if (key === 'git log -1 --format=%cI v0.10.0') return '2026-10-14T18:23:28-03:00\n';
      if (key === 'git show origin/develop:package.json') {
        return JSON.stringify({ version: '0.10.0' });
      }
      if (
        key ===
        'git log --since 2026-10-14T18:23:28-03:00 --format=%s origin/develop'
      ) {
        return 'Merge pull request #1288 from agents-squads/merge/back-merge-v0.10.0\n';
      }
      if (key === 'git rev-parse origin/develop') return 'abcdef1234567890\n';
      throw new Error(`unexpected command: ${key}`);
    };

    const code = await releaseTrainCommand(
      { dryRun: true, json: true, patch: true },
      { runner, root, today: DATE },
    );

    expect(code).toBe(0);
    expect(JSON.parse(out.join('')).proposed_version).toBeNull();
  });

  it('requires an outcome (or --patch) — a PR count is not a release', async () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-mode-'));
    await expect(
      releaseTrainCommand({ dryRun: true, json: true }, { runner: fixtureRunner(), root, today: DATE }),
    ).rejects.toThrow(/outcome/i);
  });

  it('refuses an outcome with a failing item and names it', async () => {
    const fixture = writeOutcomeFixture(
      [
        {
          id: 'R1',
          outcome: 'O0',
          title: 'Release train ships an outcome',
          issue: '#1320',
          status: 'failing',
        },
      ],
      ['squads-cli:R1'],
    );
    root = fixture.orgRoot;
    captureStdout();

    const code = await releaseTrainCommand(
      { dryRun: true, json: true, outcome: 'O0' },
      {
        runner: fixtureRunner(PRS),
        root: fixture.repoRoot,
        orgRoot: fixture.orgRoot,
        today: DATE,
        shaExists: () => true,
        isAncestor: async () => true,
      },
    );

    expect(code).toBe(1);
    const payload = JSON.parse(out.join(''));
    expect(payload.refused).toBe(true);
    expect(payload.blockers[0].id).toBe('R1');
    expect(payload.blockers[0].reason).toContain('failing');
  });

  it('releases an outcome whose items pass with independent verifications', async () => {
    const fixture = writeOutcomeFixture(
      [
        {
          id: 'Z5',
          outcome: 'O0',
          title: 'Feature lists as code',
          issue: '#1332',
          status: 'passing',
          verifications: [
            {
              model: 'verifier-model',
              builder_model: 'builder-model',
              sha: 'abc1234',
              at: '2026-10-20T00:00:00Z',
            },
          ],
        },
      ],
      ['squads-cli:Z5'],
    );
    root = fixture.orgRoot;
    captureStdout();

    const code = await releaseTrainCommand(
      { dryRun: true, json: true, outcome: 'O0' },
      {
        runner: fixtureRunner([{ number: 1304, title: 'feat(events): message events' }]),
        root: fixture.repoRoot,
        orgRoot: fixture.orgRoot,
        today: DATE,
        shaExists: () => true,
        isAncestor: async () => true,
      },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(out.join(''));
    expect(payload.outcome).toEqual({ id: 'O0', name: 'The org is organized as code' });
    expect(payload.outcome_items.map((item: { id: string }) => item.id)).toEqual(['Z5']);
    expect(payload.changelog).toContain('- Feature lists as code (#1332)');
    expect(payload.changelog).toContain('### Also included');
    expect(payload.changelog).toContain('- feat(events): message events (#1304)');
  });
});

describe('releaseTrainCommand (full run)', () => {
  let base: string;
  let outSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    outSpy?.mockRestore();
    vi.unstubAllEnvs();
    if (base) rmSync(base, { recursive: true, force: true });
  });

  function git(cwd: string, args: string[], date?: string): string {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
    });
  }

  function write(root: string, path: string, contents: string): void {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), contents);
  }

  it('pushes a release branch with develop\'s tree, the bump and the changelog — never node_modules', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', 'test');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.invalid');
    vi.stubEnv('GIT_COMMITTER_NAME', 'test');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.invalid');
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    base = mkdtempSync(join(tmpdir(), 'release-train-full-'));
    const origin = join(base, 'origin.git');
    const root = join(base, 'repo');
    git(base, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(base, ['init', '-q', '-b', 'main', root]);

    write(root, '.gitignore', 'node_modules/\n');
    write(root, 'package.json', `${JSON.stringify({ name: 'x', version: '0.10.0' }, null, 2)}\n`);
    write(
      root,
      'package-lock.json',
      `${JSON.stringify({ name: 'x', version: '0.10.0', packages: { '': { version: '0.10.0' } } }, null, 2)}\n`,
    );
    write(root, 'CHANGELOG.md', '# Changelog\n\n## [0.10.0] — 2026-10-14\n\n- old work (#1)\n');
    write(root, 'templates/seed/skills/squads-cli/references/commands.md', 'squads-cli v0.10.0\n');
    write(root, 'main-only.txt', 'removed on develop\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'release: v0.10.0'], '2026-10-14T12:00:00Z');
    git(root, ['tag', 'v0.10.0']);

    git(root, ['checkout', '-q', '-b', 'develop']);
    git(root, ['rm', '-q', 'main-only.txt']);
    write(root, 'feature.txt', 'new\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'fix(x): new thing (#5)'], '2026-10-16T12:00:00Z');

    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', 'origin', 'main', 'develop', '--tags']);
    git(root, ['fetch', '-q', 'origin']);
    mkdirSync(join(root, 'node_modules'));

    const calls: string[] = [];
    const runner: Runner = async (file, args, options) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'git') return defaultRunner(file, args, options);
      if (file === 'npm' && args.join(' ') === 'run gen:skill') {
        const cwd = options?.cwd ?? root;
        const { version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
        write(cwd, 'templates/seed/skills/squads-cli/references/commands.md', `squads-cli v${version}\n`);
        return '';
      }
      if (file === 'npm') return '';
      if (file === 'gh' && args[1] === 'list') throw new Error('gh unavailable');
      if (file === 'gh' && args[1] === 'create') return 'https://example.invalid/pull/1\n';
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };

    const code = await releaseTrainCommand({ json: true, patch: true }, { runner, root, today: DATE });

    expect(code).toBe(0);
    const branch = 'release/v0.10.1';
    const files = git(origin, ['ls-tree', '-r', '--name-only', branch]).split('\n');
    expect(files).toContain('feature.txt');
    expect(files).not.toContain('main-only.txt');
    expect(files.some((f) => f.startsWith('node_modules'))).toBe(false);
    expect(JSON.parse(git(origin, ['show', `${branch}:package.json`])).version).toBe('0.10.1');
    const changelog = git(origin, ['show', `${branch}:CHANGELOG.md`]);
    expect(changelog).toContain(`## [0.10.1] — ${DATE}\n\n- fix(x): new thing (#5)\n\n## [0.10.0]`);
    expect(git(origin, ['rev-parse', `${branch}^`]).trim()).toBe(git(origin, ['rev-parse', 'main']).trim());
    expect(git(origin, ['log', '-1', '--format=%s', branch]).trim()).toBe('release: v0.10.1');
    expect(calls.find((c) => c.startsWith('gh pr create'))).toContain('--base main');
    expect(
      calls.filter(
        (c) =>
          (c.startsWith('git tag') && !c.startsWith('git tag --sort')) ||
          (c.startsWith('git push') && c.includes('--tags')) ||
          c.startsWith('gh workflow') ||
          c.startsWith('npm publish'),
      ),
    ).toEqual([]);
    expect(git(root, ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('opens an outcome release PR whose body lists the outcome items', async () => {
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', 'test');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.invalid');
    vi.stubEnv('GIT_COMMITTER_NAME', 'test');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.invalid');
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    base = mkdtempSync(join(tmpdir(), 'release-train-outcome-'));
    const origin = join(base, 'origin.git');
    const root = join(base, 'repo');
    git(base, ['init', '-q', '--bare', '-b', 'main', origin]);
    git(base, ['init', '-q', '-b', 'main', root]);

    write(root, '.gitignore', 'node_modules/\n');
    write(root, 'package.json', `${JSON.stringify({ name: 'x', version: '0.10.0' }, null, 2)}\n`);
    write(
      root,
      'package-lock.json',
      `${JSON.stringify({ name: 'x', version: '0.10.0', packages: { '': { version: '0.10.0' } } }, null, 2)}\n`,
    );
    write(root, 'CHANGELOG.md', '# Changelog\n\n## [0.10.0] — 2026-10-14\n\n- old work (#1)\n');
    write(root, 'templates/seed/skills/squads-cli/references/commands.md', 'squads-cli v0.10.0\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'release: v0.10.0'], '2026-10-14T12:00:00Z');
    git(root, ['tag', 'v0.10.0']);
    const mainSha = git(root, ['rev-parse', 'HEAD']).trim();

    git(root, ['checkout', '-q', '-b', 'develop']);
    write(
      root,
      '.agents/features.json',
      JSON.stringify(
        {
          schema: 1,
          repo: 'agents-squads/squads-cli',
          items: [
            {
              id: 'Z5',
              outcome: 'O0',
              title: 'Feature lists as code',
              issue: '#1332',
              status: 'passing',
              verifications: [
                {
                  model: 'verifier-model',
                  builder_model: 'builder-model',
                  sha: mainSha,
                  at: '2026-10-20T00:00:00Z',
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );
    write(root, 'feature.txt', 'new\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', 'feat(x): outcome work (#5)'], '2026-10-16T12:00:00Z');

    git(root, ['remote', 'add', 'origin', origin]);
    git(root, ['push', '-q', 'origin', 'main', 'develop', '--tags']);
    git(root, ['fetch', '-q', 'origin']);
    mkdirSync(join(root, 'node_modules'));

    write(
      base,
      'hq/.agents/roadmap.json',
      JSON.stringify(
        {
          schema: 1,
          outcomes: [
            { id: 'O0', name: 'The org is organized as code', items: ['squads-cli:Z5'] },
          ],
        },
        null,
        2,
      ),
    );

    let createBody = '';
    const runner: Runner = async (file, args, options) => {
      if (file === 'git') return defaultRunner(file, args, options);
      if (file === 'npm' && args.join(' ') === 'run gen:skill') {
        const cwd = options?.cwd ?? root;
        const { version } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
        write(cwd, 'templates/seed/skills/squads-cli/references/commands.md', `squads-cli v${version}\n`);
        return '';
      }
      if (file === 'npm') return '';
      if (file === 'gh' && args[1] === 'list') throw new Error('gh unavailable');
      if (file === 'gh' && args[1] === 'create') {
        createBody = args[args.indexOf('--body') + 1] ?? '';
        return 'https://example.invalid/pull/2\n';
      }
      throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
    };

    const code = await releaseTrainCommand(
      { json: true, outcome: 'O0' },
      { runner, root, orgRoot: base, today: DATE },
    );

    expect(code).toBe(0);
    expect(createBody).toContain('- **Outcome:** `O0` — The org is organized as code (1 item)');
    expect(createBody).toContain('- Feature lists as code (#1332)');
    expect(createBody).toContain('### Also included');
    expect(createBody).toContain('- feat(x): outcome work (#5)');

    const changelog = git(origin, ['show', 'release/v0.11.0:CHANGELOG.md']);
    expect(changelog).toContain('- Feature lists as code (#1332)');
  });
});
