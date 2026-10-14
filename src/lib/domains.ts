/**
 * domains.ts — per-domain (squad) business scorecard (#1280).
 *
 * `squads status --json` answers "how many agents, how much memory" — it never
 * answers the question a business user actually has: what did this domain set
 * out to do, what did it *deliver*, and what's in flight right now. This
 * assembles exactly that, per squad:
 *
 *   goals      ← the squad's SQUAD.md checkboxes (done / active / overdue)
 *   delivered  ← git-derived outcomes: merged PRs + closed issues over --days
 *   now        ← live background runs + inbox items waiting on a human
 *
 * The delivery figures come from GitHub, but never one request per repo or per
 * item: ONE search for merged PRs and ONE for closed issues cover every squad
 * repo at once (`repo:a repo:b … is:pr is:merged merged:>=DATE`), paged. A repo
 * shared by two squads is counted for both, and the row carries `sharedWith` so
 * the overlap is visible, never a silent double count.
 *
 * Everything degrades: if GitHub is unreachable, `delivered` is null with an
 * `error` (never a lying 0) and the last good result is served from
 * `.agents/observability/cache/domains.json` flagged `stale: true`. Goals and
 * runs still show either way.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  findSquadsDir,
  listSquads,
  parseSquadFile,
  squadNamedIn,
  type Squad,
} from './squad-parser.js';
import { parseGoalDescription } from './goal-parser.js';
import { goalCounts, parseGoalsMd } from './goals-md.js';
import { listDetachedRuns, type DetachedRun } from './runs-inventory.js';
import { buildInbox, type InboxItem } from './inbox.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Result shapes ────────────────────────────────────────────────────

export interface DeliveredItem {
  /** GitHub ref, e.g. "#123". */
  ref: string;
  title: string;
  /** ISO timestamp the PR merged / issue closed. */
  at: string;
}

export interface Delivered {
  prsMerged: number;
  issuesClosed: number;
  /** The most recent ≤5 outcomes (PRs and issues interleaved by date). */
  items: DeliveredItem[];
  /** True when these figures came from cache because GitHub was unreachable. */
  stale?: boolean;
  /** Repos of this squad GitHub couldn't resolve — not counted, not zero. */
  unreachable?: string[];
  /** Some repo filled a page inside the window: the counts are a lower bound. */
  truncated?: boolean;
}

export interface DomainGoals {
  active: number;
  done: number;
  /** Active goals whose parsed due date is before today. */
  overdue: number;
}

export interface DomainNow {
  running: number;
  needsYou: number;
}

export interface DomainRow {
  /** Squad directory name — the domain identity. */
  domain: string;
  /** Primary repo (short name), null when the squad declares none. */
  repo: string | null;
  /** Every repo this domain touches (primary + `also_owns`), short names. */
  repos: string[];
  /** Other squads whose repos overlap this one — the double-count guard. */
  sharedWith: string[];
  goals: DomainGoals;
  delivered: Delivered | null;
  /** Present when `delivered` is null (GitHub unreachable, no cache). */
  deliveredError?: string;
  now: DomainNow;
  /** Newest of the timestamps behind this row, or null when there is none. */
  lastActivityAt: string | null;
}

export interface DomainsReport {
  v: 1;
  days: number;
  fetchedAt: string;
  /** True when delivery figures were served from the last-good cache. */
  stale: boolean;
  domains: DomainRow[];
}

// ── Repo identity ────────────────────────────────────────────────────

/** Short name of a `repo:` value (matches squadRepoMap): `org/name` → `name`. */
export function repoShort(repo: string): string {
  return repo.trim().replace(/\.git$/, '').split('/').pop() ?? '';
}

/**
 * `owner/name` slug for a `repo:` value, or null when only a bare name is
 * given. Accepts `org/name`, `https://github.com/org/name[.git]`,
 * `git@github.com:org/name.git`.
 */
export function repoSlug(repo: string): string | null {
  const v = repo.trim().replace(/\.git$/, '');
  const url = v.match(/github\.com[:/]([^/\s]+\/[^/\s]+)$/i);
  if (url) return url[1];
  if (/^[^/\s]+\/[^/\s]+$/.test(v)) return v;
  return null;
}

/**
 * Resolve a `repo:` value to an `owner/name` slug. Bare names (`repo: squads-cli`)
 * fall back to the local sibling clone's `origin` remote — repos live as
 * siblings of the dispatch project (same convention as runs-inventory).
 */
