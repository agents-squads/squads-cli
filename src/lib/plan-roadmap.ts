/**
 * `squads plan` — the project roadmap as data (agents-squads/squads-cli#1279).
 *
 * The plan of record is a **tracking issue**: its body carries an `## Order`
 * markdown table (one row per deliverable, in execution order, with the issue
 * refs it delivers and what blocks it), and GitHub's sub-issue graph carries
 * the open/closed state of each row's issues.
 *
 *   .squads/config.yml   plan_issue: owner/repo#n
 *   env override         SQUADS_PLAN_ISSUE=owner/repo#n
 *
 * This module is filesystem- and network-light by design:
 *   - at most TWO `gh` invocations per run (issue body, sub-issue states);
 *   - every invocation goes through `execFile` with an **argument vector** —
 *     never a shell string, so no cell of the tracking issue can reach a shell;
 *   - a 20 s timeout per call;
 *   - on failure the last good result is served from
 *     `.agents/observability/cache/plan.json` with `stale: true` + `error`, so
 *     a live console degrades instead of going blank.
 *
 * Read-only throughout: this module issues no writes to GitHub.
 */

import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { findProjectRoot } from './squad-parser.js';

// ── Contract ─────────────────────────────────────────────────────────

/** JSON contract version. The shape only ever grows (additive). */
export const PLAN_ROADMAP_VERSION = 1;

/** Per-`gh`-call ceiling. Warm runs must stay well under the 3 s budget. */
export const GH_TIMEOUT_MS = 20_000;

/** Where the last successful roadmap is cached, relative to the project root. */
export const PLAN_CACHE_RELPATH = join('.agents', 'observability', 'cache', 'plan.json');

/** `gh <args>` → stdout. Injected in tests; always an argument vector. */
export type GhRunner = (args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile) as (
  file: string,
  args: readonly string[],
  options: { timeout?: number; maxBuffer?: number; encoding?: BufferEncoding; windowsHide?: boolean },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Default runner — `execFile('gh', args)` with a 20 s timeout. `gh` is spawned
 * directly (no shell), so issue content is never interpreted as shell input.
 */
export function defaultGhRunner(args: string[]): Promise<string> {
  return execFileAsync('gh', args, {
    timeout: GH_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  }).then(r => r.stdout);
}

export interface PlanRef {
  owner: string;
  repo: string;
  number: number;
  /** Canonical `owner/repo#n` as it will appear in output. */
  slug: string;
}

export type PlanState = 'done' | 'ready' | 'blocked';

export interface PlanRow {
  /** Row number, from the `#` column of the `## Order` table (ordinal fallback). */
  n: number;
  title: string;
  /** Issue refs this row delivers, normalized to `owner/repo#n`. */
  issues: string[];
  state: PlanState;
  /**
   * Refs that still block this row: declared blockers that are open, or whose
   * state cannot be verified. Satisfied blockers are dropped — the field names
   * what is blocking NOW, not what once blocked.
   */
  blockers: string[];
  /** A "Blocked by" cell that names a human (no ref), verbatim. */
  humanBlocker: string | null;
  note: string;
}

export interface PlanCounts {
  done: number;
  ready: number;
  blocked: number;
  total: number;
}

export interface PlanRoadmap {
  v: typeof PLAN_ROADMAP_VERSION;
  configured: true;
  /** `owner/repo#n` of the plan of record. */
  plan: string;
  url: string;
  /** ISO timestamp of the successful fetch this data came from. */
  fetchedAt: string;
  counts: PlanCounts;
  /** Row number of the first ready row in Order; null when nothing is ready. */
  next: number | null;
  rows: PlanRow[];
  /** True when this came from cache because the live fetch failed. */
  stale?: boolean;
  /** Why the live fetch failed (only with `stale`, or on a hard failure). */
  error?: string;
}

/** `{ configured: false }` — the plan of record is unset (or unusable). */
export interface UnconfiguredPlan {
  v: typeof PLAN_ROADMAP_VERSION;
  configured: false;
  hint: string;
  error?: string;
}

export type PlanOutput = PlanRoadmap | UnconfiguredPlan;

export const PLAN_HINT =
  'Set plan_issue: owner/repo#n in .squads/config.yml (or SQUADS_PLAN_ISSUE) to point squads at your plan of record';

// ── Plan reference ───────────────────────────────────────────────────

const PLAN_REF_RE = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*)#(\d+)$/;
const PLAN_URL_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/issues\/(\d+)\/?$/i;

