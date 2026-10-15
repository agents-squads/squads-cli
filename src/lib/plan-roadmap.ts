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
 * GitHub gives an issue exactly one parent, so a row naming an issue that is
 * already attached to a *different* epic never appears in this plan's
 * sub-issue graph — and used to read as never done even after it closed
 * (issue #1299). Those refs are resolved with one direct issue lookup each and
 * flagged `linked: false` in the JSON, so the missing plan link is visible.
 *
 * This module is filesystem- and network-light by design:
 *   - `gh` access in three phases: the issue body, its sub-issue states, and —
 *     only for the refs the sub-issue graph does not cover — one direct lookup
 *     each, at most `UNLINKED_FETCH_CONCURRENCY` in flight;
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
  /**
   * True when the plan's sub-issue graph covers every ref this row names — or
   * the row names none. False for a row delivering or blocked by an issue that
   * is parented to another epic: its state had to be read directly, and the
   * tracking issue is missing the sub-issue link (issue #1299).
   */
  linked: boolean;
  /**
   * The refs behind `linked: false`, in cell order. A same-repo `#n` blocker
   * that names a row is *not* listed — the table's own grammar makes that a row
   * reference, so no plan link is missing.
   */
  unlinked: string[];
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

/** `## Order`, optionally followed by a qualifier: `## Order (founder 10-14)`. */
const ORDER_HEADING_RE = /^#{1,6}\s+Order\b.*$/i;
const FULL_REF_RE = /([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(\d+)/g;
/** `repo#n` — a repo in the plan's owner, the form plan tables use most. */
const REPO_REF_RE = /(?<![\w/.-])([A-Za-z0-9][\w.-]*)#(\d+)/g;
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
    refs.push(`${owner}#${Number(number)}`);
    return ' ';
  });
  const owner = planRepo.split('/')[0];
  work = work.replace(REPO_REF_RE, (_m, repo: string, number: string) => {
    refs.push(`${owner}/${repo}#${Number(number)}`);
    return ' ';
  });
  work = work.replace(SHORT_REF_RE, (_m, number: string) => {
    refs.push(`${planRepo}#${Number(number)}`);
    return ' ';
  });
  // Separators left behind once refs are lifted out: `a · b`, `a ← b`, `a, b`.
  const text = stripMarkup(work).replace(/^[\s,;:|\-–—/·•←→+&]+|[\s,;:|\-–—/·•←→+&]+$/g, '');
  // Parenthetical annotation next to a ref — `cli#1 (merged)`, `hq#515 (red-team)` —
  // describes the ref; it is not a person blocking the row.
  const annotation = refs.length > 0 && /^\([^()]*\)$/.test(text);
  return { refs: dedupe(refs), text: PLACEHOLDERS.has(text.toLowerCase()) || annotation ? null : text };
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

/** State lookups made one ref at a time, for refs the sub-issue graph misses. */
export interface DirectStates {
  /** `owner/repo#n` (lowercased) → closed? */
  states: IssueStateIndex;
  /** Why a lookup failed, keyed the same way — a row note, never a throw. */
  errors: Map<string, string>;
}

export interface BuildRoadmapArgs {
  plan: PlanRef;
  body: string;
  subIssues: SubIssue[];
  /** States fetched directly for refs the sub-issue graph does not cover (#1299). */
  direct?: DirectStates;
  url?: string;
  fetchedAt: string;
}

/** True for a same-repo `#n` blocker that names a row of this table. */
function rowRefMatcher(plan: PlanRef, rowNumbers: Set<number>): (ref: string) => boolean {
  const planRepo = `${plan.owner}/${plan.repo}`.toLowerCase();
  return (ref: string): boolean => {
    const m = ref.match(/^([^#]+)#(\d+)$/);
    return m !== null && m[1].toLowerCase() === planRepo && rowNumbers.has(Number(m[2]));
  };
}

/**
 * Refs a row names that the plan's **sub-issue graph** does not cover, in cell
 * order: the issues it delivers plus its blocker refs, minus any same-repo `#n`
 * blocker that names a row — that is a row reference by the table's own
 * grammar, not an issue, so no plan link is missing for it.
 */
function uncoveredRefs(row: RawRow, subStates: IssueStateIndex, isRowRef: (ref: string) => boolean): string[] {
  return dedupe([...row.issues, ...row.blockerRefs.filter(ref => !isRowRef(ref))])
    .filter(ref => !subStates.has(ref.toLowerCase()));
}

/**
 * The row's own note, plus one clause per ref whose direct lookup failed: the
 * row keeps the state it would have had, and says why it could not be
 * sharpened (issue #1299).
 */
function annotateNote(note: string, unlinked: string[], direct: DirectStates | undefined): string {
  const clauses = unlinked
    .map(ref => ({ ref, reason: direct?.errors.get(ref.toLowerCase()) }))
    .filter((entry): entry is { ref: string; reason: string } => entry.reason !== undefined)
    .map(({ ref, reason }) => `state of ${ref} unverified — ${reason}`);
  return [note, ...clauses].filter(part => part.length > 0).join(' · ');
}

/**
 * Assemble the roadmap: a row is **done** when it delivers at least one issue
 * and all of them are closed, otherwise **blocked** when any declared blocker
 * is still open (a `#n` in the plan's own repo that is not a known issue is
 * read as a *row* reference — a row that is not done blocks its dependents; a
 * blocker whose state cannot be verified counts as still open), otherwise
 * **ready**. A row with no issue ref is never done.
 *
 * A ref the sub-issue graph does not cover is answered by `direct` instead
 * (issue #1299): GitHub allows an issue one parent, so a row delivering an
 * issue attached to another epic would otherwise never read done. Those refs
 * come out in `unlinked` with `linked: false`; a ref whose lookup failed leaves
 * the row exactly as it would have been, plus a note saying so.
 */
export function buildRoadmap({ plan, body, subIssues, direct, url, fetchedAt }: BuildRoadmapArgs): PlanRoadmap {
  const raw = parseOrderRows(body, plan);
  const subStates = indexSubIssues(subIssues, `${plan.owner}/${plan.repo}`);
  const planRepoLower = `${plan.owner}/${plan.repo}`.toLowerCase();
  // Direct lookups fill what the graph cannot; a ref is never in both, and the
  // sub-issue answer wins if it ever is.
  const states: IssueStateIndex = direct ? new Map([...direct.states, ...subStates]) : subStates;

  const byNumber = new Map<number, number>();
  raw.forEach((row, index) => {
    if (!byNumber.has(row.n)) byNumber.set(row.n, index);
  });
  const isRowRef = rowRefMatcher(plan, new Set(byNumber.keys()));

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
    const unlinked = uncoveredRefs(row, subStates, isRowRef);
    return {
      n: row.n,
      title: row.title,
      issues: row.issues,
      state,
      blockers: blockers[index],
      humanBlocker: row.humanBlocker,
      note: annotateNote(row.note, unlinked, direct),
      linked: unlinked.length === 0,
      unlinked,
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
  // Every page, as one JSON array of pages (gh ≥ 2.48).
  return ['api', `repos/${plan.owner}/${plan.repo}/issues/${plan.number}/sub_issues?per_page=100`, '--paginate', '--slurp'];
}

/** `gh api repos/{o}/{r}/issues/{n}` — the state of one ref, read directly. */
export function refIssueArgs(ref: PlanRef): string[] {
  return ['api', `repos/${ref.owner}/${ref.repo}/issues/${ref.number}`];
}

/** How many direct issue lookups run at once. */
export const UNLINKED_FETCH_CONCURRENCY = 8;

/**
 * The table's refs that the sub-issue index does not cover — the ones that need
 * a direct lookup (issue #1299). Every returned ref is validated with
 * `parsePlanRef` first, so nothing a cell can express reaches a `gh` API path
 * as anything but `owner` / `repo` / `number` in GitHub's slug alphabet.
 */
export function unlinkedRefs(body: string, plan: PlanRef, known: IssueStateIndex): PlanRef[] {
  const rows = parseOrderRows(body, plan);
  const isRowRef = rowRefMatcher(plan, new Set(rows.map(row => row.n)));
  const seen = new Set<string>();
  const refs: PlanRef[] = [];
  for (const row of rows) {
    for (const ref of uncoveredRefs(row, known, isRowRef)) {
      if (seen.has(ref.toLowerCase())) continue;
      seen.add(ref.toLowerCase());
      const parsed = parsePlanRef(ref);
      if (parsed) refs.push(parsed); // unparseable refs stay unknown, never guessed
    }
  }
  return refs;
}

/** `{ "state": "closed" }` → true, `"open"` → false, anything else → unknown. */
function parseIssueState(raw: string): boolean | undefined {
  const payload = JSON.parse(raw) as { state?: unknown };
  const state = typeof payload?.state === 'string' ? payload.state.toLowerCase() : '';
  if (state === 'closed') return true;
  if (state === 'open') return false;
  return undefined;
}

/**
 * Resolve each ref with one `gh api` issue lookup, **never throwing**: a failed
 * or unreadable lookup is recorded in `errors` and left out of `states`, so its
 * row keeps the state it would have had and gains a note instead.
 */
export async function fetchUnlinkedStates(
  refs: PlanRef[],
  runner: GhRunner = defaultGhRunner,
): Promise<DirectStates> {
  const states: IssueStateIndex = new Map();
  const errors = new Map<string, string>();

  for (let at = 0; at < refs.length; at += UNLINKED_FETCH_CONCURRENCY) {
    const batch = refs.slice(at, at + UNLINKED_FETCH_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(ref => runner(refIssueArgs(ref))));
    settled.forEach((result, index) => {
      const key = batch[index].slug.toLowerCase();
      if (result.status === 'rejected') {
        errors.set(key, errorMessage(result.reason));
        return;
      }
      let state: boolean | undefined;
      try {
        state = parseIssueState(result.value);
      } catch {
        state = undefined; // unparseable ≠ closed, and never a throw
      }
      if (state === undefined) errors.set(key, 'unreadable response');
      else states.set(key, state);
    });
  }

  return { states, errors };
}

interface PlanIssuePayload {
  body?: string;
  html_url?: string;
}

/**
 * The tracking issue, its sub-issues, then one direct lookup per ref the
 * sub-issue graph does not cover (usually none). Throws on transport failure,
 * auth failure, or unparseable output from the first two calls — the caller
 * decides whether to fall back to cache. A failed *direct* lookup never throws:
 * it is a row note.
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
  // --slurp: an array of pages; a plain array is accepted too. Anything else is
  // an error, never "no sub-issues" (that would cache every row as not done).
  if (!Array.isArray(parsedSubs)) throw new Error('unexpected sub-issues response from GitHub');
  const subIssues: SubIssue[] = (parsedSubs as unknown[]).flatMap((p) => (Array.isArray(p) ? p : [p])) as SubIssue[];
  const body = typeof issue?.body === 'string' ? issue.body : '';

  // The body is parsed again inside buildRoadmap: that keeps the assembly pure
  // and a second pass over a table this size costs nothing.
  const known = indexSubIssues(subIssues, `${plan.owner}/${plan.repo}`);
  const direct = await fetchUnlinkedStates(unlinkedRefs(body, plan, known), runner);

  return buildRoadmap({
    plan,
    body,
    subIssues,
    direct,
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
