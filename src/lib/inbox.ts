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
import { dirname, join } from 'path';
import { parsePersistedLine } from './event-render.js';
import { activeDeferrals } from './inbox-decisions.js';

export type InboxKind = 'pr' | 'run_branch' | 'run_artifacts' | 'goal' | 'coherence' | 'oracle_alert' | 'strategy_proposal';

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
 * Stranded run branches: `squads/run-*`, `squads/proposal-*` (#983 — `squads
 * propose`'s ambient deliverables), and `agent/*` refs with commits not
 * reachable from develop (or HEAD when develop doesn't exist) — auto-committed
 * deliverables (#891) nobody has decided on. THE Argonne case.
 */
export function scanStrandedBranches(repoRoot: string): InboxItem[] {
  const items: InboxItem[] = [];
  let refs: string;
  try {
    refs = sh(`git for-each-ref 'refs/heads/squads/run-*' 'refs/heads/agent/*' 'refs/heads/squads/proposal-*' --format='%(refname:short)|%(committerdate:unix)|%(subject)'`, repoRoot);
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
    // A5 (hq#470): the #875 auto-save commit message IS the signature of a run
    // that died before committing its own work (timeout / blocked) — surface it
    // as a PARTIAL so salvage is a queue decision, not operator archaeology.
    const subject = subjectParts.join('|') || branch;
    const isPartial = /auto-save uncommitted deliverables/i.test(subject);
    // #983: `squads propose` lands its ambient deliverable on squads/proposal-*
    // instead of squads/run-* — surface it as a PROPOSAL so a human reviews it
    // distinctly from a directed run's output before approving.
    const isProposal = branch.startsWith('squads/proposal-');
    const label = isProposal && isPartial ? 'PROPOSAL (partial) — '
      : isProposal ? 'PROPOSAL — '
      : isPartial ? 'PARTIAL (run died before committing) — '
      : '';
    items.push({
      id: `branch-${branch}`,
      kind: 'run_branch',
      ref: branch,
      title: `${label}${subject}`.slice(0, 110),
      ageDays: ageDaysFrom((parseInt(epoch, 10) || 0) * 1000),
      approveSemantics: `open a PR from ${branch} (has ${ahead} unmerged commit${ahead > 1 ? 's' : ''})`,
      detail: `${ahead} commit(s) ahead of ${base}${isPartial ? ' · partial run output — inspect before approving' : ''}${isProposal ? ' · ambient proposal — review before approving' : ''}`,
    });
  }
  return items;
}

/** Injectable shell for tests (mirrors inbox-decisions' CommandRunner). */
export type ShRunner = (cmd: string, cwd: string) => string;

/**
 * Live PR state for an artifact pointer (#1021 stale-row reconcile). A run
 * item is only "waiting on a human" while at least one of its PRs is still
 * open — 4 of 6 items in the 2026-07-07 audit were already-merged PRs shown
 * as waiting. Fail-open: if gh can't answer (offline, no gh), the item stays
 * visible — a stale row beats a hidden one.
 */
function prStillOpen(ref: string, run: ShRunner): boolean {
  try {
    const state = run(`gh pr view ${ref} --json state --jq .state`, process.cwd()).trim();
    return state !== 'MERGED' && state !== 'CLOSED';
  } catch {
    return true;
  }
}

/**
 * Recent runs whose event stream recorded PR artifacts — output that exists
 * and may not have landed. Landed (merged/closed) PRs are reconciled away at
 * read time (#1021); liveness checks are skipped under VITEST /
 * SQUADS_INBOX_NO_FETCH unless a runner is injected.
 */
export function scanRunsWithArtifacts(obsRoot: string, limit = 15, opts?: { run?: ShRunner }): InboxItem[] {
  const liveness: ShRunner | null =
    opts?.run ?? (process.env.VITEST || process.env.SQUADS_INBOX_NO_FETCH === '1' ? null : sh);
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
    const openRefs = liveness ? prRefs.filter((ref) => prStillOpen(ref, liveness)) : prRefs;
    if (openRefs.length === 0) continue; // every PR landed — resolved, not waiting (#1021)
    items.push({
      id: `run-${f.id}`,
      kind: 'run_artifacts',
      ref: f.id,
      title: `${squad || 'run'} produced ${openRefs.length} PR${openRefs.length > 1 ? 's' : ''}`,
      ageDays: ageDaysFrom(f.mtime),
      approveSemantics: `check landed state: squads runs --outcome ${f.id}`,
      detail: openRefs[0],
    });
  }
  return items;
}

