/**
 * Tests for `squads plan` (agents-squads/squads-cli#1279).
 *
 * The roadmap is derived from a plan-of-record tracking issue: an `## Order`
 * table in the body (order, titles, issue refs, blockers) joined against the
 * issue's sub-issue states. Everything below runs against fixture bodies and
 * injected `gh` runners — no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

// Only the DEFAULT runner touches child_process; every behavioral test injects
// its own runner. This mock exists to prove the default is an argument vector.
// Partial: squad-parser still needs the real spawnSync to find a project root.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from 'child_process';
import { loadProjectConfig, resetConfigCache } from '../../src/lib/config.js';
import { stripAnsi } from '../../src/lib/terminal.js';
import {
  GH_TIMEOUT_MS,
  buildRoadmap,
  defaultGhRunner,
  errorMessage,
  indexSubIssues,
  loadPlanRoadmap,
  parseOrderRows,
  parsePlanRef,
  planCachePath,
  planIssueArgs,
  readPlanCache,
  resolvePlanRef,
  subIssuesArgs,
  writePlanCache,
  type GhRunner,
  type SubIssue,
} from '../../src/lib/plan-roadmap.js';
import { planCommand } from '../../src/commands/plan.js';

const mockExecFile = vi.mocked(execFile);

const PLAN_REF = 'agents-squads/squads-cli#1279';
const PLAN = parsePlanRef(PLAN_REF)!;
const REPO_API_URL = 'https://api.github.com/repos/agents-squads/squads-cli';
const PLAN_URL = 'https://github.com/agents-squads/squads-cli/issues/1279';

const BODY = `## Why

A live console needs the roadmap as data.

## Order

| # | Deliverable | Issues | Blocked by | Note |
|---|-------------|--------|------------|------|
| 1 | Scaffold the command | #100 | — | landed first |
| 2 | Parse the Order table | #101 | #100 | |
| 3 | Cache + stale path | #102 | @jorge | needs approval |
| 4 | Document it | — | — | no issue refs |
| 5 | Ship it | #105 | reviewer sign-off | |
| 6 | Wire the dashboard | #106 | #3 | blocked by a row |

## Later

Not this cycle.
`;

function subs(...entries: Array<[number, string | undefined]>): SubIssue[] {
  return entries.map(([number, state]) => ({ number, state, repository_url: REPO_API_URL }));
}

/** Sub-issue states matching BODY: 100 closed; the rest open. */
const SUB_ISSUES = subs([100, 'closed'], [101, 'open'], [102, 'open'], [105, 'open'], [106, 'open']);

function roadmapFrom(body: string, subIssues: SubIssue[] = SUB_ISSUES) {
  return buildRoadmap({ plan: PLAN, body, subIssues, url: PLAN_URL, fetchedAt: '2026-07-21T00:00:00.000Z' });
}

function rowsByN(body: string, subIssues: SubIssue[] = SUB_ISSUES) {
  const map = new Map(roadmapFrom(body, subIssues).rows.map(r => [r.n, r]));
  return (n: number) => map.get(n)!;
}

// ── Command harness ──────────────────────────────────────────────────

let out: string[];
let outSpy: ReturnType<typeof vi.spyOn>;
let cacheDir: string;

beforeEach(() => {
  out = [];
  outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
  cacheDir = mkdtempSync(join(tmpdir(), 'squads-plan-test-'));
  mockExecFile.mockReset();
});

afterEach(() => {
  outSpy.mockRestore();
  rmSync(cacheDir, { recursive: true, force: true });
});

/** Joined stdout with ANSI stripped (a TTY-ish CI sets CLAUDECODE → colors on). */
function stdout(): string {
  return stripAnsi(out.join(''));
}

function stdoutJson(): Record<string, unknown> {
  return JSON.parse(stdout()) as Record<string, unknown>;
}

