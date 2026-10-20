/**
 * Org audit engine (#1327).
 *
 * Walks an org root (see org-root.ts) and classifies every unit — git repo or
 * not — against the "company as code" contract: in git with a remote,
 * self-describing (AGENTS.md frontmatter), measured (a declared ## Metric),
 * delivery basics for products, activity matching lifecycle, docs facts that
 * match derivable truth, and no retired names.
 *
 * Read-only by default: the audit never writes to the org root. Metric commands
 * declared in AGENTS.md `## Metric` blocks are executed only with `runMetrics`
 * (opt-in) — that executes code from the audited repos, so it is NOT read-only:
 * commands run with a scrubbed environment and never for parked/archived units.
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { basename, dirname, join, relative } from 'path';
import { spawnSync } from 'child_process';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { listOrgUnits } from './org-root.js';
import { hardenedGitArgs } from './harvest-guard.js';

export const VALID_KINDS = ['product', 'domain', 'client', 'prospect', 'lab'] as const;
/** Kinds the org retired, mapped to their replacement. */
export const RETIRED_KINDS: Record<string, string> = { internal: 'lab' };
export const VALID_LIFECYCLES = ['active', 'parked', 'archived'] as const;

/** `declared`: a command is declared but was not run (metric commands run only with runMetrics). */
export type MetricStatus = 'undeclared' | 'declared' | 'no-data' | 'stale' | 'flat' | 'ok';

export interface Finding {
  /** Check group: git | self-description | metric | delivery | activity | docs-facts | names */
  check: string;
  /** Machine-readable class: not-in-git | no-remote | unclassified | stale-doc-fact | ... */
  code: string;
  message: string;
}

export interface UnitAudit {
  name: string;
  inGit: boolean;
  hasRemote: boolean;
  remoteUrl: string | null;
  kind: string | null;
  lifecycle: string | null;
  unclassified: boolean;
  metric: MetricStatus;
  /** The declared `## Metric` command (shown to the operator before --run-metrics executes it). */
  metricCommand: string | null;
  lastCommitAt: string | null;
  findings: Finding[];
  hints: string[];
  /** Archived units, and parked units with a reason + revisit date, are listed but never count as gaps. */
  countsAsGap: boolean;
}

export interface Proposal {
  /** Unit (repo) the drafted issue belongs in. */
  repo: string;
  /** Remote URL of the unit's repo when known. */
  remoteUrl: string | null;
  title: string;
  body: string;
}

export interface OrgAuditReport {
  /** Date the report was generated (YYYY-MM-DD). */
  date: string;
  orgRoot: string;
  summary: { units: number; gaps: number; parkedOrArchived: number };
  units: UnitAudit[];
  /** Gaps that belong to the org root itself (e.g. org-level docs drift). */
  orgFindings: Finding[];
  /** Present only when requested with --propose. Drafts only, never filed. */
  proposals?: Proposal[];
}

export interface AuditOptions {
  /** Days after which a metric's newest data point counts as stale. Default 14. */
  staleDays?: number;
  /** Days after which an active unit with no commits counts as idle. Default 30. */
  idleDays?: number;
  /** Clock override for tests. */
  now?: Date;
  /** Build one draft issue per gap. */
  propose?: boolean;
  /** Control repo directory name (for locating the org's names table). */
  controlRepo?: string;
  /**
   * Execute each unit's declared `## Metric` command. Off by default: an org
   * root can hold repos the operator doesn't control, and running their
   * commands would run their code. Skipped for parked/archived units; the
   * commands get a scrubbed environment (no tokens/credentials).
   */
  runMetrics?: boolean;
}

const METRIC_TIMEOUT_MS = 10_000;
const GIT_TIMEOUT_MS = 5_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

interface GitResult {
  ok: boolean;
  stdout: string;
  /** Why it failed: spawn error/timeout message or git's stderr. */
  error: string;
}

