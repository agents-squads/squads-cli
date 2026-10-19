/**
 * `squads domains` (#1280) — per-domain business scorecard.
 *
 * Fixture squads on disk + a fake `gh` runner (no network). Covers: grouping
 * by repo with the shared-repo label, overdue goals from due dates,
 * unreachable GitHub → `delivered: null` (never 0), the last-good cache path,
 * and the fixed (batched) call count regardless of repos or items. Also the
 * window itself (#1300): `--since` counts from an exact moment and states it in
 * `window`, `--days` keeps its fixed length, and a bad date is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  PAGE,
  buildDomains,
  domainsCachePath,
  parseSince,
  repoSlug,
  repoShort,
  type GhRunner,
} from '../../src/lib/domains.js';
import {
  domainsCommand,
  goalsCell,
  deliveredCell,
  nowCell,
  relativeAge,
  renderDomainsTable,
  windowPhrase,
} from '../../src/commands/domains.js';
import type { DomainRow, DomainsReport } from '../../src/lib/domains.js';
import type { DetachedRun } from '../../src/lib/runs-inventory.js';
import type { InboxItem } from '../../src/lib/inbox.js';

let base: string;

function squad(name: string, opts: { repo?: string; alsoOwns?: string[]; goals?: Array<{ text: string; done?: boolean }> } = {}): void {
  const dir = join(base, '.agents', 'squads', name);
  mkdirSync(dir, { recursive: true });
  const fm: string[] = [`name: ${name}`];
  if (opts.repo) fm.push(`repo: ${opts.repo}`);
  if (opts.alsoOwns?.length) {
    fm.push('also_owns:');
    for (const r of opts.alsoOwns) fm.push(`  - ${r}`);
  }
  const goals = (opts.goals ?? []).map((g) => `- [${g.done ? 'x' : ' '}] ${g.text}`).join('\n');
  writeFileSync(join(dir, 'SQUAD.md'), `---\n${fm.join('\n')}\n---\n\n# Squad: ${name}\n\n## Goals\n\n${goals}\n`);
}

/** A jq-projected search line: {n:number, t:title, u:repo-slug, at:iso}. */
function line(n: number, t: string, u: string, at: string): string {
  return JSON.stringify({ n, t, u, at });
}

interface FakeGh {
  run: GhRunner;
  calls: string[][];
}

/** Fake `gh`: throws when `fail`, else returns per-kind canned NDJSON. */
function fakeGh(cfg: { prLines?: string[]; issueLines?: string[]; fail?: boolean; missing?: string[]; more?: boolean; errorStdout?: string } = {}): FakeGh {
  const calls: string[][] = [];
  const parse = (lines: string[] = []) => lines.map((l) => JSON.parse(l) as { n: number; t: string; u: string; at: string });
  const run: GhRunner = (args) => {
    calls.push(args);
    if (cfg.fail) throw new Error('gh: command not found');
    if (cfg.errorStdout) throw Object.assign(new Error('gh: exit 1'), { stdout: cfg.errorStdout });
    // Like `gh api graphql`: an alias per repo, null when it can't be resolved
    // (then exit 1 with the data still on stdout).
    const vars = new Map<string, string>();
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '-f') {
        const [k, ...v] = args[i + 1].split('=');
        vars.set(k, v.join('='));
      }
    }
    const prs = parse(cfg.prLines);
    const issues = parse(cfg.issueLines);
    const data: Record<string, unknown> = {};
    const errors: unknown[] = [];
    let anyMissing = false;
    for (let i = 0; vars.has(`o${i}`); i++) {
      const slug = `${vars.get(`o${i}`)}/${vars.get(`n${i}`)}`;
      if ((cfg.missing ?? []).includes(slug)) {
        anyMissing = true;
        data[`r${i}`] = null;
        errors.push({ type: 'NOT_FOUND', path: [`r${i}`], message: `Could not resolve to a Repository with the name '${slug}'.` });
        continue;
      }
      const pageInfo = { hasNextPage: cfg.more === true };
      data[`r${i}`] = {
        pullRequests: { pageInfo, nodes: prs.filter((x) => x.u === slug).map((x) => ({ number: x.n, title: x.t, updatedAt: x.at, mergedAt: x.at })) },
        issues: { pageInfo, nodes: issues.filter((x) => x.u === slug).map((x) => ({ number: x.n, title: x.t, updatedAt: x.at, closedAt: x.at })) },
      };
    }
    const out = JSON.stringify(errors.length ? { data, errors } : { data });
    if (anyMissing) throw Object.assign(new Error('Could not resolve to a Repository'), { stdout: out });
    return out;
  };
  return { run, calls };
}