/** A `gh` runner returning `body` for the issue and `subIssues` for its graph. */
function fakeGh(body: string, subIssues: SubIssue[] = SUB_ISSUES): GhRunner {
  return async (args: string[]) => {
    if (args[1]?.includes('/sub_issues')) return JSON.stringify(subIssues);
    return JSON.stringify({ body, html_url: PLAN_URL });
  };
}

const failingGh: GhRunner = async () => {
  throw new Error('gh: Could not resolve to a Repository');
};

const runCommand = (
  body: string,
  overrides: { runner?: GhRunner; json?: boolean; cachePath?: string | null; env?: NodeJS.ProcessEnv } = {},
) =>
  planCommand(
    { json: overrides.json ?? true },
    {
      runner: overrides.runner ?? fakeGh(body),
      cachePath: overrides.cachePath === undefined ? join(cacheDir, 'plan.json') : overrides.cachePath,
      configPlanIssue: PLAN_REF,
      env: overrides.env ?? {},
      now: () => new Date('2026-07-21T12:00:00.000Z'),
    },
  );

// ── Plan reference ───────────────────────────────────────────────────

describe('plan reference', () => {
  it('parses owner/repo#n and full issue URLs', () => {
    expect(parsePlanRef(' agents-squads/squads-cli#1279 ')).toMatchObject({
      owner: 'agents-squads',
      repo: 'squads-cli',
      number: 1279,
      slug: PLAN_REF,
    });
    expect(parsePlanRef(PLAN_URL)?.slug).toBe(PLAN_REF);
  });

  it('rejects anything that is not a plan reference', () => {
    expect(parsePlanRef('agents-squads/squads-cli')).toBeNull();
    expect(parsePlanRef('agents-squads/squads-cli#')).toBeNull();
    expect(parsePlanRef('')).toBeNull();
    expect(parsePlanRef(undefined)).toBeNull();
    expect(parsePlanRef('https://github.com/agents-squads/squads-cli/issues/1279#issuecomment-1')).toBeNull();
  });

  it('rejects refs that would escape the gh API path or smuggle a query string', () => {
    expect(parsePlanRef('agents-squads/..#1279')).toBeNull();
    expect(parsePlanRef('../squads-cli#1279')).toBeNull();
    expect(parsePlanRef('agents-squads/squads-cli#1279?per_page=1')).toBeNull();
    expect(parsePlanRef('agents-squads/squads-cli#1279/../other')).toBeNull();
  });

  it('lets SQUADS_PLAN_ISSUE override .squads/config.yml, and falls back to it', () => {
    expect(resolvePlanRef('o/e#1', 'a/b#2')).toBe('o/e#1');
    expect(resolvePlanRef('   ', 'a/b#2')).toBe('a/b#2');
    expect(resolvePlanRef(undefined, ' a/b#2 ')).toBe('a/b#2');
    expect(resolvePlanRef(undefined, null)).toBeNull();
  });
});

// ── Table parsing ────────────────────────────────────────────────────