/**
 * Run a validation script whose non-zero exit code IS the signal — these
 * scripts exit non-zero precisely when they find problems, which is the case
 * the caller wants to parse. Returns captured stdout either way; empty string
 * only when the script produced no output (missing, crashed, timed out).
 */
function runValidationScript(script: string, timeoutMs: number): string {
  try {
    return execSync(`bash ${script}`, {
      encoding: 'utf8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === 'string' ? stdout : '';
  }
}

/**
 * Machine-detected goal lifecycle events (hq#478). Reads goals.md across
 * squads and surfaces: achieved (all PR refs merged), contradicted (refs not
 * found), stale (no activity). Detection is from validate-goals.sh; this
 * scanner creates inbox items from its structured output.
 */
export function scanGoalEvents(obsRoot: string): InboxItem[] {
  const memoryDir = join(obsRoot, '.agents', 'memory');
  if (!existsSync(memoryDir)) return [];
  const items: InboxItem[] = [];
  let squadsDir = join(obsRoot, '.agents', 'squads');
  if (!existsSync(squadsDir)) squadsDir = join(dirname(obsRoot), '.agents', 'squads');
  if (!existsSync(squadsDir)) return [];
  try {
    const validateScript = join(squadsDir, '..', '..', 'scripts', 'validate-goals.sh');
    if (!existsSync(validateScript)) return [];
    const raw = runValidationScript(validateScript, 120_000);
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('✓')) continue;
      const reviewMatch = trimmed.match(/⤴ REVIEW.*:\s+(.+)/);
      if (reviewMatch) {
        items.push({
          id: `goal-${reviewMatch[1].slice(0, 40).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}`,
          kind: 'goal', ref: reviewMatch[1], title: `Goal achieved: ${reviewMatch[1].slice(0, 80)}`,
          ageDays: 0, approveSemantics: 'move to Achieved in goals.md',
          detail: 'all PR refs merged — appears complete',
        });
        continue;
      }
      const contraMatch = trimmed.match(/✗ CONTRADICTED:\s+(.+)/);
      if (contraMatch) {
        items.push({
          id: `goal-${contraMatch[1].slice(0, 40).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}`,
          kind: 'goal', ref: contraMatch[1], title: `Goal contradicted: ${contraMatch[1].slice(0, 80)}`,
          ageDays: 7, approveSemantics: 'keep as active',
          detail: 'refs not found or not merged — may need review or drop',
        });
      }
    }
  } catch {
    // validate-goals.sh unavailable — no goal items this cycle
  }
  return items;
}

/**
 * Coherence violations (hq#479). Surfaces strategy↔runtime mismatches.
 * If coherence-check.sh exists, delegates to it; otherwise derives from
 * SQUAD.md status vs strategy.md active list.
 */
export function scanCoherenceViolations(obsRoot: string): InboxItem[] {
  const coherenceScript = join(obsRoot, 'scripts', 'coherence-check.sh');
  if (!existsSync(coherenceScript)) {
    return deriveCoherenceFromStatus(obsRoot);
  }
  try {
    const raw = runValidationScript(coherenceScript, 30_000);
    if (!raw) return deriveCoherenceFromStatus(obsRoot);
    const items: InboxItem[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('FAIL:')) continue;
      const detail = trimmed.slice(5).trim();
      items.push({
        id: `coherence-${detail.slice(0, 30).replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()}`,
        kind: 'coherence', ref: detail, title: detail.slice(0, 100),
        ageDays: 0, approveSemantics: 'acknowledge (fix or accept drift)',
        detail: 'declarative state ≠ operational state — surfaced by coherence check',
      });
    }
    return items;
  } catch {
    return deriveCoherenceFromStatus(obsRoot);
  }
}

