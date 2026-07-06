/**
 * inbox.ts — one list of everything waiting on a human (#924, review-queue
 * Child 0; the approval surface of the Loop).
 *
 * The last-mile failure this exists to kill: runs complete, deliverables
 * strand (a brief sat un-merged on a run branch for two weeks because nothing
 * surfaced it). The inbox derives its items from git/gh/events AT READ TIME —
 * scanners, not a second state store that can drift. Child 0 is list-only;
 * the decision verbs (approve/reject/defer) are Child A.
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { parsePersistedLine } from './event-render.js';
import { activeDeferrals } from './inbox-decisions.js';

export type InboxKind = 'pr' | 'run_branch' | 'run_artifacts';

export interface InboxItem {
  /** Stable handle for Child A's decisions: pr-12 | branch-<name> | run-<execId>. */
  id: string;
  kind: InboxKind;
  /** PR url | branch name | execution id. */
  ref: string;
  title: string;
  ageDays: number;
  /** What saying "yes" concretely does — shown so approval is never a mystery. */
  approveSemantics: string;
  detail?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function ageDaysFrom(epochMs: number): number {
  return Math.max(0, Math.floor((Date.now() - epochMs) / DAY_MS));
}

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 20_000 });
}

/**
 * Refresh remote refs before scanning (#929): stale local refs made already-
 * landed branches read as "N commits ahead". Best-effort — offline/no-remote
 * repos scan against whatever is local. SQUADS_INBOX_NO_FETCH=1 opts out
 * (tests, air-gapped).
 */
function refreshRefs(repoRoot: string): void {
  if (process.env.SQUADS_INBOX_NO_FETCH === '1') return;
  try {
    sh('git fetch --prune --quiet origin', repoRoot);
  } catch {
    // no remote / offline — local refs are all we have
  }
}

/**
 * The branch this repo actually integrates to (#929). develop-by-existence is
 * wrong when develop is vestigial: if main holds more commits develop lacks
 * than vice versa, main is the real trunk (the intelligence/research case —
 * 61 direct-push commits develop never saw).
 */
export function pickScanBase(repoRoot: string): string {
  const exists = (ref: string): boolean => {
    try { sh(`git rev-parse --verify --quiet ${ref}`, repoRoot); return true; } catch { return false; }
  };
  const count = (range: string): number => {
    try { return parseInt(sh(`git rev-list --count ${range}`, repoRoot).trim(), 10) || 0; } catch { return 0; }
  };
  const develop = ['origin/develop', 'develop'].find(exists);
  const main = ['origin/main', 'main', 'origin/master', 'master'].find(exists);
  if (develop && main) {
    return count(`${develop}..${main}`) > count(`${main}..${develop}`) ? main : develop;
  }
  return develop ?? main ?? 'HEAD';
}

/**
 * Squash-merge blindness (#929): content merged via squash gets a new SHA, so
 * rev-list stays ≥1 forever. `git cherry` compares PATCH IDs — when every
 * commit ahead is already equivalent upstream ('-' lines only), the branch
 * has landed and is not waiting on anyone.
 */
function hasUnlandedCommits(branch: string, base: string, repoRoot: string): boolean {
  try {
    const cherry = sh(`git cherry ${base} '${branch.replace(/'/g, '')}'`, repoRoot);
    return cherry.split('\n').some((l) => l.startsWith('+'));
  } catch {
    return true; // can't tell — keep it visible rather than hide real work
  }
}

/** Open PRs to develop in the repo at `repoRoot` (needs gh; empty on failure). */
export function scanOpenPrs(repoRoot: string): InboxItem[] {
  try {
    const raw = sh(`gh pr list --base develop --state open --json number,title,createdAt,url,author --limit 30`, repoRoot);
    const prs = JSON.parse(raw) as Array<{ number: number; title: string; createdAt: string; url: string; author?: { login?: string; is_bot?: boolean } }>;
    return prs.map((pr) => ({
      id: `pr-${pr.number}`,
      kind: 'pr' as const,
      ref: pr.url,
      title: pr.title,
      ageDays: ageDaysFrom(Date.parse(pr.createdAt)),
      approveSemantics: 'merge to develop (CI-gated squash)',
      detail: pr.author?.login ? `by ${pr.author.login}` : undefined,
    }));
  } catch {
    return []; // no gh / not a github repo / offline — the other scanners still run
  }
}

/**
 * Stranded run branches: `squads/run-*` and `agent/*` refs with commits not
 * reachable from develop (or HEAD when develop doesn't exist) — auto-committed
 * deliverables (#891) nobody has decided on. THE Argonne case.
 */