/**
 * Parse `owner/repo#n` (or a full issue URL) into its parts.
 * Returns null for anything else — a malformed ref is a config error, not a plan.
 * The parts are interpolated into a `gh api` path, so they are kept strictly to
 * GitHub's slug alphabet (no query string, no path traversal).
 */
export function parsePlanRef(raw: string | null | undefined): PlanRef | null {
  if (!raw) return null;
  let value = raw.trim();
  const asUrl = value.match(PLAN_URL_RE);
  if (asUrl) value = `${asUrl[1]}/${asUrl[2]}#${asUrl[3]}`;
  const m = value.match(PLAN_REF_RE);
  if (!m) return null;
  const [, owner, repo, digits] = m;
  if ([owner, repo].some(part => part.includes('..'))) return null;
  const number = Number(digits);
  if (!Number.isFinite(number) || number <= 0) return null;
  return { owner, repo, number, slug: `${owner}/${repo}#${number}` };
}

/**
 * The configured plan of record: `SQUADS_PLAN_ISSUE` overrides
 * `.squads/config.yml`'s `plan_issue`. Returns the raw string (validate with
 * `parsePlanRef`) or null when neither is set.
 */
export function resolvePlanRef(
  envValue: string | undefined | null,
  configValue: string | null | undefined,
): string | null {
  const fromEnv = envValue?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = configValue?.trim();
  if (fromConfig) return fromConfig;
  return null;
}

// ── Markdown parsing ─────────────────────────────────────────────────

interface RawRow {
  n: number;
  title: string;
  issues: string[];
  blockerRefs: string[];
  humanBlocker: string | null;
  note: string;
}

const ORDER_HEADING_RE = /^#{1,6}\s+Order\s*$/i;
const FULL_REF_RE = /([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(\d+)/g;
const SHORT_REF_RE = /(?<![\w/])#(\d+)/g;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const GH_ISSUE_URL_RE = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/i;

/** Cells that mean "nothing here" — never a human blocker. */
const PLACEHOLDERS = new Set(['', '-', '--', '---', '—', '–', 'none', 'n/a', 'na', 'no', 'null', 'nil', 'nothing', 'tbd']);

/** Strip markdown emphasis/backticks so cells compare and render cleanly. */
function stripMarkup(text: string): string {
  return text
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split a markdown table line into trimmed cells. Escaped pipes (`\|`) are
 * left inside their cell.
 */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map(c => c.trim());
}

/** The raw lines of the first markdown table following a `## Order` heading. */
export function findOrderTable(body: string): string[] | null {
  const lines = body.split('\n');
  const start = lines.findIndex(l => ORDER_HEADING_RE.test(l.trim()));
  if (start === -1) return null;

  const table: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('|')) {
      table.push(line);
      continue;
    }
    if (table.length === 0) continue; // prose between the heading and the table
    break; // table ended
  }
  return table.length > 0 ? table : null;
}

/** True for the `|---|---|` separator row of a markdown table. */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every(c => /^:?-{2,}:?$/.test(c.trim()));
}

type Column = 'n' | 'title' | 'issues' | 'blocked' | 'note';

