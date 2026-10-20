/**
 * Feature lists as code (agents-squads/squads-cli#1329).
 *
 * Each repo carries `.agents/features.json` (schema in schemas/features.schema.json);
 * the HQ repo may carry `.agents/roadmap.json` grouping items across repos into
 * outcomes. This module parses, validates and aggregates them. Everything here
 * is read-only.
 *
 * Validation rules beyond the file shape:
 *   - ids are unique per file;
 *   - `status: passing` needs a verification whose `model` differs from
 *     `builder_model` and whose `sha` exists in the repo;
 *   - every roadmap `<repo>:<id>` reference names an item that exists.
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

export const FEATURES_FILE = join('.agents', 'features.json');
export const ROADMAP_FILE = join('.agents', 'roadmap.json');

export const FEATURES_HINT =
  'No feature lists yet — add .agents/features.json to a repo (schema: schemas/features.schema.json).';

export interface FeatureVerification {
  model: string;
  builder_model: string;
  sha: string;
  at: string;
  run_id?: string;
}

export interface FeatureItem {
  id: string;
  outcome: string;
  title: string;
  status: 'failing' | 'passing';
  issue?: string;
  spec?: string;
  check?: { ci?: string; live?: string };
  consumers?: string[];
  note?: string;
  verifications?: FeatureVerification[];
}

export interface FeatureList {
  schema: 1;
  repo: string;
  items: FeatureItem[];
}

export interface RoadmapOutcome {
  id: string;
  name: string;
  target?: string[];
  items: string[];
}

export type ProblemCode =
  | 'unreadable'
  | 'invalid-schema'
  | 'duplicate-id'
  | 'passing-without-verification'
  | 'missing-roadmap-item';

export interface FeatureProblem {
  code: ProblemCode;
  /** File the problem lives in, relative to the scan root when possible. */
  file: string;
  message: string;
  item?: string;
}

export interface LoadedFeatureFile {
  /** Absolute path of the features.json. */
  path: string;
  /** Repo directory (the one containing `.agents/`). */
  repoDir: string;
  /** Parsed list; null when the file could not be read or has the wrong shape. */
  list: FeatureList | null;
  /** Problems found in this file alone (schema, duplicate ids, verification). */
  problems: FeatureProblem[];
}

export type ShaExists = (repoDir: string, sha: string) => boolean;

/** `git cat-file -e <sha>^{commit}` — argument vector only, never a shell. */
export const gitShaExists: ShaExists = (repoDir, sha) => {
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) return false;
  try {
    execFileSync('git', ['-C', repoDir, 'cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;

/** Shape errors for a parsed features.json; empty means it is a FeatureList. */
export function shapeErrors(data: unknown): string[] {
  if (!isRecord(data)) return ['top level must be an object'];
  const errors: string[] = [];
  if (data.schema !== 1) errors.push('schema must be 1');
  if (!isNonEmpty(data.repo)) errors.push('repo must be a non-empty string');
  if (!Array.isArray(data.items)) {
    errors.push('items must be an array');
    return errors;
  }
  data.items.forEach((item, i) => {
    const at = `items[${i}]`;
    if (!isRecord(item)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (!isNonEmpty(item.id)) errors.push(`${at}.id must be a non-empty string`);
    if (!isStr(item.outcome)) errors.push(`${at}.outcome must be a string`);
    if (!isNonEmpty(item.title)) errors.push(`${at}.title must be a non-empty string`);
    if (item.status !== 'failing' && item.status !== 'passing') errors.push(`${at}.status must be "failing" or "passing"`);
    if (item.verifications !== undefined) {
      if (!Array.isArray(item.verifications)) {
        errors.push(`${at}.verifications must be an array`);
      } else {
        item.verifications.forEach((v, j) => {
          if (!isRecord(v) || !isNonEmpty(v.model) || !isNonEmpty(v.builder_model) || !isNonEmpty(v.sha) || !isStr(v.at)) {
            errors.push(`${at}.verifications[${j}] needs model, builder_model, sha, at`);
          }
        });
      }
    }
  });
  return errors;
}

function hasValidVerification(item: FeatureItem, repoDir: string, shaExists: ShaExists): boolean {
  return (item.verifications ?? []).some(
    v => v.model !== v.builder_model && shaExists(repoDir, v.sha),
  );
}

/** Read and validate one features.json. Never throws. */
export function loadFeatureFile(
  path: string,
  display: string = path,
  shaExists: ShaExists = gitShaExists,
): LoadedFeatureFile {
  const repoDir = dirname(dirname(path));
  const problem = (code: ProblemCode, message: string, item?: string): FeatureProblem => ({
    code,
    file: display,
    message,
    ...(item ? { item } : {}),
  });

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    return {
      path,
      repoDir,
      list: null,
      problems: [problem('unreadable', `cannot read: ${e instanceof Error ? e.message : String(e)}`)],
    };
  }

  const errors = shapeErrors(data);
  if (errors.length > 0) {
    return { path, repoDir, list: null, problems: errors.map(m => problem('invalid-schema', m)) };
  }

  const list = data as FeatureList;
  const problems: FeatureProblem[] = [];
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const item of list.items) {
    if (seen.has(item.id) && !reported.has(item.id)) {
      problems.push(problem('duplicate-id', `duplicate id "${item.id}"`, item.id));
      reported.add(item.id);
    }
    seen.add(item.id);
    if (item.status === 'passing' && !hasValidVerification(item, repoDir, shaExists)) {
      problems.push(
        problem(
          'passing-without-verification',
          `"${item.id}" is passing but has no verification with model ≠ builder_model and an existing sha`,
          item.id,
        ),
      );
    }
  }
  return { path, repoDir, list, problems };
}

/** The root itself plus each non-hidden direct child directory. */
function candidateDirs(root: string): string[] {
  const dirs = [root];
  let entries: string[] = [];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return dirs;
  }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const dir = join(root, name);
    try {
      if (statSync(dir).isDirectory()) dirs.push(dir);
    } catch {
      // unreadable entry — skip
    }
  }
  return dirs;
}