export function scanStrandedBranches(repoRoot: string): InboxItem[] {
  const items: InboxItem[] = [];
  let refs: string;
  try {
    refs = sh(`git for-each-ref 'refs/heads/squads/run-*' 'refs/heads/agent/*' --format='%(refname:short)|%(committerdate:unix)|%(subject)'`, repoRoot);
  } catch {
    return items;
  }
  const base = pickScanBase(repoRoot);
  for (const line of refs.split('\n')) {
    if (!line.trim()) continue;
    const [branch, epoch, ...subjectParts] = line.split('|');
    if (!branch) continue;
    let ahead = 0;
    try {
      ahead = parseInt(sh(`git rev-list --count '${branch.replace(/'/g, '')}' ^${base}`, repoRoot).trim(), 10) || 0;
    } catch { continue; }
    if (ahead === 0) continue;
    if (!hasUnlandedCommits(branch, base, repoRoot)) continue; // squash-landed (#929)
    items.push({
      id: `branch-${branch}`,
      kind: 'run_branch',
      ref: branch,
      title: (subjectParts.join('|') || branch).slice(0, 90),
      ageDays: ageDaysFrom((parseInt(epoch, 10) || 0) * 1000),
      approveSemantics: `open a PR from ${branch} (has ${ahead} unmerged commit${ahead > 1 ? 's' : ''})`,
      detail: `${ahead} commit(s) ahead of ${base}`,
    });
  }
  return items;
}

/**
 * Recent runs whose event stream recorded PR artifacts — output that exists
 * and may not have landed. Without live resolution this lists them for a
 * human `squads runs --outcome <id>`; the caller can resolve live (capped).
 */
export function scanRunsWithArtifacts(obsRoot: string, limit = 15): InboxItem[] {
  const eventsDir = join(obsRoot, '.agents', 'observability', 'events');
  if (!existsSync(eventsDir)) return [];
  let files: Array<{ id: string; path: string; mtime: number }>;
  try {
    files = readdirSync(eventsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: f.replace(/\.jsonl$/, ''), path: join(eventsDir, f), mtime: statSync(join(eventsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit * 3);
  } catch {
    return [];
  }

  const items: InboxItem[] = [];
  for (const f of files) {
    if (items.length >= limit) break;
    let prRefs: string[];
    let squad = '';
    try {
      const lines = readFileSync(f.path, 'utf8').split('\n').map(parsePersistedLine);
      prRefs = [];
      for (const l of lines) {
        if (!l) continue;
        if (l.event.type === 'run_start') squad = l.event.squad;
        if (l.event.type === 'artifact' && l.event.kind === 'pr' && l.event.ref.startsWith('https://')) {
          if (!prRefs.includes(l.event.ref)) prRefs.push(l.event.ref);
        }
      }
    } catch { continue; }
    if (prRefs.length === 0) continue;
    items.push({
      id: `run-${f.id}`,
      kind: 'run_artifacts',
      ref: f.id,
      title: `${squad || 'run'} produced ${prRefs.length} PR${prRefs.length > 1 ? 's' : ''}`,
      ageDays: ageDaysFrom(f.mtime),
      approveSemantics: `check landed state: squads runs --outcome ${f.id}`,
      detail: prRefs[0],
    });
  }
  return items;
}

/**
 * The queue, newest-risk-first: open PRs (oldest = most overdue, first),
 * then stranded branches (the silent-loss class), then artifact runs.
 * Scanners are independent; one failing never empties the others.
 *
 * Actively-deferred items (Child A, #933) are hidden until their snooze
 * expires — approve/reject decisions are NOT filtered here: an approved PR
 * that is somehow still open should stay in your face, not vanish.
 */
export function buildInbox(repoRoot: string, obsRoot: string, opts?: { includeDeferred?: boolean }): InboxItem[] {
  refreshRefs(repoRoot);
  const prs = scanOpenPrs(repoRoot).sort((a, b) => b.ageDays - a.ageDays);
  const branches = scanStrandedBranches(repoRoot).sort((a, b) => b.ageDays - a.ageDays);
  const runs = scanRunsWithArtifacts(obsRoot).sort((a, b) => b.ageDays - a.ageDays);
  const all = [...prs, ...branches, ...runs];
  if (opts?.includeDeferred) return all;
  const deferred = activeDeferrals(obsRoot);
  return deferred.size === 0 ? all : all.filter((i) => !deferred.has(i.id));
}