export function resolveRepoSlug(repo: string, projectRoot: string): string | null {
  const direct = repoSlug(repo);
  if (direct) return direct;
  const name = repoShort(repo);
  if (!name) return null;
  for (const root of [projectRoot, join(projectRoot, '..')]) {
    const candidate = join(root, name);
    if (!existsSync(join(candidate, '.git'))) continue;
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: candidate,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }).trim();
      const m = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i);
      if (m) return m[1];
    } catch {
      // no remote / not a clone — fall through
    }
  }
  return null;
}

// ── GitHub delivery (batched) ────────────────────────────────────────

/** Shell-free `gh` invocation: an argument vector, never a shell string. */
export type GhRunner = (args: string[]) => string;

/** Default runner: `execFile`-style argv, 20 s timeout (a hanging gh must not hang the CLI). */
export function defaultGhRunner(args: string[]): string {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // execFileSync's message embeds the whole argv + query — surface only the
    // first line of stderr so a row's `error` stays legible.
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? String(err.stderr) : '';
    const first = stderr.split('\n').map((l) => l.trim()).find(Boolean) ?? err.message ?? 'gh failed';
    const stdout = (e as { stdout?: Buffer | string }).stdout;
    throw Object.assign(new Error(first), { stdout: stdout ? String(stdout) : '' });
  }
}


export interface RepoDelivery {
  prsMerged: number;
  issuesClosed: number;
  items: DeliveredItem[];
  /** A page filled inside the window: the counts are a lower bound. */
  truncated?: boolean;
}





/** Nodes read per repo and kind; a full page inside the window is flagged `truncated`. */
export const PAGE = 100;

export interface DeliveryFetch {
  byRepo: Record<string, RepoDelivery>;
  /** Slugs GitHub couldn't resolve for this token — unknown, never 0. */
  unreachable: string[];
}

/**
 * Merged PRs + closed issues over `days` for every repo in ONE GraphQL call:
 * an alias per repo, owners and names passed as variables (never spliced into
 * the query). GraphQL instead of the search API because search silently
 * skips `repo:`s it can't index — private repos the token can read included —
 * and misbehaves on long `repo:` lists; here a missing repo is an explicit
 * null. gh exits 1 on a partial NOT_FOUND but still prints the data: read it.
 */
export function fetchDelivery(slugs: string[], days: number, run: GhRunner, now: Date): DeliveryFetch {
  const byRepo: Record<string, RepoDelivery> = {};
  const unreachable: string[] = [];
  if (slugs.length === 0) return { byRepo, unreachable };
  const sinceMs = now.getTime() - days * DAY_MS;
  const since = new Date(sinceMs).toISOString();
  const decl = ['$since:DateTime!'];
  const sel: string[] = [];
  const args = ['api', 'graphql', '-f', `since=${since}`];
  slugs.forEach((slug, i) => {
    const [owner, name] = slug.split('/');
    decl.push(`$o${i}:String!`, `$n${i}:String!`);
    sel.push(
      `r${i}: repository(owner:$o${i},name:$n${i}){` +
        `pullRequests(states:MERGED,first:${PAGE},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title mergedAt}}` +
        `issues(states:CLOSED,first:${PAGE},filterBy:{since:$since},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title closedAt}}}`,
    );
    args.push('-f', `o${i}=${owner}`, '-f', `n${i}=${name}`);
  });
  args.splice(2, 0, '-f', `query=query(${decl.join(',')}){${sel.join(' ')}}`);

  let out: string;
  try {
    out = run(args);
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? '';
    if (!out) throw e;
  }
  type Node = { number: number; title: string; mergedAt?: string; closedAt?: string };
  type Repo = { pullRequests?: { nodes?: Node[] }; issues?: { nodes?: Node[] } } | null;
  const data = (JSON.parse(out) as { data?: Record<string, Repo> }).data ?? {};

  slugs.forEach((slug, i) => {
    const repo = data[`r${i}`];
    if (!repo) {
      unreachable.push(slug);
      return;
    }
    const d: RepoDelivery = { prsMerged: 0, issuesClosed: 0, items: [] };
    const prs = repo.pullRequests?.nodes ?? [];
    const issues = repo.issues?.nodes ?? [];
    for (const n of prs) {
      if (!n.mergedAt || Date.parse(n.mergedAt) < sinceMs) continue;
      d.prsMerged++;
      d.items.push({ ref: `#${n.number}`, title: n.title, at: n.mergedAt });
    }
    for (const n of issues) {
      if (!n.closedAt || Date.parse(n.closedAt) < sinceMs) continue;
      d.issuesClosed++;
      d.items.push({ ref: `#${n.number}`, title: n.title, at: n.closedAt });
    }
    // A full page whose oldest node is still inside the window may hide more.
    const full = (nodes: Node[], at: (n: Node) => string | undefined) =>
      nodes.length === PAGE && Date.parse(at(nodes[nodes.length - 1]!) ?? '') >= sinceMs;
    if (full(prs, (n) => n.mergedAt) || full(issues, (n) => n.closedAt)) d.truncated = true;
    byRepo[slug] = d;
  });
  return { byRepo, unreachable };
}

