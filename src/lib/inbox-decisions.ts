/**
 * inbox-decisions.ts — the decision verbs of the review queue (#933, Child A).
 *
 * Founder decisions locked 2026-07-05 (hq spec review-queue-2026-07-01.md):
 *   1. approve authority = the EXISTING auto-merge path (CI-gated `--auto`);
 *      the inbox changes discovery, not authority.
 *   2. reject on a branch = archive tag, THEN delete — refs stay clean,
 *      nothing is unrecoverable.
 *   3. v1 scope = PRs + run branches; run_artifacts items stay pointers.
 *
 * Decisions land in an append-only ledger (`reviewed.jsonl`) next to
 * `executions.jsonl`. Sources remain scanners — the ledger records only what
 * a human decided, never queue state that could drift.
 */

import { execSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { userInfo } from 'os';
import { dirname, join } from 'path';
import type { InboxItem } from './inbox.js';
import { appendFeedbackEntry } from './feedback-store.js';
import { loadSession } from './auth.js';

/** Injectable command runner so tests never hit gh/network. */
export type CommandRunner = (cmd: string, cwd: string) => string;

const defaultRun: CommandRunner = (cmd, cwd) =>
  execSync(cmd, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });

export interface InboxDecisionRecord {
  v: 1;
  ts: string;
  id: string;
  kind: InboxItem['kind'];
  ref: string;
  decision: 'approve' | 'reject' | 'defer';
  /** Rejection reason (written through to squads feedback) / defer note. */
  reason?: string;
  /** Defer expiry (ISO); the list hides the item until then. */
  until?: string;
  /** What concretely happened (merge queued / tag created / PR closed). */
  result: string;
  /** Who decided (C1a, company-os §Identity): login email, OS user, or the
   *  actor a bridge passes through from another decision surface. */
  by?: string;
}

export interface DecisionContext {
  repoRoot: string;
  obsRoot: string;
  run?: CommandRunner;
  /** Injectable feedback write-through (defaults to squads feedback append). */
  feedbackWriter?: (squad: string, rating: number, text: string) => boolean;
  /** Decision actor override (`--by`) — a bridge executing an API decision
   *  passes the real decider; otherwise the local operator is stamped. */
  by?: string;
}

export interface DecisionOutcome {
  ok: boolean;
  message: string;
}

export function reviewedLedgerPath(obsRoot: string): string {
  return join(obsRoot, '.agents', 'observability', 'reviewed.jsonl');
}

/** Local operator identity: `squads login` email when a session exists, else
 *  the OS user. Never throws — attribution must not block a decision. */
export function operatorIdentity(): string {
  try {
    const email = loadSession()?.email;
    if (email) return email;
  } catch {
    // fall through to OS user
  }
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

export function readDecisions(obsRoot: string): InboxDecisionRecord[] {
  const path = reviewedLedgerPath(obsRoot);
  if (!existsSync(path)) return [];
  const records: InboxDecisionRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as InboxDecisionRecord;
      if (rec && rec.v === 1 && rec.id && rec.decision) records.push(rec);
    } catch {
      // a corrupt line never takes the ledger down
    }
  }
  return records;
}

export function recordDecision(obsRoot: string, rec: InboxDecisionRecord): void {
  const path = reviewedLedgerPath(obsRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(rec) + '\n');
}

/**
 * Item ids currently snoozed: the LATEST decision for the id is a defer whose
 * `until` is still in the future. An approve/reject after a defer un-snoozes.
 */
export function activeDeferrals(obsRoot: string, now = Date.now()): Set<string> {
  const latest = new Map<string, InboxDecisionRecord>();
  for (const rec of readDecisions(obsRoot)) latest.set(rec.id, rec);
  const deferred = new Set<string>();
  for (const [id, rec] of latest) {
    if (rec.decision === 'defer' && rec.until && Date.parse(rec.until) > now) deferred.add(id);
  }
  return deferred;
}