function runGit(dir: string, args: string[], hardened: string[]): GitResult {
  // Same hardening as harvest: a unit's own git config must not get hooks,
  // fsmonitor or filter drivers executed by an audit. `hardened` is computed
  // once per unit (it reads the unit's config).
  const r = spawnSync('git', [...hardened, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) return { ok: false, stdout: '', error: r.error.message };
  if (r.status !== 0) return { ok: false, stdout: '', error: (r.stderr ?? '').trim() || `git exited ${r.status}` };
  return { ok: true, stdout: (r.stdout ?? '').trim(), error: '' };
}

function safeReaddir(dir: string): string[] | null {
  try {
    return readdirSync(dir);
  } catch {
    return null;
  }
}

/** Drop credentials (`user:token@`) from a remote URL: reports get saved and shared. */
function redactRemote(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
}

/** A unit counts as its own git repo when it carries a .git entry (dir or worktree file). */
function isOwnGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

interface UnitFrontmatter {
  kind?: string;
  lifecycle?: string;
  version?: string;
  parked_reason?: string;
  reason?: string;
  revisit?: string;
  revisit_date?: string;
  parked_revisit?: string;
}

interface AgentsMd {
  data: UnitFrontmatter;
  body: string;
  /** Parse/read failure: the file exists but could not be understood. */
  error?: string;
}

function readAgentsMd(dir: string): AgentsMd | null {
  const p = join(dir, 'AGENTS.md');
  if (!existsSync(p)) return null;
  try {
    const parsed = matter(readFileSync(p, 'utf8'));
    return { data: (parsed.data ?? {}) as UnitFrontmatter, body: parsed.content ?? '' };
  } catch (e) {
    return { data: {}, body: '', error: e instanceof Error ? e.message : String(e) };
  }
}

/** Extract the text of a `## <title>` section up to the next heading of same-or-higher level. */
function extractSection(markdown: string, title: string): string | null {
  const re = new RegExp(`^##\\s+${title}\\s*$`, 'im');
  const m = re.exec(markdown);
  if (!m) return null;
  const rest = markdown.slice(m.index + m[0].length);
  const end = rest.search(/^##\s/m);
  return end === -1 ? rest : rest.slice(0, end);
}

/** The command declared in a fenced code block inside a markdown section: the whole block, comment lines dropped. */
function extractCommand(section: string): string | null {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(section);
  if (!m) return null;
  const command = m[1]
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .trim();
  return command || null;
}

/** Environment a metric command gets: enough to run tools, none of the operator's credentials. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'LANG', 'TZ'];
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (keep.includes(k) || k.startsWith('LC_')) env[k] = v;
  }
  return env;
}

interface MetricPoint {
  date: Date | null;
  value: number;
}

function parseMetricOutput(stdout: string): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const dated = /^(\d{4}-\d{2}-\d{2})(?:[T ]\S+)?\s+(-?\d+(?:\.\d+)?)$/.exec(trimmed);
    if (dated) {
      points.push({ date: new Date(`${dated[1]}T00:00:00Z`), value: Number(dated[2]) });
      continue;
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      points.push({ date: null, value: Number(trimmed) });
    }
  }
  return points;
}

function declaredMetricCommand(body: string): string | null {
  const section = extractSection(body, 'Metric');
  return section ? extractCommand(section) : null;
}

function runMetric(dir: string, command: string | null, staleDays: number, now: Date, execute: boolean): MetricStatus {
  if (!command) return 'undeclared';
  if (!execute) return 'declared';

  const r = spawnSync(command, {
    cwd: dir,
    shell: true,
    encoding: 'utf8',
    timeout: METRIC_TIMEOUT_MS,
    env: scrubbedEnv(),
  });
  if (r.error || r.status !== 0) return 'no-data';

  const points = parseMetricOutput(r.stdout ?? '');
  if (points.length === 0) return 'no-data';

  const dated = points.filter((p) => p.date !== null);
  if (dated.length > 0) {
    const newest = Math.max(...dated.map((p) => p.date!.getTime()));
    if (now.getTime() - newest > staleDays * MS_PER_DAY) return 'stale';
  }
  if (points.length >= 2 && points.every((p) => p.value === points[0].value)) return 'flat';
  return 'ok';
}

function hasCi(dir: string): boolean {
  if (existsSync(join(dir, '.gitlab-ci.yml'))) return true;
  if (existsSync(join(dir, '.circleci', 'config.yml'))) return true;
  if (existsSync(join(dir, 'Jenkinsfile'))) return true;
  const wf = join(dir, '.github', 'workflows');
  return isDir(wf) && (safeReaddir(wf) ?? []).some((f) => /\.ya?ml$/.test(f));
}

function hasContract(dir: string, body: string): boolean {
  for (const candidate of ['openapi', 'schemas', 'schema', 'proto']) {
    if (isDir(join(dir, candidate)) && (safeReaddir(join(dir, candidate)) ?? []).length > 0) return true;
  }
  for (const file of ['openapi.json', 'openapi.yaml', 'openapi.yml', 'asyncapi.json', 'asyncapi.yaml']) {
    if (existsSync(join(dir, file))) return true;
  }
  return extractSection(body, 'Contract') !== null;
}

function packageVersion(dir: string): { version: string | null; error?: string } {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return { version: null };
  try {
    const v = (JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }).version;
    return { version: typeof v === 'string' ? v : null };
  } catch (e) {
    return { version: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Version the docs claim: the frontmatter `version:` only. Prose mentions
 * ("added in v0.9.0") are history, not claims about the current version.
 */
function documentedVersion(fm: UnitFrontmatter): string | null {
  const v = typeof fm.version === 'string' ? fm.version : String(fm.version ?? '');
  return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
}

/** Retired terms declared by the org: names.{yml,yaml,json} in the control repo or org root. */
function loadRetiredNames(orgRoot: string, controlRepo: string): { terms: string[]; findings: Finding[] } {
  const findings: Finding[] = [];
  for (const base of [join(orgRoot, controlRepo), orgRoot]) {
    for (const file of ['names.yml', 'names.yaml', 'names.json']) {
      const p = join(base, file);
      if (!existsSync(p)) continue;
      try {
        const raw = readFileSync(p, 'utf8');
        const parsed: unknown = file.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw);
        const list = Array.isArray(parsed)
          ? parsed
          : (parsed as { retired?: unknown })?.retired;
        if (Array.isArray(list)) return { terms: list.filter((t): t is string => typeof t === 'string'), findings };
      } catch (e) {
        findings.push({ check: 'names', code: 'invalid-names-table', message: `${file} could not be parsed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}) — retired names were not checked` });
      }
    }
  }
  return { terms: [], findings };
}

function retiredTermsIn(dir: string, retired: string[]): string[] {
  if (retired.length === 0) return [];
  const docs = ['AGENTS.md', 'README.md']
    .filter((f) => existsSync(join(dir, f)))
    .map((f) => {
      try {
        return readFileSync(join(dir, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  if (!docs) return [];
  return retired.filter((term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(docs));
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / MS_PER_DAY);
}

// --- duplicate docs ---------------------------------------------------------

const DOC_SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', 'site-packages', 'vendor', 'dist', 'build', '.git']);
/** Licenses, changelogs and conduct files are boilerplate, not product docs to reconcile. */
const DOC_SKIP_FILE_RE = /^(LICENSE|CHANGELOG|CODE_OF_CONDUCT)/i;
const DOC_MAX_BYTES = 1024 * 1024;
const DOC_SHINGLE_WORDS = 5;
const DOC_DUPLICATE_SIMILARITY = 0.6;
/** Below this, two dated files are a series (periodic reports), not copies of one document. */
const DOC_DATED_COPY_SIMILARITY = 0.3;
/** 3+ files with the same basename in sibling directories (NN/prompt.md) are data, not docs. */
const DOC_TEMPLATE_FAMILY_MIN = 3;
const DOC_FINDINGS_CAP = 10;
/** Hard bound on pairs considered per unit: the audit must never go quadratic unannounced. */
const DOC_MAX_PAIRWISE_COMPARISONS = 5000;
const DATE_STAMP_RE = /\d{4}[-_]\d{2}[-_]\d{2}/;

interface MarkdownDoc {
  /** Path relative to the unit directory. */
  path: string;
  text: string;
}

function isSkippedDocFile(name: string): boolean {
  return !/\.md$/i.test(name) || DOC_SKIP_FILE_RE.test(name);
}

/** A tracked path inside node_modules/vendor/venv/... is generated, not the unit's own docs. */
function isInSkippedDir(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((part) => DOC_SKIP_DIRS.has(part));
}

/** Tracked markdown only: an untracked scratch copy is not part of the unit's docs. */
function collectTrackedMarkdownDocs(dir: string, hardened: string[]): MarkdownDoc[] {
  const listed = runGit(dir, ['ls-files', '-z', '--', '*.md'], hardened);
  if (!listed.ok) return [];
  const docs: MarkdownDoc[] = [];
  for (const relPath of listed.stdout.split('\0')) {
    if (!relPath) continue;
    if (isSkippedDocFile(basename(relPath))) continue;
    // Tracked vendored/generated trees are boilerplate too: skip by path component.
    if (isInSkippedDir(relPath)) continue;
    const p = join(dir, relPath);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    // lstat: never follow symlinks out of the unit (or into a cycle).
    if (!st.isFile() || st.size > DOC_MAX_BYTES) continue;
    try {
      docs.push({ path: relPath, text: readFileSync(p, 'utf8') });
    } catch {
      // An unreadable doc cannot be compared; the rest of the audit still runs.
    }
  }
  return docs;
}

/** Outside git, walk the unit but never descend into generated/vendored trees. */
function collectWalkedMarkdownDocs(dir: string): MarkdownDoc[] {
  const docs: MarkdownDoc[] = [];
  const walk = (current: string): void => {
    const entries = safeReaddir(current);
    if (!entries) return;
    for (const entry of entries) {
      const p = join(current, entry);
      let st;
      try {
        // lstat: never follow symlinks out of the unit (or into a cycle).
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!DOC_SKIP_DIRS.has(entry)) walk(p);
        continue;
      }
      if (!st.isFile() || isSkippedDocFile(entry) || st.size > DOC_MAX_BYTES) continue;
      try {
        docs.push({ path: relative(dir, p), text: readFileSync(p, 'utf8') });
      } catch {
        // An unreadable doc cannot be compared; the rest of the audit still runs.
      }
    }
  };
  walk(dir);
  return docs;
}

/** `hardened` is null outside git; inside git only tracked files are considered. */
function collectMarkdownDocs(dir: string, hardened: string[] | null): MarkdownDoc[] {
  return hardened ? collectTrackedMarkdownDocs(dir, hardened) : collectWalkedMarkdownDocs(dir);
}

/**
 * Paths belonging to a templated family: the same basename in 3+ sibling
 * directories (e.g. tasks/tier1/01/prompt.md … 05/prompt.md). Those files are
 * generated data, so they must not be reported as duplicate prose.
 */
function templatedFamilyPaths(docs: MarkdownDoc[]): Set<string> {
  const families = new Map<string, Map<string, MarkdownDoc[]>>();
  for (const doc of docs) {
    const name = basename(doc.path);
    const parent = dirname(doc.path);
    const grandparent = dirname(parent);
    let byGrandparent = families.get(name);
    if (!byGrandparent) {
      byGrandparent = new Map();
      families.set(name, byGrandparent);
    }
    const siblings = byGrandparent.get(grandparent) ?? [];
    siblings.push(doc);
    byGrandparent.set(grandparent, siblings);
  }
  const templated = new Set<string>();
  for (const byGrandparent of families.values()) {
    for (const siblings of byGrandparent.values()) {
      if (siblings.length < DOC_TEMPLATE_FAMILY_MIN) continue;
      for (const doc of siblings) templated.add(doc.path);
    }
  }
  return templated;
}

/** Lowercase, collapse whitespace, keep heading text: the rule's normalization. */
function normalizeDocText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Jaccard similarity over 5-word shingles of the normalized text. */
function docShingles(text: string): Set<string> {
  const words = normalizeDocText(text).split(' ').filter(Boolean);
  if (words.length === 0) return new Set();
  if (words.length <= DOC_SHINGLE_WORDS) return new Set([words.join(' ')]);
  const set = new Set<string>();
  for (let i = 0; i + DOC_SHINGLE_WORDS <= words.length; i++) {
    set.add(words.slice(i, i + DOC_SHINGLE_WORDS).join(' '));
  }
  return set;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const s of a) if (b.has(s)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Jaccard can never exceed min(|A|,|B|)/max(|A|,|B|) (the intersection is at
 * most the smaller set and the union at least the larger one), so pairs whose
 * shingle-set sizes are too different cannot reach `floor` and need no compare.
 */
function canReachSimilarity(a: Set<string>, b: Set<string>, floor: number): boolean {
  const small = Math.min(a.size, b.size);
  const large = Math.max(a.size, b.size);
  if (large === 0) return false;
  return small / large >= floor;
}

interface PairwiseBudget {
  remaining: number;
  exhausted: boolean;
}

/** Counts every pair the analysis considers; returns false once the per-unit bound is hit. */
function takeComparison(budget: PairwiseBudget): boolean {
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return false;
  }
  budget.remaining--;
  return true;
}

/** True when two files sit in the same directory and differ only by a YYYY-MM-DD (or YYYY_MM_DD) stamp. */
function isDatedCopy(a: string, b: string): boolean {
  if (dirname(a) !== dirname(b)) return false;
  const na = basename(a);
  const nb = basename(b);
  if (!DATE_STAMP_RE.test(na) && !DATE_STAMP_RE.test(nb)) return false;
  return na.replace(DATE_STAMP_RE, '<date>') === nb.replace(DATE_STAMP_RE, '<date>');
}

/** Family key for a dated file: same directory + basename with the date stamp stripped. */
function datedFamilyKey(path: string): string | null {
  const name = basename(path);
  if (!DATE_STAMP_RE.test(name)) return null;
  return join(dirname(path), name.replace(DATE_STAMP_RE, '<date>'));
}

interface ShingledDoc {
  path: string;
  shingles: Set<string>;
}

/**
 * One finding per dated family (same name with the date stripped, same directory).
 * A family whose members are textually disjoint is a time series (periodic
 * reports), not copies of one document: only members that overlap at or above
 * DOC_DATED_COPY_SIMILARITY are reported.
 */
function datedCopyFindings(docs: ShingledDoc[], budget: PairwiseBudget): Finding[] {
  const families = new Map<string, ShingledDoc[]>();
  for (const doc of docs) {
    const key = datedFamilyKey(doc.path);
    if (!key) continue;
    const family = families.get(key) ?? [];
    family.push(doc);
    families.set(key, family);
  }
  const findings: Finding[] = [];
  for (const [key, family] of families) {
    if (family.length < 2) continue;
    const overlapping = new Set<string>();
    let maxSimilarity = 0;
    for (let i = 0; i < family.length; i++) {
      for (let j = i + 1; j < family.length; j++) {
        if (!takeComparison(budget)) break;
        if (!canReachSimilarity(family[i].shingles, family[j].shingles, DOC_DATED_COPY_SIMILARITY)) continue;
        const similarity = jaccard(family[i].shingles, family[j].shingles);
        if (similarity < DOC_DATED_COPY_SIMILARITY) continue;
        overlapping.add(family[i].path);
        overlapping.add(family[j].path);
        maxSimilarity = Math.max(maxSimilarity, similarity);
      }
      if (budget.exhausted) break;
    }
    if (overlapping.size < 2) continue;
    const members = family.filter((doc) => overlapping.has(doc.path)).map((doc) => `"${doc.path}"`);
    findings.push({
      check: 'docs-facts',
      code: 'duplicate-doc',
      message: `dated copies: family "${key}" has ${family.length} file(s), ${members.length} overlapping: ${members.join(', ')} (similarity ${maxSimilarity.toFixed(2)}) — one file per kind of text`,
    });
    if (budget.exhausted) break;
  }
  return findings;
}

/** Findings for dated-copy families and near-duplicate markdown pairs, with paths and similarity. */
function duplicateDocFindings(dir: string, hardened: string[] | null): Finding[] {
  const collected = collectMarkdownDocs(dir, hardened);
  const templated = templatedFamilyPaths(collected);
  const docs = collected.map((doc) => ({ path: doc.path, shingles: docShingles(doc.text) }));
  const budget: PairwiseBudget = { remaining: DOC_MAX_PAIRWISE_COMPARISONS, exhausted: false };
  const findings = datedCopyFindings(docs, budget);
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      if (!takeComparison(budget)) break;
      // Dated pairs are handled per family above; non-dated pairs are reported one by one.
      if (isDatedCopy(docs[i].path, docs[j].path)) continue;
      if (templated.has(docs[i].path) || templated.has(docs[j].path)) continue;
      if (!canReachSimilarity(docs[i].shingles, docs[j].shingles, DOC_DUPLICATE_SIMILARITY)) continue;
      const similarity = jaccard(docs[i].shingles, docs[j].shingles);
      if (similarity < DOC_DUPLICATE_SIMILARITY) continue;
      findings.push({
        check: 'docs-facts',
        code: 'duplicate-doc',
        message: `near-duplicate docs: "${docs[i].path}" and "${docs[j].path}" (similarity ${similarity.toFixed(2)}) — one file per kind of text`,
      });
    }
    if (budget.exhausted) break;
  }
  if (budget.exhausted) {
    findings.push({
      check: 'docs-facts',
      code: 'duplicate-doc',
      message: `duplicate-doc analysis stopped after ${DOC_MAX_PAIRWISE_COMPARISONS} pairwise comparisons — later pairs were not compared`,
    });
  }
  if (findings.length > DOC_FINDINGS_CAP) {
    const suppressed = findings.length - DOC_FINDINGS_CAP;
    findings.length = DOC_FINDINGS_CAP;
    findings.push({
      check: 'docs-facts',
      code: 'duplicate-doc',
      message: `${suppressed} duplicate-doc finding(s) suppressed — cap is ${DOC_FINDINGS_CAP} per unit`,
    });
  }
  return findings;
}

function auditUnit(orgRoot: string, name: string, retired: string[], opts: Required<Pick<AuditOptions, 'staleDays' | 'idleDays' | 'runMetrics'>> & { now: Date }): UnitAudit {
  const dir = join(orgRoot, name);
  const findings: Finding[] = [];
  const hints: string[] = [];

  // --- git -----------------------------------------------------------------
  const inGit = isOwnGitRepo(dir);
  let hasRemote = false;
  let remoteUrl: string | null = null;
  let lastCommitAt: string | null = null;
  // Computed once per unit (it reads the unit's config); null outside git.
  const hardened = inGit ? hardenedGitArgs(dir) : null;
  if (inGit && hardened) {
    const gitError = (what: string, error: string) =>
      findings.push({ check: 'git', code: 'git-error', message: `git ${what} failed: ${error} — git state could not be audited` });
    const remotes = runGit(dir, ['remote'], hardened);
    if (!remotes.ok) {
      gitError('remote', remotes.error);
    } else if (remotes.stdout) {
      hasRemote = true;
      const first = remotes.stdout.split('\n')[0].trim();
      const url = runGit(dir, ['remote', 'get-url', first], hardened);
      if (url.ok) remoteUrl = redactRemote(url.stdout);
      else gitError('remote get-url', url.error);
    } else {
      findings.push({ check: 'git', code: 'no-remote', message: 'git repo without a remote — work is not backed up or visible' });
    }
    if (remotes.ok) {
      const log = runGit(dir, ['log', '-1', '--format=%cI'], hardened);
      if (log.ok) lastCommitAt = log.stdout || null;
      // A repo with no commits yet has nothing to report; any other failure is a real error.
      else if (!/does not have any commits/i.test(log.error)) gitError('log', log.error);
    }
  } else {
    const entries = safeReaddir(dir);
    if (entries === null) {
      findings.push({ check: 'git', code: 'audit-error', message: 'directory is not readable — unit could not be audited' });
    } else if (entries.some((f) => !f.startsWith('.'))) {
      findings.push({ check: 'git', code: 'not-in-git', message: 'directory holds work but is not a git repo' });
    }
  }

  // --- self-description ------------------------------------------------------
  const agents = readAgentsMd(dir);
  const fm = agents?.data ?? {};
  const body = agents?.body ?? '';
  const kind = fm.kind?.trim().toLowerCase() ?? null;
  const lifecycle = fm.lifecycle?.trim().toLowerCase() ?? null;
  const unclassified = !kind;

  if (agents?.error) {
    findings.push({ check: 'self-description', code: 'invalid-agents-md', message: `AGENTS.md exists but could not be parsed (${agents.error.split('\n')[0]}) — fix its frontmatter` });
  } else if (unclassified) {
    findings.push({ check: 'self-description', code: 'unclassified', message: 'no AGENTS.md self-description (kind/lifecycle)' });
    hints.push(`declare this unit: add AGENTS.md with frontmatter — kind: ${VALID_KINDS.join('|')}, lifecycle: ${VALID_LIFECYCLES.join('|')}`);
  } else if (RETIRED_KINDS[kind]) {
    findings.push({ check: 'self-description', code: 'retired-kind', message: `AGENTS.md kind "${kind}" is retired — use "${RETIRED_KINDS[kind]}"` });
  } else if (!VALID_KINDS.includes(kind as (typeof VALID_KINDS)[number])) {
    findings.push({ check: 'self-description', code: 'unknown-kind', message: `AGENTS.md kind "${kind}" is not one of ${VALID_KINDS.join(', ')}` });
  }
  if (lifecycle && !VALID_LIFECYCLES.includes(lifecycle as (typeof VALID_LIFECYCLES)[number])) {
    findings.push({ check: 'self-description', code: 'unknown-lifecycle', message: `AGENTS.md lifecycle "${lifecycle}" is not one of ${VALID_LIFECYCLES.join(', ')}` });
  }
  let parkedComplete = true;
  if (lifecycle === 'parked') {
    const reason = fm.parked_reason ?? fm.reason;
    const revisit = fm.parked_revisit ?? fm.revisit ?? fm.revisit_date;
    if (!reason || !revisit) {
      parkedComplete = false;
      findings.push({ check: 'self-description', code: 'parked-incomplete', message: 'parked units need a reason and a revisit date in AGENTS.md frontmatter' });
    }
  }

  // --- metric ---------------------------------------------------------------
  const metricCommand = agents ? declaredMetricCommand(body) : null;
  // Parked/archived units are dormant: their metric code is never worth running.
  const dormant = lifecycle === 'parked' || lifecycle === 'archived';
  const metric = runMetric(dir, metricCommand, opts.staleDays, opts.now, opts.runMetrics && !dormant);
  if (!unclassified && lifecycle !== 'parked' && lifecycle !== 'archived') {
    if (metric === 'undeclared') {
      findings.push({ check: 'metric', code: 'metric-undeclared', message: 'no runnable ## Metric section in AGENTS.md' });
    } else if (metric === 'no-data') {
      findings.push({ check: 'metric', code: 'metric-no-data', message: 'declared metric command produced no data' });
    } else if (metric === 'stale') {
      findings.push({ check: 'metric', code: 'metric-stale', message: `metric data is older than ${opts.staleDays} days` });
    } else if (metric === 'flat') {
      findings.push({ check: 'metric', code: 'metric-flat', message: 'metric never moves — every data point is identical' });
    }
  }

  // --- delivery basics (product kind) ----------------------------------------
  if (kind === 'product') {
    if (!hasCi(dir)) {
      findings.push({ check: 'delivery', code: 'no-ci', message: 'product unit has no CI workflow' });
    }
    if (!hasContract(dir, body)) {
      findings.push({ check: 'delivery', code: 'no-contract', message: 'product unit has no versioned contract for what it emits/consumes (openapi/, schemas/, or an AGENTS.md ## Contract section)' });
    }
  }

  // --- activity vs lifecycle ---------------------------------------------------
  if (inGit && lastCommitAt) {
    const last = new Date(lastCommitAt);
    const idleDays = daysBetween(last, opts.now);
    if (lifecycle === 'archived' && idleDays <= opts.idleDays) {
      findings.push({ check: 'activity', code: 'archived-but-active', message: `archived unit was pushed to ${idleDays} day(s) ago` });
    } else if (lifecycle !== 'parked' && lifecycle !== 'archived' && idleDays > opts.idleDays) {
      findings.push({ check: 'activity', code: 'active-but-idle', message: `lifecycle is active but the last commit was ${idleDays} days ago` });
    }
  }

  // --- docs facts --------------------------------------------------------------
  const pkg = packageVersion(dir);
  const claimedVersion = documentedVersion(fm);
  if (pkg.error) {
    findings.push({ check: 'docs-facts', code: 'invalid-package-json', message: `package.json could not be parsed (${pkg.error.split('\n')[0]}) — version was not checked` });
  } else if (pkg.version && claimedVersion && pkg.version !== claimedVersion) {
    findings.push({ check: 'docs-facts', code: 'stale-doc-fact', message: `AGENTS.md says version ${claimedVersion} but package.json says ${pkg.version}` });
  }
  findings.push(...duplicateDocFindings(dir, hardened));

  // --- names ---------------------------------------------------------------------
  const retiredHits = retiredTermsIn(dir, retired);
  if (retiredHits.length > 0) {
    findings.push({ check: 'names', code: 'retired-name', message: `docs use retired term(s): ${retiredHits.join(', ')}` });
  }

  // A parked unit only stays out of the gap count once its reason + revisit date are declared.
  const countsAsGap = lifecycle !== 'archived' && !(lifecycle === 'parked' && parkedComplete);
  return {
    name,
    inGit,
    hasRemote,
    remoteUrl,
    kind,
    lifecycle,
    unclassified,
    metric,
    metricCommand,
    lastCommitAt,
    findings,
    hints,
    countsAsGap,
  };
}

/** A unit that threw mid-audit (e.g. EACCES) is reported, never allowed to abort the whole run. */
function unauditableUnit(name: string, e: unknown): UnitAudit {
  return {
    name,
    inGit: false,
    hasRemote: false,
    remoteUrl: null,
    kind: null,
    lifecycle: null,
    unclassified: true,
    metric: 'undeclared',
    metricCommand: null,
    lastCommitAt: null,
    findings: [{ check: 'git', code: 'audit-error', message: `unit could not be audited: ${e instanceof Error ? e.message : String(e)}` }],
    hints: [],
    countsAsGap: true,
  };
}

/** Org-level docs facts: repo names listed under a Repos heading that no longer exist. */
function auditOrgDocs(orgRoot: string, units: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const file of ['AGENTS.md', 'README.md']) {
    const p = join(orgRoot, file);
    if (!existsSync(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const section = extractSection(text, 'Repos\\w*');
    if (!section) continue;
    for (const line of section.split('\n')) {
      const m = /^\s*[-*]\s+(?:\*\*`?|`)([a-zA-Z0-9._-]+)`?(?:\*\*)?/.exec(line);
      if (m && !units.includes(m[1])) {
        findings.push({ check: 'docs-facts', code: 'stale-doc-fact', message: `${file} lists repo "${m[1]}" which does not exist in the org root` });
      }
    }
  }
  return findings;
}

const PROPOSAL_TITLES: Record<string, (unit: string) => string> = {
  'not-in-git': (u) => `fix: put ${u} under git with a remote`,
  'no-remote': (u) => `fix: add a git remote for ${u}`,
  unclassified: (u) => `fix: declare ${u} (AGENTS.md kind + lifecycle)`,
  'unknown-kind': (u) => `fix: correct AGENTS.md kind in ${u}`,
  'unknown-lifecycle': (u) => `fix: correct AGENTS.md lifecycle in ${u}`,
  'metric-undeclared': (u) => `measure: declare a runnable ## Metric for ${u}`,
  'metric-no-data': (u) => `measure: make the ${u} metric produce data`,
  'metric-stale': (u) => `measure: refresh stale metric data in ${u}`,
  'metric-flat': (u) => `measure: investigate flat metric in ${u}`,
  'no-ci': (u) => `fix: add CI to ${u}`,
  'no-contract': (u) => `fix: add a versioned contract to ${u}`,
  'active-but-idle': (u) => `fix: reconcile idle ${u} with its active lifecycle`,
  'archived-but-active': (u) => `fix: reconcile archived ${u} with recent pushes`,
  'stale-doc-fact': (u) => `fix: stale doc fact in ${u}`,
  'duplicate-doc': (u) => `fix: consolidate duplicate docs in ${u}`,
  'git-error': (u) => `fix: git state of ${u} could not be read`,
  'audit-error': (u) => `fix: ${u} could not be audited`,
  'invalid-agents-md': (u) => `fix: AGENTS.md in ${u} does not parse`,
  'invalid-package-json': (u) => `fix: package.json in ${u} does not parse`,
  'parked-incomplete': (u) => `fix: add parked reason + revisit date to ${u}`,
  'retired-kind': (u) => `fix: replace retired AGENTS.md kind in ${u}`,
  'retired-name': (u) => `fix: retired name used in ${u} docs`,
};

function buildProposals(units: UnitAudit[], date: string): Proposal[] {
  const proposals: Proposal[] = [];
  for (const unit of units) {
    if (!unit.countsAsGap) continue;
    for (const f of unit.findings) {
      const title = (PROPOSAL_TITLES[f.code] ?? ((u: string) => `fix: ${f.code} in ${u}`))(unit.name);
      proposals.push({
        repo: unit.name,
        remoteUrl: unit.remoteUrl,
        title,
        body: [
          `**Gap** (${f.check} / ${f.code}): ${f.message}`,
          '',
          `Drafted by \`squads audit --propose\` on ${date}. Draft only — not auto-filed.`,
        ].join('\n'),
      });
    }
  }
  return proposals;
}

/**
 * Audit an org root. Read-only by default; declared metric commands (which run
 * repo code, scrubbed env, active units only) run only with `runMetrics`.
 */
export function auditOrg(orgRoot: string, options: AuditOptions = {}): OrgAuditReport {
  const now = options.now ?? new Date();
  const staleDays = options.staleDays ?? 14;
  const idleDays = options.idleDays ?? 30;
  const controlRepo = options.controlRepo ?? process.env.SQUADS_ORG_CONTROL_REPO?.trim() ?? 'hq';

  const unitNames = listOrgUnits(orgRoot);
  const retired = loadRetiredNames(orgRoot, controlRepo);
  const runMetrics = options.runMetrics === true;
  const units = unitNames.map((name) => {
    try {
      return auditUnit(orgRoot, name, retired.terms, { staleDays, idleDays, now, runMetrics });
    } catch (e) {
      return unauditableUnit(name, e);
    }
  });
  const orgFindings = [...retired.findings, ...auditOrgDocs(orgRoot, unitNames)];

  const gaps =
    units.filter((u) => u.countsAsGap).reduce((n, u) => n + u.findings.length, 0) + orgFindings.length;
  const date = now.toISOString().slice(0, 10);

  const report: OrgAuditReport = {
    date,
    orgRoot: realpathSync(orgRoot),
    summary: {
      units: units.length,
      gaps,
      parkedOrArchived: units.filter((u) => !u.countsAsGap).length,
    },
    units,
    orgFindings,
  };
  if (options.propose) {
    report.proposals = buildProposals(units, date);
  }
  return report;
}
