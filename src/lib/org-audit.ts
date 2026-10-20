/**
 * Org audit engine (#1327).
 *
 * Walks an org root (see org-root.ts) and classifies every unit — git repo or
 * not — against the "company as code" contract: in git with a remote,
 * self-describing (AGENTS.md frontmatter), measured (a runnable ## Metric),
 * delivery basics for products, activity matching lifecycle, docs facts that
 * match derivable truth, and no retired names.
 *
 * Read-only: the audit never writes to the org root. Metric commands declared
 * by the org in AGENTS.md `## Metric` code blocks are executed to read data.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import matter from 'gray-matter';
import yaml from 'js-yaml';
import { listOrgUnits } from './org-root.js';

export const VALID_KINDS = ['product', 'domain', 'client', 'prospect', 'lab', 'internal'] as const;
export const VALID_LIFECYCLES = ['active', 'parked', 'archived'] as const;

export type MetricStatus = 'undeclared' | 'no-data' | 'stale' | 'flat' | 'ok';

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
  lastCommitAt: string | null;
  findings: Finding[];
  hints: string[];
  /** Parked and archived units are listed but never count as gaps. */
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

function runGit(dir: string, args: string[]): string | null {
  const r = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error || r.status !== 0) return null;
  return (r.stdout ?? '').trim();
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