function run(squad: string, alive = true, startedAt = Date.parse('2026-07-10T00:00:00Z')): DetachedRun {
  return { squad, agent: 'issue-solver', startedAt, pid: 1, pidFile: '', logFile: '', repoRoot: base, alive };
}

function inboxItem(id: string, ref: string): InboxItem {
  return { id, kind: 'run_branch', ref, title: id, ageDays: 1, approveSemantics: 'x' };
}

const NOW = Date.parse('2026-07-14T12:00:00Z');
const squadsDir = () => join(base, '.agents', 'squads');

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'squads-domains-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('repo identity helpers', () => {
  it('repoShort takes the tail; repoSlug handles org/name and URL forms', () => {
    expect(repoShort('acme/squads-cli')).toBe('squads-cli');
    expect(repoShort('git@github.com:acme/squads-cli.git')).toBe('squads-cli');
    expect(repoSlug('acme/squads-cli')).toBe('acme/squads-cli');
    expect(repoSlug('https://github.com/acme/web.git')).toBe('acme/web');
    expect(repoSlug('git@github.com:acme/cli.git')).toBe('acme/cli');
    expect(repoSlug('bare-name')).toBeNull();
  });

});

describe('buildDomains', () => {
  it('groups delivery by repo and labels shared repos without double-counting silently', () => {
    squad('cli', { repo: 'acme/squads-cli' });
    squad('console', { repo: 'acme/squads-cli' });
    squad('web', { repo: 'acme/web' });

    const { run: gh } = fakeGh({
      prLines: [line(1, 'fix: a', 'acme/squads-cli', '2026-07-12T00:00:00Z'), line(2, 'feat: b', 'acme/web', '2026-07-11T00:00:00Z')],
      issueLines: [line(9, 'bug: c', 'acme/squads-cli', '2026-07-10T00:00:00Z')],
    });

    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh, runs: [], inbox: [] });
    const byDomain = Object.fromEntries(report.domains.map((d) => [d.domain, d]));

    expect(byDomain['cli'].delivered).toMatchObject({ prsMerged: 1, issuesClosed: 1 });
    expect(byDomain['console'].delivered).toMatchObject({ prsMerged: 1, issuesClosed: 1 });
    expect(byDomain['web'].delivered).toMatchObject({ prsMerged: 1, issuesClosed: 0 });
    // both squads on acme/squads-cli carry the shared-repo label
    expect(byDomain['cli'].sharedWith).toEqual(['console']);
    expect(byDomain['console'].sharedWith).toEqual(['cli']);
    expect(byDomain['web'].sharedWith).toEqual([]);
    expect(byDomain['cli'].repo).toBe('squads-cli');
    expect(byDomain['cli'].repos).toEqual(['squads-cli']);
  });

  it('counts overdue from due dates, leaving completed and future goals alone', () => {
    squad('cli', {
      repo: 'acme/squads-cli',
      goals: [
        { text: 'Ship the launch by 2020-01-01' },            // active, past → overdue
        { text: 'Land the migration by 2099-01-01' },          // active, future
        { text: 'Retire the old runner by 2020-01-01', done: true }, // completed
        { text: 'Keep the lights on' },                        // no due date
      ],
    });
    const { run: gh } = fakeGh();
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh, runs: [], inbox: [] });
    expect(report.domains[0].goals).toEqual({ active: 3, done: 1, overdue: 1 });
  });

  it('gives delivered: null with an error — never 0 — when GitHub is unreachable', () => {
    squad('cli', { repo: 'acme/squads-cli', goals: [{ text: 'Ship by 2020-01-01' }] });
    const { run: gh } = fakeGh({ fail: true });

    const report = buildDomains({
      projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh,
      runs: [run('cli')], inbox: [inboxItem('branch-agent/cli/x-1', 'agent/cli/x-1')],
    });

    const cli = report.domains[0];
    expect(cli.delivered).toBeNull();
    expect(cli.delivered).not.toMatchObject({ prsMerged: 0 });
    expect(cli.deliveredError).toBeTruthy();
    // goals and live state still show
    expect(cli.goals).toEqual({ active: 1, done: 0, overdue: 1 });
    expect(cli.now).toEqual({ running: 1, needsYou: 1 });
    expect(report.stale).toBe(false);
  });

  it('serves the last-good cache flagged stale when GitHub fails', () => {
    squad('cli', { repo: 'acme/squads-cli' });
    const cache = {
      fetchedAt: '2026-07-13T00:00:00.000Z',
      days: 7,
      repos: { 'acme/squads-cli': { prsMerged: 4, issuesClosed: 2, items: [{ ref: '#7', title: 'cached', at: '2026-07-12T00:00:00Z' }] } },
    };
    mkdirSync(join(base, '.agents', 'observability', 'cache'), { recursive: true });
    writeFileSync(domainsCachePath(base), JSON.stringify(cache));

    const { run: gh } = fakeGh({ fail: true });
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh, runs: [], inbox: [] });

    expect(report.stale).toBe(true);
    expect(report.domains[0].delivered).toMatchObject({ prsMerged: 4, issuesClosed: 2, stale: true });
    expect(report.domains[0].deliveredError).toBeUndefined();
  });

  it('writes the last-good cache when GitHub answers', () => {
    squad('cli', { repo: 'acme/squads-cli' });
    const { run: gh } = fakeGh({ prLines: [line(1, 'x', 'acme/squads-cli', '2026-07-12T00:00:00Z')] });
    buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh, runs: [], inbox: [] });
    // now a later, offline build can still serve it
    const { run: down } = fakeGh({ fail: true });
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: down, runs: [], inbox: [] });
    expect(report.stale).toBe(true);
    expect(report.domains[0].delivered?.prsMerged).toBe(1);
  });

  it('makes a constant number of gh calls, independent of repos and items', () => {
    // many repos, many items
    squad('a', { repo: 'acme/a', alsoOwns: ['acme/b', 'acme/c'] });
    squad('d', { repo: 'acme/d' });
    const many = Array.from({ length: 50 }, (_, i) => line(i + 1, `t${i}`, 'acme/a', '2026-07-12T00:00:00Z'));
    const first = fakeGh({ prLines: many, issueLines: many });
    buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: first.run, runs: [], inbox: [] });
    // ONE GraphQL call carries every repo
    expect(first.calls).toHaveLength(1);
    expect(first.calls[0][1]).toBe('graphql');
    for (const slug of ['acme/a', 'acme/b', 'acme/c', 'acme/d']) {
      const [o, n] = slug.split('/');
      expect(first.calls[0].join(' ')).toMatch(new RegExp(`-f o\\d+=${o} -f n\\d+=${n}\\b`));
    }

    // one repo, no items — still exactly two calls
    const solo = mkdtempSync(join(tmpdir(), 'squads-domains-solo-'));
    const soloSquads = join(solo, '.agents', 'squads');
    mkdirSync(join(soloSquads, 'x'), { recursive: true });
    writeFileSync(join(soloSquads, 'x', 'SQUAD.md'), '---\nrepo: acme/x\n---\n# Squad: x\n');
    const second = fakeGh();
    buildDomains({ projectRoot: solo, squadsDir: soloSquads, days: 7, now: NOW, gh: second.run, runs: [], inbox: [] });
    expect(second.calls).toHaveLength(1);
    rmSync(solo, { recursive: true, force: true });
  });

  it('does not call gh at all when no squad declares a repo', () => {
    squad('ops');
    const { run: gh, calls } = fakeGh();
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh, runs: [], inbox: [] });
    expect(calls).toHaveLength(0);
    // no repo means nothing measurable: visibly absent, not a zero that reads as "did nothing"
    expect(report.domains[0].delivered).toBeNull();
    expect(report.domains[0].deliveredError).toBe('no GitHub repo declared');
  });

  it('emits a versioned report sorted by last activity (newest first)', () => {
    squad('old', { repo: 'acme/old' });
    squad('new', { repo: 'acme/new' });
    const { run: gh } = fakeGh({
      prLines: [
        line(1, 'recent', 'acme/new', '2026-07-13T00:00:00Z'),
        line(2, 'ancient', 'acme/old', '2026-07-08T00:00:00Z'),
      ],
    });
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh, runs: [], inbox: [] });

    expect(report.v).toBe(1);
    expect(report.days).toBe(7);
    // the default window is a fixed length back from now, and says so
    expect(report.window).toEqual({ since: '2026-07-07T12:00:00.000Z', until: '2026-07-14T12:00:00.000Z' });
    expect(typeof report.fetchedAt).toBe('string');
    expect(report.domains.map((d) => d.domain)).toEqual(['new', 'old']);
    expect(report.domains[0].lastActivityAt).toBe('2026-07-13T00:00:00.000Z');
  });
});

