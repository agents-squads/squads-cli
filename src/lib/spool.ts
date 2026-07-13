/**
 * Detached-run containment, part 1 (hq#450 D1+D2).
 *
 * Detached executions (`--background`, `--watch`, scheduled spawns) outlive
 * the CLI process, so nothing used to record them — no ObservabilityRecord,
 * no terminal status, invisible to `squads usage` and budget enforcement.
 *
 * Design: the wrapper shell records facts (crash-proof, atomic mv); the next
 * CLI invocation interprets them. `buildSpoolWriterShell()` emits the shell
 * snippet both detached wrappers append after the executor exits; it writes
 * `.agents/observability/spool/<executionId>.json`. `reconcileDetachedRuns()`
 * sweeps the spool from the read paths (status / usage / exec / run startup),
 * turning each done-file into a real ObservabilityRecord with usage parsed
 * from the run's log (provider runs: the executor's printed usage via
 * `parseUsage`; claude runs: the session JSONL window).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { getCLIConfig, detectProviderFatalError } from './llm-clis.js';
import {
  logObservability,
  captureSessionUsage,
  captureSessionUsageById,
  type ObservabilityRecord,
} from './observability.js';
import { updateExecutionStatus } from './execution-log.js';
import { parseStreamJson } from './stream-json.js';
import { normalizeDetachedLog } from './exec-events.js';
import { reportExecutionComplete } from './api-client.js';

/** Tail cap when parsing executor logs — matches the #826 live-stream buffer. */
const LOG_TAIL_CAP_BYTES = 256 * 1024;

/**
 * Read cap for a detached claude run's raw stream-json log (#902). Larger than
 * the provider tail cap because the event stream's early lines carry the run's
 * tool activity; the terminal `result` event sits at the end, so tail-reading
 * keeps it when a log exceeds the cap.
 */
const STREAM_LOG_CAP_BYTES = 16 * 1024 * 1024;

export interface SpoolRecord {
  execId: string;
  squad: string;
  agent: string;
  provider: string;
  model: string;
  trigger: string;
  logFile: string;
  startEpoch: number;
  endEpoch: number;
  exitCode: number;
  /** 'merged' | 'preserved' | 'none' — provider harvest outcome, '' for claude runs */
  harvest: string;
  /** Watchdog fired (hq#450 D3) — run was reaped at its deadline. */
  timedOut?: boolean;
  /**
   * Claude session id the run was launched with (`--session-id`, #857).
   * Lets reconcile read exactly this run's session JSONL instead of guessing
   * by time window — concurrent runs each attributed the whole machine's
   * usage before this. Empty/absent on provider runs and legacy spools.
   */
  sessionId?: string;
}

export function spoolDir(obsRoot: string): string {
  return join(obsRoot, '.agents', 'observability', 'spool');
}

