/**
 * Tests for the weekly release train (#1320).
 *
 * The changelog/version rules run against fixture PR lists; the command test
 * injects a git runner so the dry run never touches the real repository.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildChangelog,
  conventionalType,
  evaluateReleaseChecks,
  insertChangelogEntry,
  isBreakingChange,
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
} from '../../src/lib/release-train.js';
import {
  bumpPackageFiles,
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

  afterEach(() => {
    outSpy?.mockRestore();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function fixtureRunner(): Runner {
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
        return PRS.map((pr) => `${pr.title} (#${pr.number})`).join('\n');
      }
      if (key === 'git rev-parse origin/develop') return 'abcdef1234567890\n';
      throw new Error(`unexpected command: ${key}`);
    };
  }

  it('prints the proposed release and changes nothing', async () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-dry-'));
    out = [];
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    const code = await releaseTrainCommand(
      { dryRun: true, json: true },
      { runner: fixtureRunner(), root, today: DATE },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(out.join(''));
    expect(payload.dry_run).toBe(true);
    expect(payload.from_tag).toBe('v0.10.0');
    expect(payload.proposed_version).toBe('0.11.0');
    expect(payload.bump).toBe('minor');
    expect(payload.prs).toHaveLength(PRS.length);
    expect(payload.changelog).toContain(`- feat(providers): opencode selects the opencode harness (#1315)`);
    expect(payload.changelog.match(/^- /gm)).toHaveLength(PRS.length);
  });

  it('prefers gh merged-PR data and keeps only PRs merged after the tag', async () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-gh-'));
    out = [];
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

    const runner: Runner = async (file, args) => {
      const key = `${file} ${args.join(' ')}`;
      if (key === 'git tag --sort=-v:refname --list v[0-9]*') return 'v0.10.0\n';
      if (key === 'git log -1 --format=%cI v0.10.0') return '2026-10-14T18:23:28-03:00\n';
      if (key === 'git show origin/develop:package.json') {
        return JSON.stringify({ version: '0.10.0' });
      }
      if (key === 'gh pr list --state merged --base develop --limit 1000 --json number,title,mergedAt,url') {
        return JSON.stringify([
          { number: 1200, title: 'feat(old): already released', mergedAt: '2026-10-01T00:00:00Z' },
          { number: 1304, title: 'feat(events): new work', mergedAt: '2026-10-15T00:00:00Z' },
        ]);
      }
      if (key === 'git rev-parse origin/develop') return 'abcdef1234567890\n';
      throw new Error(`unexpected command: ${key}`);
    };

    const code = await releaseTrainCommand(
      { dryRun: true, json: true },
      { runner, root, today: DATE },
    );

    expect(code).toBe(0);
    const payload = JSON.parse(out.join(''));
    expect(payload.prs.map((pr: PullRequest) => pr.number)).toEqual([1304]);
    expect(payload.changelog).toContain('- feat(events): new work (#1304)');
    expect(payload.changelog).not.toContain('#1200');
  });

  it('reports nothing to release when the branch has no new PRs', async () => {
    root = mkdtempSync(join(tmpdir(), 'release-train-empty-'));
    out = [];
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });

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
      { dryRun: true, json: true },
      { runner, root, today: DATE },
    );

    expect(code).toBe(0);
    expect(JSON.parse(out.join('')).proposed_version).toBeNull();
  });
});