describe('human rendering', () => {
  function row(over: Partial<DomainRow> = {}): DomainRow {
    return {
      domain: 'cli', repo: 'squads-cli', repos: ['squads-cli'], sharedWith: [],
      goals: { active: 2, done: 3, overdue: 0 },
      delivered: { prsMerged: 4, issuesClosed: 2, items: [] },
      now: { running: 1, needsYou: 0 },
      lastActivityAt: '2026-07-13T00:00:00.000Z',
      ...over,
    };
  }

  it('renders goals, delivered and now cells', () => {
    expect(goalsCell(row())).toBe('3/5');
    expect(goalsCell(row({ goals: { active: 2, done: 3, overdue: 1 } }))).toBe('3/5 · 1 late');
    expect(goalsCell(row({ goals: { active: 0, done: 0, overdue: 0 } }))).toBe('—');

    expect(deliveredCell(row())).toBe('4 PR · 2 issues');
    expect(deliveredCell(row({ delivered: { prsMerged: 0, issuesClosed: 0, items: [] } }))).toBe('nothing');
    expect(deliveredCell(row({ delivered: { prsMerged: 1, issuesClosed: 0, items: [], stale: true } }))).toBe('1 PR (stale)');
    expect(deliveredCell(row({ delivered: null, deliveredError: 'nope' }))).toBe('n/a');

    expect(nowCell(row())).toBe('1 run');
    expect(nowCell(row({ now: { running: 2, needsYou: 3 } }))).toBe('2 runs · 3 to review');
    expect(nowCell(row({ now: { running: 0, needsYou: 0 } }))).toBe('—');
  });

  it('renders relative ages', () => {
    const now = '2026-07-14T12:00:00.000Z';
    expect(relativeAge(null, now)).toBe('—');
    expect(relativeAge('2026-07-14T11:59:30.000Z', now)).toBe('just now');
    expect(relativeAge('2026-07-14T11:30:00.000Z', now)).toBe('30m ago');
    expect(relativeAge('2026-07-14T06:00:00.000Z', now)).toBe('6h ago');
    expect(relativeAge('2026-07-11T12:00:00.000Z', now)).toBe('3d ago');
  });

  it('renders a table (with shared-repo label and stale note) without crashing', () => {
    // NOTE: writeLine writes through to stdout; the assertions re-decide by
    // capturing it so the render path is actually exercised.
    const captured: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => { captured.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      const report: DomainsReport = {
        v: 1, days: 7, fetchedAt: '2026-07-14T12:00:00.000Z', stale: true,
        window: { since: '2026-07-07T12:00:00.000Z', until: '2026-07-14T12:00:00.000Z' },
        domains: [row({ sharedWith: ['console'] })],
      };
      renderDomainsTable(report);
    } finally {
      process.stdout.write = orig;
    }
    const text = captured.join('');
    expect(text).toContain('DOMAIN');
    expect(text).toContain('shared: console');
    expect(text).toContain('GitHub was unreachable');
    // a stale table names the window the figures actually cover
    expect(text).toContain('2026-07-07T12:00:00.000Z');
  });

  it('names the window in the footer: a length for whole days, the start otherwise', () => {
    const report = (days: number, since: string, until: string): DomainsReport => ({
      v: 1, days, window: { since, until }, fetchedAt: until, stale: false, domains: [],
    });
    expect(windowPhrase(report(7, '2026-07-07T12:00:00.000Z', '2026-07-14T12:00:00.000Z'))).toBe('in the last 7 days');
    expect(windowPhrase(report(1, '2026-07-13T12:00:00.000Z', '2026-07-14T12:00:00.000Z'))).toBe('in the last 1 day');
    // an exact moment is not a whole number of days: name it
    expect(windowPhrase(report(2.5, '2026-07-12T00:00:00.000Z', '2026-07-14T12:00:00.000Z'))).toBe('since 2026-07-12T00:00:00.000Z');
  });
});