export function ensureSpoolDir(obsRoot: string): string {
  const dir = spoolDir(obsRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Shell snippet appended to a detached wrapper AFTER the executor has exited.
 * Expects `$EXIT` (executor exit code) and `$START` (start epoch, seconds) to
 * be set by the wrapper; `$HARVEST` is optional. Writes the done-file
 * atomically (tmp + mv) so a half-written record can never be ingested.
 *
 * All identity fields are embedded at build time — they are CLI-generated
 * (executionId, squad/agent names, paths), not user input, but single quotes
 * are stripped defensively to keep the snippet unbreakable.
 */
export function buildSpoolWriterShell(fields: {
  obsRoot: string;
  execId: string;
  squad: string;
  agent: string;
  provider: string;
  model: string;
  trigger: string;
  logFile: string;
  /** Watchdog flag file (hq#450 D3); when present at spool time → timedOut:true, then removed. */
  timeoutFlag?: string;
  /** Claude session id the executor was launched with (#857) — '' for provider runs. */
  sessionId?: string;
}): string {
  const q = (s: string) => s.replace(/'/g, '');
  // execIds are CLI-generated, but the done-file name and embedded id are
  // sanitized to [A-Za-z0-9_-] as defense in depth.
  const safeId = fields.execId.replace(/[^A-Za-z0-9_-]/g, '');
  const dir = spoolDir(fields.obsRoot);
  const file = join(dir, `${safeId}.json`);
  const timedOutExpr = fields.timeoutFlag
    ? `"$([ -f '${q(fields.timeoutFlag)}' ] && echo true || echo false)"`
    : `"false"`;
  const flagCleanup = fields.timeoutFlag ? `; rm -f '${q(fields.timeoutFlag)}'` : '';
  // printf %s with embedded JSON skeleton; EXIT/START/HARVEST interpolated by sh.
  return (
    `; mkdir -p '${dir}'` +
    `; SPOOL_TMP=$(mktemp '${dir}/.tmp.XXXXXX')` +
    `; printf '{"execId":"%s","squad":"%s","agent":"%s","provider":"%s","model":"%s","trigger":"%s","logFile":"%s","sessionId":"${q(fields.sessionId || '').replace(/[^A-Za-z0-9-]/g, '')}","startEpoch":%s,"endEpoch":%s,"exitCode":%s,"harvest":"%s","timedOut":%s}' ` +
    `'${safeId}' '${q(fields.squad)}' '${q(fields.agent)}' '${q(fields.provider)}' '${q(fields.model)}' '${q(fields.trigger)}' '${q(fields.logFile)}' ` +
    `"\${START:-0}" "$(date +%s)" "\${EXIT:-1}" "\${HARVEST:-}" ${timedOutExpr} > "$SPOOL_TMP"` +
    `; mv "$SPOOL_TMP" '${file}'${flagCleanup}`
  );
}

/**
 * Watchdog wrapper for a detached executor command (hq#450 D3).
 *
 * Runs the executor in the background and arms a killer subshell: at the
 * deadline it touches the timeout flag, TERMs the executor, and after a grace
 * period KILLs it. Crucially it targets the executor's PID only — never the
 * process group — so the wrapper survives to run harvest + spool (the whole
 * point of containment is that a killed run still reports and keeps its work).
 *
 * The watchdog subshell's stdio is detached to /dev/null; otherwise its
 * orphaned `sleep` would inherit the wrapper's descriptors and keep pipes
 * open long after the run finished.
 *
 * Leaves `$EXIT` set to the executor's exit code (143/137 when reaped).
 * Evidence this is needed: a live aider executor finished its work, then
 * deadlocked without a TTY and held its worktree forever at 0% CPU.
 */
export function buildWatchdogShell(executorCmd: string, timeoutSecs: number, timeoutFlag: string): string {
  const flag = timeoutFlag.replace(/'/g, '');
  const KILL_GRACE_SECS = 10;
  return (
    `${executorCmd} & EXEC_PID=$!` +
    `; ( sleep ${Math.max(1, Math.floor(timeoutSecs))}; touch '${flag}'; kill -TERM $EXEC_PID 2>/dev/null; sleep ${KILL_GRACE_SECS}; kill -9 $EXEC_PID 2>/dev/null ) > /dev/null 2>&1 & WATCH_PID=$!` +
    `; wait $EXEC_PID; EXIT=$?` +
    `; kill $WATCH_PID 2>/dev/null; wait $WATCH_PID 2>/dev/null`
  );
}

function readLogTail(logFile: string, capBytes: number = LOG_TAIL_CAP_BYTES): string {
  try {
    const size = statSync(logFile).size;
    const start = Math.max(0, size - capBytes);
    const fd = openSync(logFile, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function toRecord(spool: SpoolRecord, obsRoot: string): ObservabilityRecord {
  const durationMs = spool.endEpoch > spool.startEpoch && spool.startEpoch > 0
    ? (spool.endEpoch - spool.startEpoch) * 1000
    : 0;
  let status: ObservabilityRecord['status'] = spool.timedOut
    ? 'timeout'
    : spool.exitCode === 0 ? 'completed' : 'failed';
  let fatalError: string | undefined;

  let input = 0, output = 0, cost = 0, cacheRead = 0, cacheWrite = 0;
  let model = spool.model || 'unknown';
  let outcomes: ReturnType<typeof parseStreamJson>['outcomes'] | undefined;

  if (spool.provider && spool.provider !== 'anthropic') {
    const tail = spool.logFile ? readLogTail(spool.logFile) : '';
    // #936: providers exit 0 after printing fatal API errors — never credit
    // a failed run as completed in the ledger the scoreboard reads.
    const fatal = tail ? detectProviderFatalError(tail) : null;
    if (fatal && status === 'completed') {
      status = 'failed';
      fatalError = fatal;
    }
    const parse = getCLIConfig(spool.provider)?.parseUsage;
    if (parse && tail) {
      const usage = parse(tail);
      if (usage) {
        input = usage.input_tokens;
        output = usage.output_tokens;
        cost = usage.cost_usd;
      }
    }
  } else {
    // Claude run: the log IS the raw stream-json event stream (#902) — parse
    // it for what the agent actually DID (outcomes, previously always zero on
    // detached runs) and as the usage fallback; normalize it into the run's
    // events file so the black box stays killed after the log rotates.
    const rawLog = spool.logFile ? readLogTail(spool.logFile, STREAM_LOG_CAP_BYTES) : '';
    const stream = rawLog ? parseStreamJson(rawLog) : null;
    if (stream && stream.outcomes.actions > 0) outcomes = stream.outcomes;

    // Exact session-id attribution when the wrapper recorded one (#857);
    // legacy fallback = mtime-window scan BOUNDED by endEpoch so a session
    // still active after this run can't absorb the attribution.
    const session = spool.sessionId
      ? captureSessionUsageById(spool.sessionId)
      : spool.startEpoch > 0
        ? captureSessionUsage(spool.startEpoch * 1000, spool.endEpoch > 0 ? spool.endEpoch * 1000 : undefined)
        : null;
    if (session) {
      input = session.input_tokens;
      output = session.output_tokens;
      cost = session.cost_usd;
      cacheRead = session.cache_read_tokens || 0;
      cacheWrite = session.cache_write_tokens || 0;
      if (session.model) model = session.model;
    } else if (stream && stream.sawResult) {
      // No session JSONL visible — the stream's terminal result event still
      // carries the run's canonical usage (incl. cache), so use it.
      input = stream.usage.input_tokens;
      output = stream.usage.output_tokens;
      cost = stream.usage.cost_usd;
      cacheRead = stream.usage.cache_read_tokens;
      cacheWrite = stream.usage.cache_write_tokens;
      if (stream.usage.model) model = stream.usage.model;
    }

    if (rawLog) {
      try {
        normalizeDetachedLog(rawLog, obsRoot, spool.execId, spool.agent, {
          type: 'run_end',
          ok: status === 'completed',
          durationMs,
          totalUsage: { input, output, cacheRead, cacheWrite, costEst: cost },
          outcomes,
        });
      } catch { /* events are best-effort; the obs record below is the source of truth */ }
    }
  }

  return {
    ts: new Date(spool.endEpoch > 0 ? spool.endEpoch * 1000 : Date.now()).toISOString(),
    id: spool.execId,
    squad: spool.squad,
    agent: spool.agent,
    provider: spool.provider || 'anthropic',
    model,
    trigger: (spool.trigger || 'manual') as ObservabilityRecord['trigger'],
    status,
    duration_ms: durationMs,
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    cost_usd: cost,
    context_tokens: 0,
    ...(outcomes ? {
      actions: outcomes.actions,
      files_edited: outcomes.files_edited,
      commits: outcomes.commits,
      prs_created: outcomes.prs_created,
      issues_created: outcomes.issues_created,
    } : {}),
    error: spool.timedOut
      ? `detached run reaped by watchdog after ${Math.round(durationMs / 60000)} min`
      : fatalError ?? (spool.exitCode !== 0 ? `detached run exited with code ${spool.exitCode}` : undefined),
  };
}

/**
 * Sweep the spool: every done-file becomes an ObservabilityRecord + a
 * terminal execution status, then is deleted. Idempotent, silent when the
 * spool is empty, never throws (read paths must not break on a bad record —
 * a malformed file is renamed aside instead of retried forever).
 *
 * Returns the number of runs ingested.
 */
export function reconcileDetachedRuns(obsRoot: string): number {
  const dir = spoolDir(obsRoot);
  if (!existsSync(dir)) return 0;

  let ingested = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const path = join(dir, entry);
    try {
      const spool = JSON.parse(readFileSync(path, 'utf8')) as SpoolRecord;
      const record = toRecord(spool, obsRoot);
      logObservability(record);
      try {
        updateExecutionStatus(spool.squad, spool.agent, spool.execId, record.status === 'completed' ? 'completed' : 'failed', {
          outcome: `Detached run reconciled (${record.input_tokens} in / ${record.output_tokens} out, $${record.cost_usd.toFixed(4)})`,
          durationMs: record.duration_ms,
          error: record.error,
        });
      } catch { /* status ledger is best-effort; the obs record is the source of truth */ }

      // Report terminal status to API for background runs (#1100)
      // Fire-and-forget: never block reconcile on API reachability
      void reportExecutionComplete(spool.execId, record.status === 'completed' ? 'completed' : 'failed', {
        summary: `Detached run reconciled (${record.input_tokens} in / ${record.output_tokens} out, $${record.cost_usd.toFixed(4)})`,
        error: record.error,
        durationMs: record.duration_ms,
      });

      unlinkSync(path);
      ingested++;
    } catch {
      // Malformed/unreadable — quarantine so the sweep never loops on it.
      try { unlinkSync(path); } catch { /* leave it; next sweep retries */ }
    }
  }
  return ingested;
}
