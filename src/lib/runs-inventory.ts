/**
 * Detached-run inventory + control (hq#450 D4).
 *
 * Detached wrappers write `<agent>-<ts>.pid` files under
 * `.agents/logs/<squad>/` in the squad's TARGET repo. Until now nothing ever
 * read them back — no way to list live background runs, stop one, or notice
 * that one died mid-flight (sleep/crash) leaving worktrees and branches
 * behind.
 *
 * Inventory scans the dispatch project plus every squad's bound repo
 * (SQUAD.md `repo:` → sibling dir). Liveness = signal 0. A pid file whose
 * process is gone is STALE: if its run worktree still exists the run died
 * in flight — salvage the work (harvest) and synthesize a failed record;
 * otherwise it's just a leftover pid file from before pid-file cleanup
 * existed, and is removed silently.
 *
 * Killing is graceful by design: TERM the wrapper's CHILDREN (the executor),
 * not the wrapper — the wrapper then finishes its own harvest + spool, so a
 * killed run still keeps its work and still reports (same principle as the
 * watchdog).
 */
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { execSync } from 'child_process';
import { findSquadsDir, listSquads, loadSquad } from './squad-parser.js';
import { resolveOwnedRepoRoots, harvestProviderWork } from './execution-engine.js';
import { logObservability, type ObservabilityRecord } from './observability.js';
import { reportExecutionComplete } from './api-client.js';