describe('buildDomains — honest when GitHub cannot see a repo', () => {
  it('a repo GitHub cannot resolve is unknown (null + reason), never 0; partial misses are listed', () => {
    squad('ghost', { repo: 'acme/ghost' });
    squad('mixed', { repo: 'acme/real', alsoOwns: ['acme/gone'] });
    const gh = fakeGh({ missing: ['acme/ghost', 'acme/gone'], prLines: [line(7, 'shipped', 'acme/real', '2026-07-12T00:00:00Z')] });
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: gh.run, runs: [], inbox: [] });
    const ghost = report.domains.find((d) => d.domain === 'ghost')!;
    expect(ghost.delivered).toBeNull();
    expect(ghost.deliveredError).toContain('acme/ghost');
    const mixed = report.domains.find((d) => d.domain === 'mixed')!;
    expect(mixed.delivered).toMatchObject({ prsMerged: 1, unreachable: ['acme/gone'] });
  });

  it('a squad with no repo has nothing to measure: null with a reason, not zeros', () => {
    squad('ops');
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: fakeGh().run, runs: [], inbox: [] });
    expect(report.domains[0]).toMatchObject({ delivered: null, deliveredError: 'no GitHub repo declared' });
  });

  it('one call for any number of repos; owners and names only as variables, never in the query', () => {
    for (let i = 0; i < 25; i++) squad(`s${i}`, { repo: `acme/r${i}` });
    const gh = fakeGh();
    buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: gh.run, runs: [], inbox: [] });
    expect(gh.calls).toHaveLength(1);
    const query = gh.calls[0].find((a) => a.startsWith('query='))!;
    expect(query).not.toContain('acme');
  });

  it('more pages whose last node was updated inside the window: truncated (a lower bound)', () => {
    squad('busy', { repo: 'acme/busy' });
    const inWindow = Array.from({ length: PAGE }, (_, i) => line(i + 1, `t${i}`, 'acme/busy', '2026-07-13T00:00:00Z'));
    const busy = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: fakeGh({ prLines: inWindow, more: true }).run, runs: [], inbox: [] });
    expect(busy.domains[0].delivered).toMatchObject({ prsMerged: PAGE, truncated: true });
    // more pages, but the page already reached updates older than the window: complete
    const old = [...inWindow.slice(0, 3), line(999, 'old', 'acme/busy', '2026-06-01T00:00:00Z')];
    const calm = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: fakeGh({ prLines: old, more: true }).run, runs: [], inbox: [] });
    expect(calm.domains[0].delivered).toMatchObject({ prsMerged: 3 });
    expect(calm.domains[0].delivered!.truncated).toBeUndefined();
  });

  it('a failed fetch (bad credentials, rate limit) is never "repo not found": stale cache, cache kept', () => {
    squad('cli', { repo: 'acme/cli' });
    const good = fakeGh({ prLines: [line(1, 'a', 'acme/cli', '2026-07-13T00:00:00Z')] });
    buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: good.run, runs: [], inbox: [] });
    for (const errorStdout of ['{"message":"Bad credentials"}', '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}']) {
      const r = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: fakeGh({ errorStdout }).run, runs: [], inbox: [] });
      expect(r.stale).toBe(true);
      expect(r.domains[0].delivered).toMatchObject({ prsMerged: 1, stale: true });
    }
    // a cache for another window is not served
    const other = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 90, now: NOW, gh: fakeGh({ fail: true }).run, runs: [], inbox: [] });
    expect(other.domains[0].delivered).toBeNull();
  });

  it('slugs: validated, case-insensitive, quotes stripped', () => {
    expect(repoSlug('"acme/web"')).toBe('acme/web');
    expect(repoSlug('../x')).toBeNull();
    expect(repoSlug('-x/y')).toBeNull();
    expect(repoSlug('a/..')).toBeNull();
    squad('dup', { repo: 'Acme/Cli', alsoOwns: ['acme/cli'] });
    const gh = fakeGh();
    buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: gh.run, runs: [], inbox: [] });
    expect(gh.calls[0]!.filter((a) => /^n\d+=/.test(a))).toEqual(['n0=cli']);
  });
});