function readAgentsMd(dir: string): { data: UnitFrontmatter; body: string } | null {
  const p = join(dir, 'AGENTS.md');
  if (!existsSync(p)) return null;
  try {
    const parsed = matter(readFileSync(p, 'utf8'));
    return { data: (parsed.data ?? {}) as UnitFrontmatter, body: parsed.content ?? '' };
  } catch {
    return { data: {}, body: '' };
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

/** First shell command declared in a fenced code block inside a markdown section. */
function extractCommand(section: string): string | null {
  const m = /```[^\n]*\n([\s\S]*?)```/.exec(section);
  if (!m) return null;
  const line = m[1].split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return line ?? null;
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

function runMetric(dir: string, body: string, staleDays: number, now: Date): MetricStatus {
  const section = extractSection(body, 'Metric');
  if (!section) return 'undeclared';
  const command = extractCommand(section);
  if (!command) return 'undeclared';

  const r = spawnSync(command, {
    cwd: dir,
    shell: true,
    encoding: 'utf8',
    timeout: METRIC_TIMEOUT_MS,
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
  return isDir(wf) && readdirSync(wf).some((f) => /\.ya?ml$/.test(f));
}

function hasContract(dir: string, body: string): boolean {
  for (const candidate of ['openapi', 'schemas', 'schema', 'proto']) {
    if (isDir(join(dir, candidate)) && readdirSync(join(dir, candidate)).length > 0) return true;
  }
  for (const file of ['openapi.json', 'openapi.yaml', 'openapi.yml', 'asyncapi.json', 'asyncapi.yaml']) {
    if (existsSync(join(dir, file))) return true;
  }
  return extractSection(body, 'Contract') !== null;
}

function packageVersion(dir: string): string | null {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    const v = (JSON.parse(readFileSync(p, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Version the docs claim: frontmatter `version:` first, then a `version X.Y.Z` / `vX.Y.Z` mention. */
function documentedVersion(fm: UnitFrontmatter, body: string): string | null {
  if (fm.version && /^\d+\.\d+\.\d+$/.test(fm.version)) return fm.version;
  const m = /\bversion[:\s]+v?(\d+\.\d+\.\d+)\b/i.exec(body) ?? /\bv(\d+\.\d+\.\d+)\b/.exec(body);
  return m ? m[1] : null;
}

/** Retired terms declared by the org: names.{yml,yaml,json} in the control repo or org root. */
function loadRetiredNames(orgRoot: string, controlRepo: string): string[] {
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
        if (Array.isArray(list)) return list.filter((t): t is string => typeof t === 'string');
      } catch {
        // Unparseable names table — treated as absent, never a crash.
      }
    }
  }
  return [];
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

function auditUnit(orgRoot: string, name: string, retired: string[], opts: Required<Pick<AuditOptions, 'staleDays' | 'idleDays'>> & { now: Date }): UnitAudit {
  const dir = join(orgRoot, name);
  const findings: Finding[] = [];
  const hints: string[] = [];

  // --- git -----------------------------------------------------------------
  const inGit = isOwnGitRepo(dir);
  let hasRemote = false;
  let remoteUrl: string | null = null;
  let lastCommitAt: string | null = null;
  if (inGit) {
    const remotes = runGit(dir, ['remote']);
    hasRemote = !!remotes;
    if (hasRemote) {
      const first = remotes!.split('\n')[0].trim();
      remoteUrl = runGit(dir, ['remote', 'get-url', first]);
    } else {
      findings.push({ check: 'git', code: 'no-remote', message: 'git repo without a remote — work is not backed up or visible' });
    }
    lastCommitAt = runGit(dir, ['log', '-1', '--format=%cI']);
  } else {
    const hasFiles = readdirSync(dir).some((f) => !f.startsWith('.'));
    if (hasFiles) {
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

  if (unclassified) {
    findings.push({ check: 'self-description', code: 'unclassified', message: 'no AGENTS.md self-description (kind/lifecycle)' });
    hints.push(`declare this unit: add AGENTS.md with frontmatter — kind: ${VALID_KINDS.join('|')}, lifecycle: ${VALID_LIFECYCLES.join('|')}`);
  } else if (!VALID_KINDS.includes(kind as (typeof VALID_KINDS)[number])) {
    findings.push({ check: 'self-description', code: 'unknown-kind', message: `AGENTS.md kind "${kind}" is not one of ${VALID_KINDS.join(', ')}` });
  }
  if (lifecycle && !VALID_LIFECYCLES.includes(lifecycle as (typeof VALID_LIFECYCLES)[number])) {
    findings.push({ check: 'self-description', code: 'unknown-lifecycle', message: `AGENTS.md lifecycle "${lifecycle}" is not one of ${VALID_LIFECYCLES.join(', ')}` });
  }
  if (lifecycle === 'parked') {
    const reason = fm.parked_reason ?? fm.reason;
    const revisit = fm.parked_revisit ?? fm.revisit ?? fm.revisit_date;
    if (!reason || !revisit) {
      findings.push({ check: 'self-description', code: 'parked-incomplete', message: 'parked units need a reason and a revisit date in AGENTS.md frontmatter' });
    }
  }

  // --- metric ---------------------------------------------------------------
  const metric = agents ? runMetric(dir, body, opts.staleDays, opts.now) : 'undeclared';
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
  const actualVersion = packageVersion(dir);
  const claimedVersion = documentedVersion(fm, body);
  if (actualVersion && claimedVersion && actualVersion !== claimedVersion) {
    findings.push({ check: 'docs-facts', code: 'stale-doc-fact', message: `AGENTS.md says version ${claimedVersion} but package.json says ${actualVersion}` });
  }

  // --- names ---------------------------------------------------------------------
  const retiredHits = retiredTermsIn(dir, retired);
  if (retiredHits.length > 0) {
    findings.push({ check: 'names', code: 'retired-name', message: `docs use retired term(s): ${retiredHits.join(', ')}` });
  }

  const countsAsGap = lifecycle !== 'parked' && lifecycle !== 'archived';
  return {
    name,
    inGit,
    hasRemote,
    remoteUrl,
    kind,
    lifecycle,
    unclassified,
    metric,
    lastCommitAt,
    findings,
    hints,
    countsAsGap,
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
 * Audit an org root. Pure read + declared-metric execution; writes nothing.
 */
export function auditOrg(orgRoot: string, options: AuditOptions = {}): OrgAuditReport {
  const now = options.now ?? new Date();
  const staleDays = options.staleDays ?? 14;
  const idleDays = options.idleDays ?? 30;
  const controlRepo = options.controlRepo ?? process.env.SQUADS_ORG_CONTROL_REPO?.trim() ?? 'hq';

  const unitNames = listOrgUnits(orgRoot);
  const retired = loadRetiredNames(orgRoot, controlRepo);
  const units = unitNames.map((name) => auditUnit(orgRoot, name, retired, { staleDays, idleDays, now }));
  const orgFindings = auditOrgDocs(orgRoot, unitNames);

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