/** Map a table header cell to the column it carries (null = unknown column). */
function classifyHeader(header: string): Column | null {
  const h = stripMarkup(header).toLowerCase();
  if (/^(#|n|no|num|number|order|row|step)$/.test(h)) return 'n';
  if (/block/.test(h)) return 'blocked';
  if (/issue|ref|link/.test(h)) return 'issues';
  if (/note|remark|comment/.test(h)) return 'note';
  if (/title|deliverable|item|task|work|label|what/.test(h)) return 'title';
  return null;
}

/**
 * Rewrite markdown links to the ref they point at (`[#100](…/issues/100)` →
 * `agents-squads/squads-cli#100`) so a ref carried only in a link URL is not
 * lost; links to anything else keep their visible text.
 */
function expandLinks(cell: string): string {
  return cell.replace(MD_LINK_RE, (whole, text: string, url: string) => {
    const ref = url.match(GH_ISSUE_URL_RE);
    if (ref) return `${ref[1]}/${ref[2]}#${ref[3]}`;
    return text || whole;
  });
}

/**
 * Pull issue refs out of a cell, returning what is left as free text.
 * Short refs (`#123`) resolve against the plan's own repo.
 */
function extractRefs(cell: string, planRepo: string): { refs: string[]; text: string | null } {
  let work = expandLinks(cell);
  const refs: string[] = [];
  work = work.replace(FULL_REF_RE, (_m, owner: string, number: string) => {
    refs.push(`${owner}#${number}`);
    return ' ';
  });
  work = work.replace(SHORT_REF_RE, (_m, number: string) => {
    refs.push(`${planRepo}#${Number(number)}`);
    return ' ';
  });
  const text = stripMarkup(work).replace(/^[\s,;:|\-–—/]+|[\s,;:|\-–—/]+$/g, '');
  return { refs: dedupe(refs), text: PLACEHOLDERS.has(text.toLowerCase()) ? null : text };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Parse the `## Order` table into raw rows. A body with no table (or no
 * `## Order` heading) yields `[]` — never a throw.
 */
export function parseOrderRows(body: string, plan: PlanRef): RawRow[] {
  const table = findOrderTable(body);
  if (!table) return [];

  const planRepo = `${plan.owner}/${plan.repo}`;
  const firstCells = splitRow(table[0]);
  if (firstCells.length === 0) return [];

  // A header row is one followed by a `|---|` separator, or one whose cells
  // name our columns. Anything else is data, ordered as documented:
  // #, title, issues, blocked by, note.
  let columns: (Column | null)[];
  let bodyRows: string[];
  const firstIsHeader = table.length > 1 && isSeparatorRow(splitRow(table[1]));
  if (firstIsHeader || firstCells.some(c => classifyHeader(c) !== null)) {
    columns = firstCells.map(classifyHeader);
    bodyRows = table.slice(firstIsHeader ? 2 : 1);
  } else {
    columns = ['n', 'title', 'issues', 'blocked', 'note'];
    bodyRows = table;
  }
  bodyRows = bodyRows.filter(row => !isSeparatorRow(splitRow(row)));
  if (bodyRows.length === 0) return [];
  if (columns.every(c => c === null)) columns = ['n', 'title', 'issues', 'blocked', 'note'];

  const rows: RawRow[] = [];
  bodyRows.forEach((line, index) => {
    const cells = splitRow(line);
    const pick = (col: Column): string => {
      const at = columns.indexOf(col);
      return at >= 0 && at < cells.length ? cells[at] : '';
    };

    const issues = extractRefs(pick('issues'), planRepo);
    const blockers = extractRefs(pick('blocked'), planRepo);
    const rawNumber = stripMarkup(pick('n')).match(/\d+/);
    const n = rawNumber ? Number(rawNumber[0]) : index + 1;

    rows.push({
      n,
      title: stripMarkup(expandLinks(pick('title'))) || `Row ${n}`,
      issues: issues.refs,
      blockerRefs: blockers.refs,
      humanBlocker: blockers.text,
      note: stripMarkup(pick('note')),
    });
  });

  return rows;
}

// ── Sub-issues ───────────────────────────────────────────────────────

/** The subset of GitHub's issue payload this command reads. */
export interface SubIssue {
  number?: number;
  title?: string;
  state?: string;
  /** `https://api.github.com/repos/{owner}/{repo}` — set by the API. */
  repository_url?: string;
}

/** `owner/repo#n` (lowercased) → closed? */
export type IssueStateIndex = Map<string, boolean>;

function repoFromApiUrl(url: string | undefined): string | null {
  const m = url?.match(/\/repos\/([^/\s]+)\/([^/\s]+)$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Index sub-issue states by `owner/repo#n`; cross-repo sub-issues land under their own repo. */
export function indexSubIssues(subIssues: SubIssue[], planRepo: string): IssueStateIndex {
  const index: IssueStateIndex = new Map();
  for (const issue of subIssues) {
    if (typeof issue?.number !== 'number') continue;
    const repo = repoFromApiUrl(issue.repository_url) ?? planRepo;
    index.set(`${repo}#${issue.number}`.toLowerCase(), issue.state?.toLowerCase() === 'closed');
  }
  return index;
}

// ── Roadmap assembly ─────────────────────────────────────────────────

export interface BuildRoadmapArgs {
  plan: PlanRef;
  body: string;
  subIssues: SubIssue[];
  url?: string;
  fetchedAt: string;
}

/**
 * Assemble the roadmap: a row is **done** when it delivers at least one issue
 * and all of them are closed, otherwise **blocked** when any declared blocker
 * is still open (a `#n` in the plan's own repo that is not a known issue is
 * read as a *row* reference — a row that is not done blocks its dependents; a
 * blocker whose state cannot be verified counts as still open), otherwise
 * **ready**. A row with no issue ref is never done.
 */
export function buildRoadmap({ plan, body, subIssues, url, fetchedAt }: BuildRoadmapArgs): PlanRoadmap {
  const raw = parseOrderRows(body, plan);
  const states = indexSubIssues(subIssues, `${plan.owner}/${plan.repo}`);
  const planRepoLower = `${plan.owner}/${plan.repo}`.toLowerCase();

  const byNumber = new Map<number, number>();
  raw.forEach((row, index) => {
    if (!byNumber.has(row.n)) byNumber.set(row.n, index);
  });

  // A row is done on its own issues alone — checked first so a finished row is
  // never reported as blocked by something it already absorbed.
  const isDone = raw.map(row =>
    row.issues.length > 0 && row.issues.every(ref => states.get(ref.toLowerCase()) === true),
  );

  const blockers = raw.map((row, index) => {
    const blocking: string[] = [];
    for (const ref of row.blockerRefs) {
      const state = states.get(ref.toLowerCase());
      if (state === true) continue;      // satisfied — no longer in the way
      if (state === false) {             // open issue
        blocking.push(ref);
        continue;
      }
      // Unknown state: a same-repo `#n` that is not a known issue names a ROW.
      const rowRef = ref.match(/^([^#]+)#(\d+)$/);
      const rowIndex =
        rowRef && rowRef[1].toLowerCase() === planRepoLower ? byNumber.get(Number(rowRef[2])) : undefined;
      if (rowIndex !== undefined && rowIndex !== index) {
        if (!isDone[rowIndex]) blocking.push(ref);
        continue;
      }
      blocking.push(ref); // unverifiable ⇒ assume still blocking
    }
    return blocking;
  });

  const rows: PlanRow[] = raw.map((row, index) => {
    const state: PlanState = isDone[index]
      ? 'done'
      : blockers[index].length > 0 || row.humanBlocker !== null
        ? 'blocked'
        : 'ready';
    return {
      n: row.n,
      title: row.title,
      issues: row.issues,
      state,
      blockers: blockers[index],
      humanBlocker: row.humanBlocker,
      note: row.note,
    };
  });

  const firstReady = rows.find(row => row.state === 'ready');

  return {
    v: PLAN_ROADMAP_VERSION,
    configured: true,
    plan: plan.slug,
    url: url || `https://github.com/${plan.owner}/${plan.repo}/issues/${plan.number}`,
    fetchedAt,
    counts: {
      done: rows.filter(r => r.state === 'done').length,
      ready: rows.filter(r => r.state === 'ready').length,
      blocked: rows.filter(r => r.state === 'blocked').length,
      total: rows.length,
    },
    next: firstReady ? firstReady.n : null,
    rows,
  };
}

// ── Fetch ────────────────────────────────────────────────────────────

/** `gh api repos/{o}/{r}/issues/{n}` — the issue body and URL. */
export function planIssueArgs(plan: PlanRef): string[] {
  return ['api', `repos/${plan.owner}/${plan.repo}/issues/${plan.number}`];
}

/** `gh api repos/{o}/{r}/issues/{n}/sub_issues` — open/closed per sub-issue. */
export function subIssuesArgs(plan: PlanRef): string[] {
  // per_page=100 keeps this a single request for any realistic plan.
  return ['api', `repos/${plan.owner}/${plan.repo}/issues/${plan.number}/sub_issues?per_page=100`];
}

interface PlanIssuePayload {
  body?: string;
  html_url?: string;
}

/**
 * Two `gh` calls: the tracking issue, then its sub-issues. Throws on
 * transport failure, auth failure, or unparseable output — the caller decides
 * whether to fall back to cache.
 */
export async function fetchPlanRoadmap(
  plan: PlanRef,
  runner: GhRunner = defaultGhRunner,
  now: () => Date = () => new Date(),
): Promise<PlanRoadmap> {
  const issueRaw = await runner(planIssueArgs(plan));
  const subRaw = await runner(subIssuesArgs(plan));

  const issue = JSON.parse(issueRaw) as PlanIssuePayload;
  const parsedSubs: unknown = JSON.parse(subRaw);
  const subIssues: SubIssue[] = Array.isArray(parsedSubs) ? (parsedSubs as SubIssue[]) : [];

  return buildRoadmap({
    plan,
    body: typeof issue?.body === 'string' ? issue.body : '',
    subIssues,
    url: typeof issue?.html_url === 'string' ? issue.html_url : undefined,
    fetchedAt: now().toISOString(),
  });
}

// ── Cache ────────────────────────────────────────────────────────────

/** `.agents/observability/cache/plan.json` under `root` (project root by default). */
export function planCachePath(root: string | null = findProjectRoot()): string | null {
  if (!root) return null;
  return join(root, PLAN_CACHE_RELPATH);
}

/** The last successful roadmap, or null when absent/corrupt. */
export function readPlanCache(path: string | null): PlanRoadmap | null {
  if (!path) return null;
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PlanRoadmap;
    if (!parsed || parsed.configured !== true || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Cache a roadmap. Best-effort: a cache write never fails a live read. */
export function writePlanCache(path: string | null, roadmap: PlanRoadmap): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(roadmap, null, 2)}\n`);
  } catch {
    /* unwritable cache — the live result still stands */
  }
}

export interface LoadPlanResult {
  roadmap: PlanRoadmap;
  stale: boolean;
}

export interface LoadPlanOptions {
  plan: PlanRef;
  runner?: GhRunner;
  /** Cache path; defaults to the project's plan.json. Pass null to disable. */
  cachePath?: string | null;
  now?: () => Date;
}

/**
 * Fetch live, caching the result. When the fetch fails, serve the last good
 * roadmap *for this same plan* with `stale: true` + `error`; when there is no
 * usable cache the error is rethrown for the caller to report.
 */
export async function loadPlanRoadmap(opts: LoadPlanOptions): Promise<LoadPlanResult> {
  const cachePath = opts.cachePath === undefined ? planCachePath() : opts.cachePath;
  try {
    const roadmap = await fetchPlanRoadmap(opts.plan, opts.runner, opts.now);
    writePlanCache(cachePath, roadmap);
    return { roadmap, stale: false };
  } catch (err) {
    const cached = readPlanCache(cachePath);
    if (cached && cached.plan === opts.plan.slug) {
      return { roadmap: { ...cached, stale: true, error: errorMessage(err) }, stale: true };
    }
    throw err;
  }
}

/**
 * A one-line reason a fetch failed. execFile folds the command and its stderr
 * into `message`, so prefer the stderr line — that is the part a human needs.
 */
export function errorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err).replace(/\s+/g, ' ').trim();
  const stderr = (err as Error & { stderr?: string }).stderr;
  const firstStderr = stderr?.split('\n').map(line => line.trim()).find(line => line.length > 0);
  if (firstStderr && /^Command failed/.test(err.message)) return firstStderr;
  const raw = err.message.replace(/\s+/g, ' ').trim();
  return firstStderr && !raw.includes(firstStderr) ? `${raw} — ${firstStderr}` : raw;
}

/** A zero-row roadmap, used to keep the `--json` shape stable on a hard failure. */
export function emptyRoadmap(plan: PlanRef, fetchedAt: string): PlanRoadmap {
  return {
    v: PLAN_ROADMAP_VERSION,
    configured: true,
    plan: plan.slug,
    url: `https://github.com/${plan.owner}/${plan.repo}/issues/${plan.number}`,
    fetchedAt,
    counts: { done: 0, ready: 0, blocked: 0, total: 0 },
    next: null,
    rows: [],
  };
}