export function findFeatureFiles(root: string): string[] {
  return candidateDirs(root)
    .map(d => join(d, FEATURES_FILE))
    .filter(f => existsSync(f));
}

export function findRoadmapFile(root: string): string | null {
  for (const dir of candidateDirs(root)) {
    const f = join(dir, ROADMAP_FILE);
    if (existsSync(f)) return f;
  }
  return null;
}

interface LoadedRoadmap {
  path: string;
  outcomes: RoadmapOutcome[];
  problems: FeatureProblem[];
}

function loadRoadmap(path: string, display: string): LoadedRoadmap {
  const bad = (code: ProblemCode, message: string): LoadedRoadmap => ({
    path,
    outcomes: [],
    problems: [{ code, file: display, message }],
  });
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    return bad('unreadable', `cannot read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const raw = Array.isArray(data) ? data : isRecord(data) ? data.outcomes : undefined;
  if (!Array.isArray(raw)) return bad('invalid-schema', 'roadmap needs an "outcomes" array');
  const outcomes: RoadmapOutcome[] = [];
  for (const [i, o] of raw.entries()) {
    if (!isRecord(o) || !isNonEmpty(o.id) || !Array.isArray(o.items) || !o.items.every(isStr)) {
      return bad('invalid-schema', `outcomes[${i}] needs id and an items array of "<repo>:<id>" strings`);
    }
    outcomes.push({
      id: o.id,
      name: isStr(o.name) ? o.name : o.id,
      ...(Array.isArray(o.target) ? { target: o.target.filter(isStr) } : {}),
      items: o.items as string[],
    });
  }
  return { path, outcomes, problems: [] };
}

// ── Aggregation ──────────────────────────────────────────────────────

export interface PlanItem {
  ref: string;
  id: string;
  title: string;
  status: 'failing' | 'passing';
  repo: string;
  issue?: string;
}

export interface OutcomeView {
  id: string;
  name: string;
  target?: string[];
  items: PlanItem[];
  counts: { total: number; passing: number; failing: number };
  /** Roadmap references that name no existing item. */
  missing: string[];
}

export interface FeaturesView {
  v: 1;
  configured: boolean;
  root: string;
  roadmap: string | null;
  hint?: string;
  files: Array<{ path: string; repo: string | null; items: number; valid: boolean }>;
  /** Sums over valid files only. */
  totals: { files: number; valid_files: number; items: number; passing: number; failing: number };
  outcomes: OutcomeView[];
  /** Valid items the roadmap does not reference (roadmap mode only). */
  unreferenced: PlanItem[];
  problems: FeatureProblem[];
}

export interface AnalyzeOptions {
  shaExists?: ShaExists;
}

function rel(root: string, p: string): string {
  const r = resolve(p);
  const base = resolve(root);
  return r.startsWith(base + '/') ? r.slice(base.length + 1) : r;
}

const counts = (items: PlanItem[]): OutcomeView['counts'] => {
  const passing = items.filter(i => i.status === 'passing').length;
  return { total: items.length, passing, failing: items.length - passing };
};

/**
 * The org root to scan: an explicit `--root`, else the HQ repo itself when it
 * holds the roadmap, else the project's parent directory (all repos are
 * siblings under one parent). With no project at all, the cwd.
 */
export function resolveOrgRoot(explicit: string | undefined, projectRoot: string | null, cwd: string): string {
  if (explicit) return resolve(cwd, explicit);
  if (!projectRoot) return cwd;
  const project = resolve(projectRoot);
  return existsSync(join(project, ROADMAP_FILE)) ? project : dirname(project);
}

/** Scan `root`, validate every feature list and the roadmap, and aggregate. */
export function analyzeFeatures(root: string, opts: AnalyzeOptions = {}): FeaturesView {
  const shaExists = opts.shaExists ?? gitShaExists;
  const loaded = findFeatureFiles(root).map(f => loadFeatureFile(f, rel(root, f), shaExists));
  const roadmapPath = findRoadmapFile(root);

  const problems: FeatureProblem[] = loaded.flatMap(l => l.problems);
  const valid = loaded.filter(l => l.list !== null && l.problems.length === 0);

  // Items addressed by roadmap refs: any parseable list, so a duplicate-id file
  // doesn't also cascade into "missing item" noise.
  const known = new Map<string, Map<string, { file: LoadedFeatureFile; item: FeatureItem }>>();
  for (const l of loaded) {
    if (!l.list) continue;
    const byId = new Map<string, { file: LoadedFeatureFile; item: FeatureItem }>();
    for (const item of l.list.items) if (!byId.has(item.id)) byId.set(item.id, { file: l, item });
    for (const key of new Set([l.list.repo, l.list.repo.split('/').pop() ?? l.list.repo, basename(l.repoDir)])) {
      if (!known.has(key)) known.set(key, byId);
    }
  }

  const toPlanItem = (l: LoadedFeatureFile, item: FeatureItem): PlanItem => ({
    ref: `${l.list?.repo ?? basename(l.repoDir)}:${item.id}`,
    id: item.id,
    title: item.title,
    status: item.status,
    repo: l.list?.repo ?? basename(l.repoDir),
    ...(item.issue ? { issue: item.issue } : {}),
  });

  const validItems = valid.flatMap(l => (l.list as FeatureList).items.map(item => ({ l, item })));
  const totals = {
    files: loaded.length,
    valid_files: valid.length,
    items: validItems.length,
    passing: validItems.filter(x => x.item.status === 'passing').length,
    failing: validItems.filter(x => x.item.status === 'failing').length,
  };

  let outcomes: OutcomeView[] = [];
  let unreferenced: PlanItem[] = [];

  if (roadmapPath) {
    const roadmap = loadRoadmap(roadmapPath, rel(root, roadmapPath));
    problems.push(...roadmap.problems);
    const referenced = new Set<FeatureItem>();
    outcomes = roadmap.outcomes.map(o => {
      const items: PlanItem[] = [];
      const missing: string[] = [];
      for (const ref of o.items) {
        const sep = ref.lastIndexOf(':');
        const hit = sep > 0 ? known.get(ref.slice(0, sep))?.get(ref.slice(sep + 1)) : undefined;
        if (!hit) {
          missing.push(ref);
          problems.push({
            code: 'missing-roadmap-item',
            file: rel(root, roadmapPath),
            item: ref,
            message: `outcome ${o.id} references "${ref}", which is not in any features.json`,
          });
          continue;
        }
        referenced.add(hit.item);
        // Only valid files feed the view; an invalid file's items stay listed
        // in its own problems rather than being counted twice.
        if (valid.includes(hit.file)) items.push(toPlanItem(hit.file, hit.item));
      }
      return { id: o.id, name: o.name, ...(o.target ? { target: o.target } : {}), items, counts: counts(items), missing };
    });
    unreferenced = validItems.filter(x => !referenced.has(x.item)).map(x => toPlanItem(x.l, x.item));
  } else {
    const groups = new Map<string, PlanItem[]>();
    for (const { l, item } of validItems) {
      const list = groups.get(item.outcome) ?? [];
      list.push(toPlanItem(l, item));
      groups.set(item.outcome, list);
    }
    outcomes = [...groups.entries()].map(([name, items]) => ({
      id: name,
      name,
      items,
      counts: counts(items),
      missing: [],
    }));
  }

  return {
    v: 1,
    configured: loaded.length > 0,
    root: resolve(root),
    roadmap: roadmapPath ? rel(root, roadmapPath) : null,
    ...(loaded.length === 0 ? { hint: FEATURES_HINT } : {}),
    files: loaded.map(l => ({
      path: rel(root, l.path),
      repo: l.list?.repo ?? null,
      items: l.list?.items.length ?? 0,
      valid: l.list !== null && l.problems.length === 0,
    })),
    totals,
    outcomes,
    unreferenced,
    problems,
  };
}