describe('buildDomains — goals come from goals.md when the squad has one', () => {
  it('counts active, achieved and overdue from the memory goals file', () => {
    squad('cli', { repo: 'acme/cli' });
    const mem = join(base, '.agents', 'memory', 'cli');
    mkdirSync(mem, { recursive: true });
    writeFileSync(join(mem, 'goals.md'), [
      '## Active',
      '1. **Late one** — x | deadline: 2026-06-26 | status: not-started',
      '2. **Range, final date passed** — x | deadline: spec by 2026-06-19, first slice 2026-07-03 | status: in-progress',
      '5. **Range, final date ahead** — x | deadline: spec by 2026-06-19, ship 2026-08-01 | status: in-progress',
      '6. **Invalid date** — x | deadline: 2026-13-45 | status: in-progress',
      '3. **Future** — x | deadline: 2026-08-01 | status: in-progress',
      '4. **Ongoing** — x | deadline: ongoing | status: in-progress',
      '## Achieved',
      '1. **Shipped** — achieved: yes | date: 2026-05-11',
      '## Abandoned',
      '1. **Dropped** — reason: no | status: abandoned',
    ].join('\n'));
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: fakeGh().run, runs: [], inbox: [] });
    expect(report.domains[0].goals).toEqual({ active: 6, done: 1, overdue: 2 });
  });
});