describe('## Order table parsing', () => {
  it('reads rows in order with titles, notes and expanded issue refs', () => {
    const rows = parseOrderRows(BODY, PLAN);
    expect(rows.map(r => r.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[0].title).toBe('Scaffold the command');
    expect(rows[0].issues).toEqual(['agents-squads/squads-cli#100']);
    expect(rows[0].note).toBe('landed first');
    expect(rows[2].humanBlocker).toBe('@jorge');
    expect(rows[5].blockerRefs).toEqual(['agents-squads/squads-cli#3']);
  });

  it('keeps cross-repo refs verbatim and resolves markdown-link refs', () => {
    const body = `## Order

| # | Deliverable | Issues | Blocked by |
|---|-------------|--------|------------|
| 1 | Cross-repo | other-org/other-repo#12 | [\`#9\`](https://github.com/agents-squads/squads-cli/issues/9) |
`;
    const [row] = parseOrderRows(body, PLAN);
    expect(row.issues).toEqual(['other-org/other-repo#12']);
    expect(row.blockerRefs).toEqual(['agents-squads/squads-cli#9']);
  });

  it('treats a "—" or empty Blocked by cell as no blocker', () => {
    const rows = parseOrderRows(BODY, PLAN);
    expect(rows[0].humanBlocker).toBeNull();
    expect(rows[3].humanBlocker).toBeNull();
    expect(rows[3].blockerRefs).toEqual([]);
  });

  it('keeps a link to somewhere other than an issue as plain text', () => {
    const body = `## Order

| # | Deliverable | Issues | Blocked by |
|---|-------------|--------|------------|
| 1 | Row | #1 | [progress tracker](https://example.com/x) |
`;
    const [row] = parseOrderRows(body, PLAN);
    expect(row.blockerRefs).toEqual([]);
    expect(row.humanBlocker).toBe('progress tracker');
  });

  it('reads a separator-less table of pure data rows', () => {
    const body = `## Order

| 1 | Alpha | #1 | — |
| 2 | Beta | #2 | — |
`;
    const rows = parseOrderRows(body, PLAN);
    expect(rows.map(r => [r.n, r.title, r.issues])).toEqual([
      [1, 'Alpha', ['agents-squads/squads-cli#1']],
      [2, 'Beta', ['agents-squads/squads-cli#2']],
    ]);
  });

  it('numbers rows by position when the table has no # column', () => {
    const body = `## Order

| Deliverable | Issues | Blocked by |
|-------------|--------|------------|
| Alpha | #1 | — |
| Beta | #2 | — |
`;
    const rows = parseOrderRows(body, PLAN);
    expect(rows.map(r => [r.n, r.title])).toEqual([[1, 'Alpha'], [2, 'Beta']]);
  });

  it('falls back to the documented column order when no header is recognisable', () => {
    const body = `## Order

| A | B | C |
|---|---|---|
| 1 | Alpha | #1 |
| 2 | Beta | agents-squads/squads-cli#2 |
`;
    const rows = parseOrderRows(body, PLAN);
    expect(rows.map(r => [r.n, r.title, r.issues])).toEqual([
      [1, 'Alpha', ['agents-squads/squads-cli#1']],
      [2, 'Beta', ['agents-squads/squads-cli#2']],
    ]);
  });
});

// ── Row states ───────────────────────────────────────────────────────

describe('roadmap states', () => {
  it('qualifies `repo#n` refs with the plan owner — issue and blocker cells', () => {
    const body = '## Order\n| # | Deliverable | Issue | Blocked by | State |\n|---|---|---|---|---|\n' +
      '| 9 | API public | squads-api#287, squads-cli#1272 | squads-api#288 ← hq#515 (red-team) | blocked |\n';
    const row = roadmapFrom(body, SUB_ISSUES).rows[0]!;
    expect(row.issues).toEqual(['agents-squads/squads-api#287', 'agents-squads/squads-cli#1272']);
    expect(row.blockers).toEqual(['agents-squads/squads-api#288', 'agents-squads/hq#515']);
    expect(row.humanBlocker).toBe('(red-team)');
    const sep = roadmapFrom('## Order\n| # | D | Issue | Blocked by |\n|---|---|---|---|\n| 13 | Home | squads-engine#8 | squads-cli#1279 · squads-cli#1280 |\n', SUB_ISSUES).rows[0]!;
    expect(sep.humanBlocker).toBeNull();
    const mixed = roadmapFrom('## Order\n| # | D | Issue | Blocked by |\n|---|---|---|---|\n| 5 | Slack | hq#550 | squads-cli#1276 · founder Slack app setup |\n', SUB_ISSUES).rows[0]!;
    expect(mixed.humanBlocker).toBe('founder Slack app setup');
  });

  it('accepts a qualified heading — `## Order (founder 10-14)` — but not `## Ordering`', () => {
    const table = '| # | Deliverable | Issue | Blocked by | State |\n|---|---|---|---|---|\n| 11 | CLI plan | squads-cli#1279 | — | todo |\n';
    expect(roadmapFrom(`## Order (founder 10-14)\n${table}`, SUB_ISSUES).rows.map(r => r.n)).toEqual([11]);
    expect(roadmapFrom(`## Ordering notes\n${table}`, SUB_ISSUES).rows).toHaveLength(0);
  });

  it('returns no rows and no throw when there is no ## Order section', () => {
    for (const body of ['## Why\n\nnothing here\n', '## Order\n\nprose, no table\n', '']) {
      const roadmap = roadmapFrom(body);
      expect(roadmap.rows).toEqual([]);
      expect(roadmap.counts).toEqual({ done: 0, ready: 0, blocked: 0, total: 0 });
      expect(roadmap.next).toBeNull();
      expect(roadmap.v).toBe(1);
    }
  });

  it('classifies done / ready / blocked and a human blocker', () => {
    const roadmap = roadmapFrom(BODY);
    const row = rowsByN(BODY);

    expect(row(1).state).toBe('done'); // #100 closed
    expect(row(2).state).toBe('ready'); // blocked by #100, already closed
    expect(row(2).blockers).toEqual([]);
    expect(row(3).state).toBe('blocked');
    expect(row(3).humanBlocker).toBe('@jorge');
    expect(row(3).blockers).toEqual([]); // a human is not a ref
    expect(row(5).state).toBe('blocked');
    expect(row(5).humanBlocker).toBe('reviewer sign-off');
    expect(row(6).state).toBe('blocked'); // "#3" is a row ref, and row 3 is not done
    expect(row(6).blockers).toEqual(['agents-squads/squads-cli#3']);

    expect(roadmap.counts).toEqual({ done: 1, ready: 2, blocked: 3, total: 6 });
    expect(roadmap.next).toBe(2); // first ready row in Order
    expect(roadmap.url).toBe(PLAN_URL);
    expect(roadmap.fetchedAt).toBe('2026-07-21T00:00:00.000Z');
  });

  it('keeps a row blocked while its blocker ref is still open', () => {
    const row = rowsByN(BODY, subs([101, 'open'], [102, 'closed']));
    expect(row(2).state).toBe('blocked'); // #100 unreported ⇒ unverifiable ⇒ blocking
    expect(row(2).blockers).toEqual(['agents-squads/squads-cli#100']);
  });

  it('reports an open blocker ref that is a real issue, not only a row ref', () => {
    const body = `## Order

| # | Deliverable | Issues | Blocked by |
|---|-------------|--------|------------|
| 1 | Blocker | #200 | — |
| 2 | Dependent | #201 | #200 |
`;
    const row = rowsByN(body, subs([200, 'closed'], [201, 'open']));
    expect(row(2).blockers).toEqual([]);
    expect(row(2).state).toBe('ready');

    const stillOpen = rowsByN(body, subs([200, 'open'], [201, 'open']));
    expect(stillOpen(2).state).toBe('blocked');
    expect(stillOpen(2).blockers).toEqual(['agents-squads/squads-cli#200']);
  });

  it('never marks a row with no issue ref as done', () => {
    const allClosed = subs([100, 'closed'], [101, 'closed'], [102, 'closed'], [105, 'closed'], [106, 'closed']);
    const row = rowsByN(BODY, allClosed);
    expect(row(1).state).toBe('done');
    expect(row(2).state).toBe('done');
    expect(row(4).state).toBe('ready'); // no refs ⇒ never done, and nothing blocks it
    expect(row(4).issues).toEqual([]);
    const noRefs = rowsByN('## Order\n\n| # | Deliverable | Issues | Blocked by |\n|---|---|---|---|\n| 4 | Docs | — | — |\n');
    expect(noRefs(4).state).toBe('ready');
  });

  it('resolves done before blockers, and a finished row stops blocking its dependents', () => {
    // 100 open (row 1 not done), 101/102/105 closed, 106 open.
    const roadmap = roadmapFrom(BODY, subs([100, 'open'], [101, 'closed'], [102, 'closed'], [105, 'closed'], [106, 'open']));
    const row = new Map(roadmap.rows.map(r => [r.n, r]));

    expect(row.get(1)!.state).toBe('ready'); // its own issue is open ⇒ not done, but nothing blocks it
    expect(row.get(2)!.state).toBe('done');
    expect(row.get(3)!.state).toBe('done'); // a human blocker is moot once every delivered issue is closed
    expect(row.get(6)!.state).toBe('ready'); // blocked on row 3, which is done
    expect(row.get(6)!.blockers).toEqual([]);
    expect(roadmap.counts).toEqual({ done: 3, ready: 3, blocked: 0, total: 6 });
    expect(roadmap.next).toBe(1);
  });

  it('indexes sub-issues by their own repo, not the plan repo', () => {
    const index = indexSubIssues(
      [
        { number: 5, state: 'closed', repository_url: REPO_API_URL },
        { number: 5, state: 'open', repository_url: 'https://api.github.com/repos/other-org/other-repo' },
      ],
      'agents-squads/squads-cli',
    );
    expect(index.get('agents-squads/squads-cli#5')).toBe(true);
    expect(index.get('other-org/other-repo#5')).toBe(false);
  });
});

// ── Command: configuration ───────────────────────────────────────────

describe('squads plan — configuration', () => {
  it('reports configured:false (exit 0) when no plan is set, without calling gh', async () => {
    const runner = vi.fn<GhRunner>();
    const code = await planCommand(
      { json: true },
      { configPlanIssue: null, env: {}, runner, cachePath: null },
    );
    expect(code).toBe(0);
    expect(stdoutJson()).toMatchObject({ v: 1, configured: false });
    expect(String(stdoutJson().hint)).toContain('plan_issue');
    expect(runner).not.toHaveBeenCalled();
  });

  it('reads SQUADS_PLAN_ISSUE over the config file', async () => {
    const code = await planCommand(
      { json: true },
      {
        configPlanIssue: 'some/other#1',
        env: { SQUADS_PLAN_ISSUE: 'agents-squads/squads-cli#1279' },
        runner: fakeGh(BODY),
        cachePath: null,
        now: () => new Date('2026-07-21T12:00:00.000Z'),
      },
    );
    expect(code).toBe(0);
    expect(stdoutJson().plan).toBe(PLAN_REF);
  });

  it('fails loudly on a malformed plan reference', async () => {
    const code = await planCommand({ json: true }, { configPlanIssue: 'agents-squads/squads-cli', env: {}, cachePath: null });
    expect(code).toBe(1);
    const payload = stdoutJson();
    expect(payload.configured).toBe(false);
    expect(String(payload.error)).toContain('invalid plan reference');
  });

  it('prints a one-line hint (not JSON) without --json', async () => {
    await planCommand({}, { configPlanIssue: null, env: {}, cachePath: null });
    expect(stdout()).toContain('plan_issue');
    expect(stdout()).not.toContain('{');
  });
});

// ── Command: fetch, cache, stale ─────────────────────────────────────

describe('squads plan — fetch and cache', () => {
  it('emits the versioned roadmap on --json and writes the cache', async () => {
    const cachePath = join(cacheDir, 'nested', 'plan.json');
    const code = await runCommand(BODY, { cachePath });
    expect(code).toBe(0);

    const payload = stdoutJson();
    expect(payload).toMatchObject({ v: 1, configured: true, plan: PLAN_REF, url: PLAN_URL, next: 2 });
    expect(payload.counts).toEqual({ done: 1, ready: 2, blocked: 3, total: 6 });
    expect(payload.stale).toBeUndefined();
    expect((payload.rows as unknown[]).length).toBe(6);

    const row = (payload.rows as Array<Record<string, unknown>>)[2];
    expect(row).toMatchObject({ n: 3, state: 'blocked', humanBlocker: '@jorge' });

    // The cache round-trips: same shape, on disk, under .agents/observability/cache.
    expect(existsSync(cachePath)).toBe(true);
    const cached = readPlanCache(cachePath);
    expect(cached).not.toBeNull();
    expect(cached!.counts).toEqual({ done: 1, ready: 2, blocked: 3, total: 6 });
    expect(planCachePath('/tmp/project')).toBe(join('/tmp/project', '.agents', 'observability', 'cache', 'plan.json'));
  });

  it('serves the cached roadmap with stale:true when gh fails', async () => {
    const cachePath = join(cacheDir, 'plan.json');
    // A roadmap fetched earlier (00:00), served when the 12:00 fetch fails.
    writePlanCache(cachePath, roadmapFrom(BODY));

    const code = await runCommand(BODY, { cachePath, runner: failingGh });
    expect(code).toBe(0);

    const payload = stdoutJson();
    expect(payload.stale).toBe(true);
    expect(String(payload.error)).toContain('Could not resolve to a Repository');
    expect(payload.counts).toEqual({ done: 1, ready: 2, blocked: 3, total: 6 });
    expect(payload.fetchedAt).toBe('2026-07-21T00:00:00.000Z'); // when it was really fetched
  });

  it('shows the staleness in human output too', async () => {
    const cachePath = join(cacheDir, 'plan.json');
    await runCommand(BODY, { cachePath });
    out = [];
    await runCommand(BODY, { cachePath, runner: failingGh, json: false });
    expect(stdout()).toContain('STALE');
    expect(stdout()).toContain('BLOCKED');
  });

  it('serves a cache written for another plan only when the plan matches', async () => {
    const cachePath = join(cacheDir, 'plan.json');
    writePlanCache(cachePath, { ...roadmapFrom(BODY), plan: 'other/project#1' });
    const code = await runCommand(BODY, { cachePath, runner: failingGh });
    expect(code).toBe(1); // a stale roadmap for a different plan is not a substitute
    expect(String(stdoutJson().error)).toContain('Could not resolve');
  });

  it('exits 1 with the error in the JSON when gh fails and there is no cache', async () => {
    const code = await runCommand(BODY, { cachePath: join(cacheDir, 'missing.json'), runner: failingGh });
    expect(code).toBe(1);
    const payload = stdoutJson();
    expect(payload).toMatchObject({ v: 1, configured: true, plan: PLAN_REF, next: null });
    expect(payload.rows).toEqual([]);
    expect(String(payload.error)).toContain('Could not resolve');
  });

  it('survives unparseable gh output and still reports the failure', async () => {
    const code = await runCommand(BODY, {
      cachePath: join(cacheDir, 'plan.json'),
      runner: async () => 'not json at all',
    });
    expect(code).toBe(1);
    expect(String(stdoutJson().error)).toBeTruthy();
  });

  it('reports a corrupt cache as no cache', async () => {
    const cachePath = join(cacheDir, 'plan.json');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, '{ this is not json');
    expect(readPlanCache(cachePath)).toBeNull();
    expect(readPlanCache(null)).toBeNull();
    const code = await runCommand(BODY, { cachePath, runner: failingGh });
    expect(code).toBe(1);
  });

  it('loads live again once gh recovers, replacing the stale data', async () => {
    const cachePath = join(cacheDir, 'plan.json');
    await runCommand(BODY, { cachePath });
    out = [];
    await runCommand(BODY, { cachePath, runner: failingGh });
    expect(stdoutJson().stale).toBe(true);
    out = [];
    const body = '## Order\n\n| # | Deliverable | Issues | Blocked by |\n|---|---|---|---|\n| 1 | Only row | #100 | — |\n';
    const code = await runCommand(body, { cachePath });
    expect(code).toBe(0);
    expect(stdoutJson().stale).toBeUndefined();
    expect(stdoutJson().counts).toEqual({ done: 1, ready: 0, blocked: 0, total: 1 });
  });
});