// ── Last-good cache ──────────────────────────────────────────────────

export interface DomainsCache {
  fetchedAt: string;
  repos: Record<string, RepoDelivery>;
}

export function domainsCachePath(projectRoot: string): string {
  return join(projectRoot, '.agents', 'observability', 'cache', 'domains.json');
}

function readCache(projectRoot: string): DomainsCache | null {
  const path = domainsCachePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const c = JSON.parse(readFileSync(path, 'utf8')) as DomainsCache;
    return c && typeof c.fetchedAt === 'string' && c.repos ? c : null;
  } catch {
    return null;
  }
}

function writeCache(projectRoot: string, cache: DomainsCache): void {
  try {
    const path = domainsCachePath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  } catch {
    // cache is a nicety — never fail the report over it
  }
}

// ── Assembly ─────────────────────────────────────────────────────────

export interface BuildDomainsOptions {
  projectRoot: string;
  /** Defaults to findSquadsDir(). */
  squadsDir?: string | null;
  days: number;
  /** Injectable for tests. */
  gh?: GhRunner;
  /** Injectable for tests (defaults to the live pid-file inventory). */
  runs?: DetachedRun[];
  /** Injectable for tests (defaults to buildInbox over the project). */
  inbox?: InboxItem[];
  /** Epoch ms treated as "now" (tests); defaults to Date.now(). */
  now?: number;
}