describe('parseSince', () => {
  it('accepts ISO-8601 dates and instants, rejects everything else', () => {
    expect(parseSince('2026-10-15')).toBe(Date.parse('2026-10-15T00:00:00Z'));
    expect(parseSince('2026-10-15T11:13:00Z')).toBe(Date.parse('2026-10-15T11:13:00Z'));
    expect(parseSince('2026-10-15T11:13:00.500Z')).toBe(Date.parse('2026-10-15T11:13:00.500Z'));
    expect(parseSince('2026-10-15T11:13:00+02:00')).toBe(Date.parse('2026-10-15T11:13:00+02:00'));
    expect(parseSince(1_700_000_000_000)).toBe(1_700_000_000_000);

    // never a silently different window: unparseable and non-ISO are refused
    for (const bad of ['', '   ', 'not-a-date', 'Oct 15 2026', '2026/10/15', '2026-13-45', 'yesterday']) {
      expect(parseSince(bad), bad).toBeNull();
    }
    expect(parseSince(Number.NaN)).toBeNull();
  });
});

describe('buildDomains — an explicit window start (--since)', () => {
  const T = '2026-07-12T00:00:00Z';

  it('counts only merges and closes after that moment, and states the window', () => {
    squad('cli', { repo: 'acme/squads-cli' });
    const gh = fakeGh({
      prLines: [
        line(1, 'before', 'acme/squads-cli', '2026-07-09T00:00:00Z'),
        line(2, 'exactly at', 'acme/squads-cli', T), // the start is inclusive
        line(3, 'after', 'acme/squads-cli', '2026-07-13T00:00:00Z'),
      ],
      issueLines: [
        line(8, 'closed before', 'acme/squads-cli', '2026-07-09T12:00:00Z'),
        line(9, 'closed after', 'acme/squads-cli', '2026-07-14T00:00:00Z'),
      ],
    });

    const report = buildDomains({
      projectRoot: base, squadsDir: squadsDir(), days: 7, since: T, now: NOW,
      gh: gh.run, runs: [], inbox: [],
    });

    const cli = report.domains[0];
    expect(cli.delivered).toMatchObject({ prsMerged: 2, issuesClosed: 1 });
    expect(cli.delivered!.items.map((i) => i.title)).toEqual(['closed after', 'after', 'exactly at']);
    // the window is the one asked for, and the counts are of that window
    expect(report.window).toEqual({ since: '2026-07-12T00:00:00.000Z', until: '2026-07-14T12:00:00.000Z' });
    // `days` never disagrees with `window`: 2.5 days, not the --days default
    expect(report.days).toBe(2.5);
    // gh is asked for the same window the report states
    expect(gh.calls[0].join(' ')).toContain(`-f since=2026-07-12T00:00:00.000Z`);
  });

  it('--since overrides --days, and a date-only value starts at midnight', () => {
    squad('cli', { repo: 'acme/squads-cli' });
    const gh = fakeGh({ prLines: [line(1, 'midnight', 'acme/squads-cli', '2026-07-12T04:00:00Z')] });
    const report = buildDomains({
      projectRoot: base, squadsDir: squadsDir(), days: 90, since: '2026-07-12', now: NOW,
      gh: gh.run, runs: [], inbox: [],
    });
    expect(report.window.since).toBe('2026-07-12T00:00:00.000Z');
    expect(report.domains[0].delivered).toMatchObject({ prsMerged: 1 });
  });

  it('refuses an invalid date instead of guessing a window', () => {
    squad('cli', { repo: 'acme/squads-cli' });
    for (const bad of ['not-a-date', '2026-13-45', '']) {
      expect(() =>
        buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, since: bad, now: NOW, gh: fakeGh().run, runs: [], inbox: [] }),
      ).toThrow(/Invalid --since/);
    }
  });

  it('a --since window is cached and served separately from a --days window', () => {
    squad('cli', { repo: 'acme/squads-cli' });
    const good = fakeGh({ prLines: [line(4, 'x', 'acme/squads-cli', '2026-07-13T00:00:00Z')] });
    buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, since: T, now: NOW, gh: good.run, runs: [], inbox: [] });
    expect((JSON.parse(readFileSync(domainsCachePath(base), 'utf8')) as { since?: string }).since).toBe('2026-07-12T00:00:00.000Z');

    // the same window, offline: the cached figures, the window they cover
    const down = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, since: T, now: NOW, gh: fakeGh({ fail: true }).run, runs: [], inbox: [] });
    expect(down.stale).toBe(true);
    expect(down.domains[0].delivered).toMatchObject({ prsMerged: 1, stale: true });
    expect(down.window).toEqual({ since: '2026-07-12T00:00:00.000Z', until: '2026-07-14T12:00:00.000Z' });

    // a different window is a different question: never answered from this cache
    const other = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh: fakeGh({ fail: true }).run, runs: [], inbox: [] });
    expect(other.domains[0].delivered).toBeNull();
    expect(other.stale).toBe(false);
  });
});