// ── Command: human output ────────────────────────────────────────────

describe('squads plan — human output', () => {
  it('shows next, ready and blocked with blockers', async () => {
    await runCommand(BODY, { json: false });
    const text = stdout();
    expect(text).toContain(`agents-squads/squads-cli#1279`);
    expect(text).toContain('6 deliverables · 1 done · 2 ready · 3 blocked');
    expect(text).toContain('NEXT');
    expect(text).toContain('Parse the Order table');
    expect(text).toContain('READY');
    expect(text).toContain('Document it');
    expect(text).toContain('BLOCKED');
    expect(text).toContain('blocked by #3');
    expect(text).toContain('blocked by reviewer sign-off');
  });

  it('says so when the plan has no table at all', async () => {
    const code = await runCommand('## Nothing\n', { json: false });
    expect(code).toBe(0);
    const text = stdout();
    expect(text).toContain('0 deliverables');
    expect(text).toContain('NEXT');
    expect(text).toContain('READY');
    expect(text).toContain('BLOCKED');
  });

  it('truncates a long group and points at --json', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => `| ${i + 1} | Deliverable ${i + 1} | — | — |`).join('\n');
    await runCommand(`## Order\n\n| # | Deliverable | Issues | Blocked by |\n|---|---|---|---|\n${rows}\n`, {
      json: false,
    });
    expect(stdout()).toContain('25 deliverables · 0 done · 25 ready · 0 blocked');
    expect(stdout()).toContain('… +5 more (use --json)');
  });

  it('reports a hard failure in human output too', async () => {
    const code = await runCommand(BODY, {
      json: false,
      runner: failingGh,
      cachePath: join(cacheDir, 'nothing-here.json'),
    });
    expect(code).toBe(1);
    expect(stdout()).toContain('Could not read agents-squads/squads-cli#1279');
    expect(stdout()).toContain('No cached roadmap yet');
  });
});