function deriveCoherenceFromStatus(obsRoot: string): InboxItem[] {
  const items: InboxItem[] = [];
  try {
    const strategyFile = join(obsRoot, '.agents', 'memory', 'company', 'strategy.md');
    const squadsDir = join(obsRoot, '.agents', 'squads');
    if (!existsSync(strategyFile) || !existsSync(squadsDir)) return items;
    const strategyText = readFileSync(strategyFile, 'utf8');
    const activeMatch = strategyText.match(/\*\*Active:\*\*\s*(.+)/);
    if (!activeMatch) return items;
    const strategyActive = activeMatch[1].split(',').map((s: string) => s.trim());
    const squads = readdirSync(squadsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const squad of squads) {
      const squadFile = join(squadsDir, squad, 'SQUAD.md');
      if (!existsSync(squadFile)) continue;
      const squadText = readFileSync(squadFile, 'utf8');
      const statusMatch = squadText.match(/^status:\s*(.+)/m);
      const runtimePaused = statusMatch && statusMatch[1].trim() === 'paused';
      const strategyActive_ = strategyActive.includes(squad);
      if (runtimePaused && strategyActive_) {
        items.push({
          id: `coherence-squad-${squad}`,
          kind: 'coherence', ref: squad,
          title: `${squad}: paused at runtime but strategy.md says Active`,
          ageDays: 0, approveSemantics: 'update strategy.md or squads resume',
          detail: `SQUAD.md status=paused, strategy.md lists as Active`,
        });
      }
    }
  } catch { /* derivation failed */ }
  return items;
}

/**
 * Oracle alerts — survival signals that crossed a threshold. GPS stale >3d,
 * lead silent >7d, coherence mismatch count >0. Reads from local state.
 */
export function scanOracleAlerts(obsRoot: string): InboxItem[] {
  const items: InboxItem[] = [];
  const gpsDir = join(obsRoot, 'data', 'intelligence');
  if (existsSync(gpsDir)) {
    try {
      const backups = readdirSync(gpsDir)
        .filter((f) => f.startsWith('gps.duckdb.backup.'))
        .sort().reverse();
      if (backups.length > 0) {
        const latestBackup = join(gpsDir, backups[0]);
        const mtime = statSync(latestBackup).mtimeMs;
        const daysStale = Math.floor((Date.now() - mtime) / 86400000);
        if (daysStale > 3) {
          items.push({
            id: 'oracle-gps-stale',
            kind: 'oracle_alert', ref: 'gps-freshness',
            title: `GPS data is ${daysStale}d stale — intelligence cadence at risk`,
            ageDays: daysStale,
            approveSemantics: 'acknowledge (dispatch GPS enrichment)',
            detail: `last ingestion: ${backups[0].replace('gps.duckdb.backup.', '')}`,
          });
        }
      }
    } catch { /* unavailable */ }
  }
  return items;
}

/**
 * Strategy proposals — machine-suggested direction from founder-alignment.md.
 * Draft items the founder can promote to goals or dismiss.
 */
export function scanStrategyProposals(obsRoot: string): InboxItem[] {
  const items: InboxItem[] = [];
  const memoryDir = join(obsRoot, '.agents', 'memory');
  if (!existsSync(memoryDir)) return items;
  try {
    for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const alignmentFile = join(memoryDir, entry.name, 'founder-alignment.md');
      if (!existsSync(alignmentFile)) continue;
      const text = readFileSync(alignmentFile, 'utf8').replace(/\r\n/g, '\n');
      const cycleMatch = text.match(/\*\*Suggested cycle output\*\*\n((?:\s*- .+\n?)+)/);
      if (!cycleMatch) continue;
      const suggestions = cycleMatch[1].split('\n').filter((l) => l.trim().startsWith('-'));
      for (const sug of suggestions.slice(0, 2)) {
        const title = sug.replace(/^-\s*/, '').trim();
        if (title.length < 10) continue;
        const idSuffix = title.slice(0, 20).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
        items.push({
          id: `proposal-${entry.name}-${idSuffix}`,
          kind: 'strategy_proposal', ref: `founder-alignment:${entry.name}`,
          title: `[${entry.name}] ${title.slice(0, 90)}`,
          ageDays: 0, approveSemantics: 'promote to goals.md for this squad',
          detail: 'from auto-generated founder-alignment — ready for review',
        });
      }
    }
  } catch { /* no proposals */ }
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
  const goals = scanGoalEvents(obsRoot);
  const coherence = scanCoherenceViolations(obsRoot);
  const oracleAlerts = scanOracleAlerts(obsRoot);
  const proposals = scanStrategyProposals(obsRoot);
  const all = [...prs, ...branches, ...runs, ...goals, ...coherence, ...oracleAlerts, ...proposals];
  if (opts?.includeDeferred) return all;
  const deferred = activeDeferrals(obsRoot);
  return deferred.size === 0 ? all : all.filter((i) => !deferred.has(i.id));
}