describe('domainsCommand — bad flags fail loudly, never with a guessed window', () => {
  /** Capture what the command writes, with the exit code restored after. */
  async function capture(fn: () => Promise<void>): Promise<{ out: string; exitCode: number | undefined }> {
    const captured: string[] = [];
    const origWrite = process.stdout.write;
    const origExit = process.exitCode;
    process.stdout.write = ((chunk: unknown) => { captured.push(String(chunk)); return true; }) as typeof process.stdout.write;
    try {
      await fn();
      return { out: captured.join(''), exitCode: process.exitCode };
    } finally {
      process.stdout.write = origWrite;
      process.exitCode = origExit;
    }
  }

  it('rejects an invalid --since before doing any work', async () => {
    const { out, exitCode } = await capture(() => domainsCommand({ since: 'not-a-date', json: true }));
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(out) as { ok: boolean; command: string; error: string };
    expect(parsed).toMatchObject({ ok: false, command: 'domains' });
    expect(parsed.error).toContain('Invalid --since "not-a-date"');
    expect(parsed.error).toContain('ISO-8601');
  });

  it('says the same thing in the human path', async () => {
    const { out, exitCode } = await capture(() => domainsCommand({ since: '2026-13-45' }));
    expect(exitCode).toBe(1);
    expect(out).toContain('Invalid --since "2026-13-45"');
  });
});