/** The squad whose name appears in an inbox item's ref/id — the item's owner. */
function inboxItemSquad(item: InboxItem, names: string[]): string | null {
  return squadNamedIn(item.ref, names) ?? squadNamedIn(item.title, names) ?? squadNamedIn(item.id, names);
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Assemble the per-domain report. Pure over its inputs (network/fs aside), so
 * tests drive it with fixture squads + a fake `gh` runner.
 */
export function buildDomains(opts: BuildDomainsOptions): DomainsReport {
  const nowMs = opts.now ?? Date.now();
  const now = new Date(nowMs);
  const projectRoot = opts.projectRoot;
  const squadsDir = opts.squadsDir === undefined ? findSquadsDir() : opts.squadsDir;

  // 1. Load every squad from disk (unreadable ones are skipped, not fatal).
  const squads: Array<{ name: string; squad: Squad }> = [];
  if (squadsDir) {
    for (const name of listSquads(squadsDir)) {
      try {
        squads.push({ name, squad: parseSquadFile(join(squadsDir, name, 'SQUAD.md')) });
      } catch {
        // unreadable SQUAD.md — the domain simply doesn't appear
      }
    }
  }
  const squadNames = squads.map((s) => s.name);

  // 2. Resolve each squad's repos (short names for grouping, slugs for search).
  const reposBySquad = new Map<string, string[]>();
  const slugsBySquad = new Map<string, string[]>();
  for (const { name, squad } of squads) {
    const declared = [squad.repo, ...(squad.also_owns ?? [])]
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
    const shorts: string[] = [];
    const slugs: string[] = [];
    for (const r of declared) {
      const short = repoShort(r);
      if (short && !shorts.includes(short)) shorts.push(short);
      const slug = resolveRepoSlug(r, projectRoot);
      if (slug && !slugs.includes(slug)) slugs.push(slug);
    }
    reposBySquad.set(name, shorts);
    slugsBySquad.set(name, slugs);
  }
  const allSlugs = [...new Set([...slugsBySquad.values()].flat())].sort();

  // 3. sharedWith: other squads on any of the same repos (never a silent double count).
  const sharedBySquad = new Map<string, string[]>();
  for (const { name } of squads) {
    const mine = new Set(reposBySquad.get(name) ?? []);
    const others = squads
      .filter((o) => o.name !== name && (reposBySquad.get(o.name) ?? []).some((r) => mine.has(r)))
      .map((o) => o.name);
    sharedBySquad.set(name, others);
  }

  // 4. Delivery figures — one batched fetch for every squad repo.
  let deliveryByRepo: Record<string, RepoDelivery> | null = null;
  let stale = false;
  let deliveryError = 'GitHub unavailable';
  const run = opts.gh ?? defaultGhRunner;
  let unreachableAll: string[] | null = null;
  try {
    const fetched = fetchDelivery(allSlugs, opts.days, run, now);
    deliveryByRepo = fetched.byRepo;
    unreachableAll = fetched.unreachable;
    if (allSlugs.length > 0) {
      writeCache(projectRoot, { fetchedAt: now.toISOString(), repos: deliveryByRepo });
    }
  } catch (e) {
    deliveryError = (e instanceof Error ? e.message : String(e)).split('\n')[0].trim().slice(0, 200) || 'GitHub unavailable';
    const cached = readCache(projectRoot);
    if (cached) {
      deliveryByRepo = cached.repos;
      stale = true;
    }
  }

  // 5. Live state, read once for the whole project.
  let runs: DetachedRun[] = [];
  let inbox: InboxItem[] = [];
  try { runs = opts.runs ?? listDetachedRuns(projectRoot); } catch { /* no pid files */ }
  try { inbox = opts.inbox ?? buildInbox(projectRoot, projectRoot); } catch { /* no inbox */ }

  const todayStart = startOfDay(nowMs);

  const domains: DomainRow[] = squads.map(({ name, squad }) => {
    const shorts = reposBySquad.get(name) ?? [];
    const slugs = slugsBySquad.get(name) ?? [];

    // goals — the squad's goals.md (what `squads goals` shows); SQUAD.md
    // checkboxes only when there is none.
    const goalsMd = join(projectRoot, '.agents', 'memory', name, 'goals.md');
    let active: number;
    let done: number;
    let overdue: number;
    if (existsSync(goalsMd)) {
      ({ active, done, overdue } = goalCounts(parseGoalsMd(goalsMd), todayStart));
    } else {
      done = squad.goals.filter((g) => g.completed).length;
      active = squad.goals.length - done;
      overdue = squad.goals.filter((g) => {
        if (g.completed) return false;
        const deadline = parseGoalDescription(g.description).deadline;
        return !!deadline && deadline.getTime() < todayStart;
      }).length;
    }

    // delivered
    let delivered: Delivered | null = null;
    let rowError: string | undefined;
    const items: DeliveredItem[] = [];
    const unreachable = unreachableAll ? slugs.filter((s) => unreachableAll!.includes(s)) : [];
    if (slugs.length === 0) {
      rowError = 'no GitHub repo declared';
    } else if (unreachableAll && unreachable.length === slugs.length) {
      rowError = `repo not found or not visible to this token: ${unreachable.join(', ')}`;
    } else if (deliveryByRepo) {
      let prsMerged = 0;
      let issuesClosed = 0;
      let truncated = false;
      for (const slug of slugs) {
        const d = deliveryByRepo[slug];
        if (!d) continue;
        prsMerged += d.prsMerged;
        truncated ||= d.truncated === true;
        issuesClosed += d.issuesClosed;
        items.push(...d.items);
      }
      items.sort((a, b) => Date.parse(b.at || '') - Date.parse(a.at || ''));
      delivered = {
        prsMerged,
        issuesClosed,
        items: items.slice(0, 5),
        ...(stale ? { stale: true } : {}),
        ...(unreachable.length ? { unreachable } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    }

    // now
    const squadRuns = runs.filter((r) => r.squad === name);
    const squadInbox = inbox.filter((i) => inboxItemSquad(i, squadNames) === name);

    // lastActivityAt: newest of delivered items, live runs, waiting inbox items.
    const stamps: number[] = [];
    for (const it of items) {
      const t = Date.parse(it.at || '');
      if (!Number.isNaN(t)) stamps.push(t);
    }
    for (const r of squadRuns) if (Number.isFinite(r.startedAt)) stamps.push(r.startedAt);
    for (const i of squadInbox) stamps.push(nowMs - i.ageDays * DAY_MS);
    const lastActivityAt = stamps.length ? new Date(Math.max(...stamps)).toISOString() : null;

    return {
      domain: name,
      repo: shorts[0] ?? null,
      repos: shorts,
      sharedWith: sharedBySquad.get(name) ?? [],
      goals: { active, done, overdue },
      delivered,
      ...(delivered === null ? { deliveredError: rowError ?? deliveryError } : {}),
      now: {
        running: squadRuns.filter((r) => r.alive).length,
        needsYou: squadInbox.length,
      },
      lastActivityAt,
    };
  });

  domains.sort((a, b) => {
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : -Infinity;
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : -Infinity;
    return tb - ta;
  });

  return {
    v: 1,
    days: opts.days,
    fetchedAt: now.toISOString(),
    stale,
    domains,
  };
}