// ── Security: argument vectors, never a shell ────────────────────────

describe('gh access', () => {
  it('builds the two documented API calls', () => {
    expect(planIssueArgs(PLAN)).toEqual(['api', 'repos/agents-squads/squads-cli/issues/1279']);
    expect(subIssuesArgs(PLAN)).toEqual([
      'api',
      'repos/agents-squads/squads-cli/issues/1279/sub_issues?per_page=100',
    ]);
  });

  it('spawns gh with an argument vector and a 20 s timeout — no shell string', async () => {
    mockExecFile.mockImplementation((_file, _args, _options, callback) => {
      (callback as (err: Error | null, stdout: string, stderr: string) => void)(
        null,
        JSON.stringify({ body: BODY, html_url: PLAN_URL }),
        '',
      );
      return undefined as never;
    });

    await defaultGhRunner(planIssueArgs(PLAN));

    expect(mockExecFile).toHaveBeenCalledTimes(1);
    const [file, args, options] = mockExecFile.mock.calls[0] as unknown as [string, string[], { timeout: number }];
    expect(file).toBe('gh');
    expect(Array.isArray(args)).toBe(true);
    expect(args).toEqual(['api', 'repos/agents-squads/squads-cli/issues/1279']);
    expect(options.timeout).toBe(GH_TIMEOUT_MS);
    expect(GH_TIMEOUT_MS).toBe(20_000);
  });

  it('reads the issue body and sub-issues from the injected runner, two calls', async () => {
    const calls: string[][] = [];
    const runner: GhRunner = async args => {
      calls.push(args);
      return args[1].includes('/sub_issues')
        ? JSON.stringify(SUB_ISSUES)
        : JSON.stringify({ body: BODY, html_url: PLAN_URL });
    };
    await loadPlanRoadmap({ plan: PLAN, runner, cachePath: null });
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).not.toContain('sub_issues');
    expect(calls[1][1]).toContain('sub_issues');
  });

  it('falls back to an empty body when the payload omits one', async () => {
    const { roadmap } = await loadPlanRoadmap({
      plan: PLAN,
      runner: async args => (args[1].includes('/sub_issues') ? '[]' : '{}'),
      cachePath: null,
    });
    expect(roadmap.rows).toEqual([]);
    expect(roadmap.url).toBe(`https://github.com/${PLAN.owner}/${PLAN.repo}/issues/1279`);
  });

  it('formats an execFile-style failure as one clean line from its stderr', () => {
    const err = Object.assign(new Error('Command failed: gh api repos/o/r/issues/1\ngh: not logged in'), {
      stderr: 'gh: not logged in\nset GH_TOKEN to authenticate\n',
    });
    expect(errorMessage(err)).toBe('gh: not logged in');
    expect(errorMessage(Object.assign(new Error('boom'), { stderr: 'why' }))).toBe('boom — why');
    expect(errorMessage('boom\nsecond line')).toBe('boom second line');
  });
});

