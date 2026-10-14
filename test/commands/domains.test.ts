/**
 * `squads domains` (#1280) — per-domain business scorecard.
 *
 * Fixture squads on disk + a fake `gh` runner (no network). Covers: grouping
 * by repo with the shared-repo label, overdue goals from due dates,
 * unreachable GitHub → `delivered: null` (never 0), the last-good cache path,
 * and the fixed (batched) call count regardless of repos or items.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildDomains,
  domainsCachePath,
  repoSlug,
  repoShort,
  searchQuery,
  type GhRunner,
} from '../../src/lib/domains.js';
import {
  goalsCell,
  deliveredCell,
  nowCell,
  relativeAge,
  renderDomainsTable,
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
function fakeGh(cfg: { prLines?: string[]; issueLines?: string[]; fail?: boolean } = {}): FakeGh {
  const calls: string[][] = [];
  const run: GhRunner = (args) => {
    calls.push(args);
    if (cfg.fail) throw new Error('gh: command not found');
    const isPr = args.some((a) => a.includes('is:pr'));
    return (isPr ? cfg.prLines ?? [] : cfg.issueLines ?? []).join('\n');
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

  it('searchQuery ORs every repo into one query per kind', () => {
    expect(searchQuery('pr', ['a/x', 'b/y'], '2026-07-07'))
      .toBe('repo:a/x repo:b/y is:pr is:merged merged:>=2026-07-07');
    expect(searchQuery('issue', ['a/x'], '2026-07-07'))
      .toBe('repo:a/x is:issue is:closed closed:>=2026-07-07');
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
    expect(first.calls).toHaveLength(2);
    // the PR call carries every repo in one query
    expect(first.calls[0].join(' ')).toContain('repo:acme/a repo:acme/b repo:acme/c repo:acme/d');

    // one repo, no items — still exactly two calls
    const solo = mkdtempSync(join(tmpdir(), 'squads-domains-solo-'));
    const soloSquads = join(solo, '.agents', 'squads');
    mkdirSync(join(soloSquads, 'x'), { recursive: true });
    writeFileSync(join(soloSquads, 'x', 'SQUAD.md'), '---\nrepo: acme/x\n---\n# Squad: x\n');
    const second = fakeGh();
    buildDomains({ projectRoot: solo, squadsDir: soloSquads, days: 7, now: NOW, gh: second.run, runs: [], inbox: [] });
    expect(second.calls).toHaveLength(2);
    rmSync(solo, { recursive: true, force: true });
  });

  it('does not call gh at all when no squad declares a repo', () => {
    squad('ops');
    const { run: gh, calls } = fakeGh();
    const report = buildDomains({ projectRoot: base, squadsDir: squadsDir(), days: 7, now: NOW, gh, runs: [], inbox: [] });
    expect(calls).toHaveLength(0);
    // no repos to search is not an error — an honest empty result
    expect(report.domains[0].delivered).toMatchObject({ prsMerged: 0, issuesClosed: 0, items: [] });
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
  });
});