export interface DetachedRun {
  squad: string;
  agent: string;
  /** Wrapper start timestamp (ms) parsed from the pid-file name. */
  startedAt: number;
  pid: number;
  pidFile: string;
  logFile: string;
  repoRoot: string;
  alive: boolean;
  /**
   * This run's API execution id, when the wrapper recorded one (#1131) — the
   * pid file's optional second line. Absent for pre-#1131 wrappers still on
   * disk; cleanStaleRuns then just can't report the lane death to the API.
   */
  executionId?: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** All repos that detached runs may have been routed to: dispatch root + every squad's bound repo. */
export function inventoryRoots(projectRoot: string): string[] {
  const roots = new Set<string>([resolve(projectRoot)]);
  try {
    const squadsDir = findSquadsDir();
    if (squadsDir) {
      for (const name of listSquads(squadsDir)) {
        try {
          for (const root of resolveOwnedRepoRoots(projectRoot, loadSquad(name))) {
            roots.add(resolve(root));
          }
        } catch { /* unresolvable squad repo — skip */ }
      }
    }
  } catch { /* outside a squads project — dispatch root only */ }
  return [...roots];
}

/** Scan pid files across roots and classify them by liveness. */
export function listDetachedRuns(projectRoot: string): DetachedRun[] {
  const runs: DetachedRun[] = [];
  for (const root of inventoryRoots(projectRoot)) {
    const logsDir = join(root, '.agents', 'logs');
    if (!existsSync(logsDir)) continue;
    let squadDirs: string[];
    try {
      squadDirs = readdirSync(logsDir).filter((d) => {
        try { return statSync(join(logsDir, d)).isDirectory(); } catch { return false; }
      });
    } catch { continue; }
    for (const squad of squadDirs) {
      const dir = join(logsDir, squad);
      let pidFiles: string[];
      try {
        pidFiles = readdirSync(dir).filter((f) => f.endsWith('.pid'));
      } catch { continue; }
      for (const f of pidFiles) {
        const m = f.match(/^(.+)-(\d+)\.pid$/);
        if (!m) continue;
        const pidFile = join(dir, f);
        let pid: number;
        let executionId: string | undefined;
        try {
          const [pidLine, execIdLine] = readFileSync(pidFile, 'utf8').split('\n');
          pid = parseInt((pidLine || '').trim(), 10);
          executionId = execIdLine?.trim() || undefined;
        } catch { continue; }
        if (!Number.isInteger(pid) || pid <= 1) continue;
        runs.push({
          squad,
          agent: m[1],
          startedAt: parseInt(m[2], 10),
          pid,
          pidFile,
          logFile: pidFile.replace(/\.pid$/, '.log'),
          repoRoot: root,
          alive: isAlive(pid),
          executionId,
        });
      }
    }
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

export interface StaleCleanupResult {
  removedPidFiles: number;
  salvaged: Array<{ squad: string; agent: string; outcome: string }>;
}

/**
 * Clean stale pid files; salvage crashed-in-flight runs.
 *
 * A stale pid file with its run worktree still present means the wrapper
 * died before harvest — attempt the harvest now (same engine path), write a
 * synthesized failed record (the run never spooled), then drop the pid file.
 * Stale pid files without a worktree are pre-PR3 leftovers from completed
 * runs — removed without synthesizing anything (their runs may already have
 * records; inventing one would double-count).
 */
export async function cleanStaleRuns(projectRoot: string): Promise<StaleCleanupResult> {
  const result: StaleCleanupResult = { removedPidFiles: 0, salvaged: [] };
  for (const run of listDetachedRuns(projectRoot)) {
    if (run.alive) continue;
    const worktree = join(run.repoRoot, '..', '.worktrees', `${run.squad}-${run.agent}-${run.startedAt}`);
    const branch = `agent/${run.squad}/${run.agent}-${run.startedAt}`;
    if (existsSync(worktree)) {
      let outcome = 'salvage-failed';
      try {
        const harvest = await harvestProviderWork(worktree, run.repoRoot, branch, {
          squadName: run.squad, agentName: run.agent, provider: 'unknown',
        });
        outcome = harvest.outcome;
      } catch { /* recorded below either way */ }
      const errorMsg = `orphaned: wrapper died before reporting; worktree salvage: ${outcome}`;
      const record: ObservabilityRecord = {
        ts: new Date().toISOString(),
        id: `orphan_${run.squad}_${run.agent}_${run.startedAt}`,
        squad: run.squad,
        agent: run.agent,
        provider: 'unknown',
        model: 'unknown',
        trigger: 'manual',
        status: 'failed',
        duration_ms: 0,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
        cost_usd: 0, context_tokens: 0,
        error: errorMsg,
      };
      try { logObservability(record); } catch { /* best effort */ }
      // Backstop (#1131): the wrapper died before it ever reached the spool
      // writer, so this is the ONLY chance the API's execution row hears
      // about it — without this it sits at 'running' forever. Only fires
      // when the wrapper recorded its execution id (pid file line 2);
      // fire-and-forget, same as every other API report in this codebase.
      if (run.executionId) {
        void reportExecutionComplete(run.executionId, 'failed', { error: errorMsg });
      }
      result.salvaged.push({ squad: run.squad, agent: run.agent, outcome });
    }
    try {
      unlinkSync(run.pidFile);
      result.removedPidFiles++;
    } catch { /* next sweep retries */ }
  }
  return result;
}

export interface KillResult {
  squad: string;
  agent: string;
  pid: number;
  method: 'children-term' | 'wrapper-term' | 'not-running';
}

function childPids(pid: number): number[] {
  try {
    return execSync(`pgrep -P ${pid}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim().split('\n').filter(Boolean).map((l) => parseInt(l, 10)).filter((n) => Number.isInteger(n));
  } catch {
    return []; // pgrep exits 1 when no children
  }
}

/**
 * Stop a detached run gracefully: TERM the wrapper's children (the executor)
 * so the wrapper itself completes harvest + spool. Only when the wrapper has
 * no children (executor already gone, wrapper itself stuck) is the wrapper
 * TERM'd directly.
 */
export function killDetachedRun(run: DetachedRun): KillResult {
  if (!run.alive) return { squad: run.squad, agent: run.agent, pid: run.pid, method: 'not-running' };
  const children = childPids(run.pid);
  if (children.length > 0) {
    for (const child of children) {
      try { process.kill(child, 'SIGTERM'); } catch { /* already gone */ }
    }
    return { squad: run.squad, agent: run.agent, pid: run.pid, method: 'children-term' };
  }
  try { process.kill(run.pid, 'SIGTERM'); } catch { /* already gone */ }
  return { squad: run.squad, agent: run.agent, pid: run.pid, method: 'wrapper-term' };
}