// ── Config file resolution ───────────────────────────────────────────

describe('plan_issue in .squads/config.yml', () => {
  let projectDir: string;
  let previousCwd: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'squads-plan-config-'));
    previousCwd = process.cwd();
    delete process.env.SQUADS_PLAN_ISSUE;
    resetConfigCache();
  });

  afterEach(() => {
    process.chdir(previousCwd);
    delete process.env.SQUADS_PLAN_ISSUE;
    resetConfigCache();
  });

  function writeConfig(contents: string): void {
    mkdirSync(join(projectDir, '.squads'), { recursive: true });
    writeFileSync(join(projectDir, '.squads', 'config.yml'), contents);
    process.chdir(projectDir);
  }

  it('reads plan_issue whole, including its #n — not as an inline comment', () => {
    writeConfig('company_name: "Squads"\nplan_issue: agents-squads/squads-cli#1279\n');
    expect(loadProjectConfig().plan_issue).toBe(PLAN_REF);
  });

  it('strips a real inline comment, and quotes, around plan_issue', () => {
    writeConfig('plan_issue: "agents-squads/squads-cli#12"  # the plan of record\n');
    expect(loadProjectConfig().plan_issue).toBe('agents-squads/squads-cli#12');
  });

  it('is null when unset, and SQUADS_PLAN_ISSUE wins over the file', () => {
    writeConfig('company_name: "Squads"\n');
    expect(loadProjectConfig().plan_issue).toBeNull();

    resetConfigCache();
    process.env.SQUADS_PLAN_ISSUE = 'other/repo#7';
    expect(loadProjectConfig().plan_issue).toBe('other/repo#7');
  });
});

// ── Cache file ───────────────────────────────────────────────────────

describe('plan cache', () => {
  it('writes JSON under the given path and ignores unwritable ones', () => {
    const path = join(cacheDir, 'a', 'b', 'plan.json');
    writePlanCache(path, roadmapFrom(BODY));
    expect(JSON.parse(readFileSync(path, 'utf8')).plan).toBe(PLAN_REF);
    expect(() => writePlanCache(null, roadmapFrom(BODY))).not.toThrow();
    expect(() => writePlanCache(join(cacheDir, 'a', 'b', 'plan.json', 'nope', 'x.json'), roadmapFrom(BODY))).not.toThrow();
  });

  it('resolves the default cache path under the project root', () => {
    expect(planCachePath(join(cacheDir, 'project'))).toBe(
      join(cacheDir, 'project', '.agents', 'observability', 'cache', 'plan.json'),
    );
  });
});