/** `squads/run-<squad>-<runId>-<n>` or `agent/<squad>/<agent>-<ts>` → squad. */
export function squadFromBranch(branch: string): string | undefined {
  const agentMatch = branch.match(/^agent\/([^/]+)\//);
  if (agentMatch) return agentMatch[1];
  const runMatch = branch.match(/^squads\/run-(.+)-[a-z0-9]+-\d+$/);
  if (runMatch) return runMatch[1];
  return undefined;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function remoteHasBranch(branch: string, repoRoot: string, run: CommandRunner): boolean {
  try {
    return run(`git ls-remote --heads origin ${shq(branch)}`, repoRoot).trim().length > 0;
  } catch {
    return false;
  }
}

function repoHasDevelop(repoRoot: string, run: CommandRunner): boolean {
  try {
    run('git rev-parse --verify --quiet origin/develop', repoRoot);
    return true;
  } catch {
    try {
      run('git rev-parse --verify --quiet develop', repoRoot);
      return true;
    } catch {
      return false;
    }
  }
}

/** No `origin` remote at all — the solo, no-infra repo (#979). */
function hasOrigin(repoRoot: string, run: CommandRunner): boolean {
  try {
    run('git remote get-url origin', repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** `gh` CLI missing/unauthenticated — same graceful-degradation trigger as no origin (#979). */
function hasWorkingGh(repoRoot: string, run: CommandRunner): boolean {
  try {
    run('gh auth status', repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** Local trunk to land into when there's no remote to ask (#979): `develop` if it
 *  exists locally, else whatever branch is currently checked out. */
function resolveLocalTrunk(repoRoot: string, run: CommandRunner): string {
  if (repoHasDevelop(repoRoot, run)) return 'develop';
  try {
    return run('git rev-parse --abbrev-ref HEAD', repoRoot).trim() || 'HEAD';
  } catch {
    return 'HEAD';
  }
}

/**
 * approve — executes the item's approve semantics through the EXISTING paths:
 *  - pr: queue the CI-gated auto-merge (`gh pr merge --squash --delete-branch
 *    --auto`); when the repo has no auto-merge (no protection), fall back to a
 *    plain squash merge — CI wasn't gating there anyway.
 *  - run_branch: push if needed, open a PR from the branch, queue auto-merge.
 *    No origin remote or no working `gh` (#979, solo no-infra journey): land
 *    locally instead — `git merge --squash` + commit into the repo's trunk,
 *    then delete the run branch. Nothing assumes GitHub exists.
 *  - run_artifacts: not a v1 verb — those items are pointers to `runs --outcome`.
 */
export function approveItem(item: InboxItem, ctx: DecisionContext): DecisionOutcome {
  const run = ctx.run ?? defaultRun;
  let outcome: DecisionOutcome;

  if (item.kind === 'pr') {
    const number = item.id.replace(/^pr-/, '');
    outcome = mergePr(number, item.ref, ctx.repoRoot, run);
  } else if (item.kind === 'run_branch') {
    outcome = approveBranch(item.ref, ctx.repoRoot, run);
  } else {
    return {
      ok: false,
      message: `run items are pointers, not approvables (v1 = PRs + branches) — inspect with: squads runs --outcome ${item.ref}`,
    };
  }

  recordDecision(ctx.obsRoot, {
    v: 1, ts: new Date().toISOString(), id: item.id, kind: item.kind, ref: item.ref,
    decision: 'approve', result: outcome.message, by: ctx.by ?? operatorIdentity(),
  });
  return outcome;
}

function mergePr(number: string, url: string, repoRoot: string, run: CommandRunner): DecisionOutcome {
  try {
    run(`gh pr merge ${shq(number)} --squash --delete-branch --auto`, repoRoot);
    return { ok: true, message: `auto-merge queued (CI-gated) for ${url}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/auto.?merge is not allowed/i.test(msg)) {
      try {
        run(`gh pr merge ${shq(number)} --squash --delete-branch`, repoRoot);
        return { ok: true, message: `merged ${url} (repo has no auto-merge; plain squash)` };
      } catch (e2) {
        return { ok: false, message: `merge failed: ${e2 instanceof Error ? e2.message : String(e2)}` };
      }
    }
    return { ok: false, message: `merge failed: ${msg}` };
  }
}

function approveBranch(branch: string, repoRoot: string, run: CommandRunner): DecisionOutcome {
  if (!hasOrigin(repoRoot, run) || !hasWorkingGh(repoRoot, run)) {
    return mergeBranchLocally(branch, repoRoot, run);
  }
  try {
    if (!remoteHasBranch(branch, repoRoot, run)) {
      run(`git push -u origin ${shq(branch)}`, repoRoot);
    }
    const base = repoHasDevelop(repoRoot, run) ? 'develop' : '';
    const baseFlag = base ? `--base ${base} ` : '';
    const url = run(
      `gh pr create ${baseFlag}--head ${shq(branch)} --title ${shq(`land stranded run deliverable: ${branch}`)} --body ${shq('Landed via `squads inbox approve` (review-queue Child A, #933). Auto-committed run deliverable (#875) a human decided to keep.')}`,
      repoRoot,
    ).trim().split('\n').pop() ?? '';
    const prNumber = url.match(/\/pull\/(\d+)/)?.[1];
    if (prNumber) {
      const merge = mergePr(prNumber, url, repoRoot, run);
      return { ok: merge.ok, message: `PR opened from ${branch}: ${url} — ${merge.message}` };
    }
    return { ok: true, message: `PR opened from ${branch}: ${url}` };
  } catch (e) {
    return { ok: false, message: `could not land ${branch}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** No GitHub remote/`gh` (#979): squash-merge the run branch into the local
 *  trunk directly, so a solo no-infra user can still land what they can see. */
function mergeBranchLocally(branch: string, repoRoot: string, run: CommandRunner): DecisionOutcome {
  const trunk = resolveLocalTrunk(repoRoot, run);
  try {
    const current = run('git rev-parse --abbrev-ref HEAD', repoRoot).trim();
    if (current !== trunk) run(`git checkout ${shq(trunk)}`, repoRoot);
    run(`git merge --squash ${shq(branch)}`, repoRoot);
    run(`git commit -m ${shq(`land stranded run deliverable: ${branch}`)}`, repoRoot);
    run(`git branch -D ${shq(branch)}`, repoRoot);
    return { ok: true, message: `merged locally to ${trunk} (no GitHub remote/gh — squash-merged, ${branch} deleted)` };
  } catch (e) {
    return {
      ok: false,
      message: `local merge into ${trunk} failed (branch kept, ${trunk} left as-is — resolve any conflict manually, or 'git reset --hard' to discard): ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * reject — closes/archives the artifact AND writes the reason through to
 * `squads feedback`, so the squad's next context injection carries the
 * correction (this write-through is what makes rejection cheap, not wasteful).
 *  - pr: close with the reason as a comment, delete the head branch.
 *  - run_branch: tag `archive/<branch>` (recoverable forever), then delete
 *    local + best-effort remote.
 */
export function rejectItem(item: InboxItem, reason: string, ctx: DecisionContext): DecisionOutcome {
  const run = ctx.run ?? defaultRun;
  let outcome: DecisionOutcome;
  let squad: string | undefined;

  if (item.kind === 'pr') {
    const number = item.id.replace(/^pr-/, '');
    try {
      run(`gh pr close ${shq(number)} --comment ${shq(`Rejected via squads inbox: ${reason}`)} --delete-branch`, ctx.repoRoot);
      outcome = { ok: true, message: `closed ${item.ref} (reason recorded)` };
    } catch (e) {
      outcome = { ok: false, message: `close failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  } else if (item.kind === 'run_branch') {
    squad = squadFromBranch(item.ref);
    outcome = archiveBranch(item.ref, ctx.repoRoot, run);
  } else {
    return {
      ok: false,
      message: `run items are pointers, not rejectables (v1 = PRs + branches) — inspect with: squads runs --outcome ${item.ref}`,
    };
  }

  if (outcome.ok && squad) {
    const writer = ctx.feedbackWriter ?? appendFeedbackEntry;
    const wrote = writer(squad, 2, `inbox reject (${item.ref}): ${reason}`);
    if (!wrote) outcome = { ok: true, message: `${outcome.message} · feedback write-through skipped (no memory dir for '${squad}')` };
  }

  recordDecision(ctx.obsRoot, {
    v: 1, ts: new Date().toISOString(), id: item.id, kind: item.kind, ref: item.ref,
    decision: 'reject', reason, result: outcome.message, by: ctx.by ?? operatorIdentity(),
  });
  return outcome;
}

function archiveBranch(branch: string, repoRoot: string, run: CommandRunner): DecisionOutcome {
  const tag = `archive/${branch}`;
  try {
    // Lightweight tag (no -a) — creates a ref only, no tag object/author, so
    // it never needs a git identity (#980 audit: verified, no fallback needed).
    run(`git tag ${shq(tag)} ${shq(branch)}`, repoRoot);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/already exists/i.test(msg)) return { ok: false, message: `archive tag failed (branch kept): ${msg}` };
  }
  // Best-effort remote archive + delete — a local-only branch is fine.
  if (remoteHasBranch(branch, repoRoot, run)) {
    try { run(`git push origin ${shq(tag)}`, repoRoot); } catch { /* tag may exist remotely */ }
    try { run(`git push origin --delete ${shq(branch)}`, repoRoot); } catch { /* remote delete is best-effort */ }
  }
  try {
    run(`git branch -D ${shq(branch)}`, repoRoot);
  } catch (e) {
    return { ok: false, message: `archived as ${tag} but local delete failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, message: `archived as tag ${tag}, branch deleted (recover: git checkout -b ${branch} ${tag})` };
}

/** defer — snooze the item; it resurfaces after `days` (ledger-only, nothing mutated). */
export function deferItem(item: InboxItem, days: number, ctx: DecisionContext): DecisionOutcome {
  const d = Number.isFinite(days) && days > 0 ? days : 7;
  const until = new Date(Date.now() + d * 24 * 60 * 60 * 1000).toISOString();
  recordDecision(ctx.obsRoot, {
    v: 1, ts: new Date().toISOString(), id: item.id, kind: item.kind, ref: item.ref,
    decision: 'defer', until, result: `snoozed ${d}d (resurfaces ${until.slice(0, 10)})`,
    by: ctx.by ?? operatorIdentity(),
  });
  return { ok: true, message: `deferred ${d}d — resurfaces ${until.slice(0, 10)}` };
}
