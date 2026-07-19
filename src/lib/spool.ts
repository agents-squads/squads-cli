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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, openSync, readSync, closeSync, renameSync } from 'fs';
import { join } from 'path';
import { getCLIConfig, detectProviderFatalError } from './llm-clis.js';
import {
  logObservability,
  captureSessionUsage,
  captureSessionUsageById,
  type ObservabilityRecord,
} from './observability.js';
import { updateExecutionStatus } from './execution-log.js';
import { parseStreamJson, parseOpencodeJson } from './stream-json.js';
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

/** Cap on the agent's final message reported to the API as result.summary (#1131). */
const RESULT_SUMMARY_MAX_CHARS = 1000;

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
  /** 'preserved' | 'none' — provider harvest outcome (preserve-only, #1126), '' for claude runs */
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
  /**
   * Executor harness the run went through (#1177): 'claude' (Claude Code —
   * claude/glm/deepseek/kimi/gpt lanes), 'opencode' (`opencode run`).
   * Reconcile picks the stream parser + event adapter by THIS, not by
   * provider — the same provider can run through either harness.
   * Empty/absent on legacy spools and non-stream provider CLIs (aider).
   */
  harness?: string;
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
  /** Executor harness (#1177): 'claude' | 'opencode' | '' (non-stream provider CLIs). */
  harness?: string;
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
    `; printf '{"execId":"%s","squad":"%s","agent":"%s","provider":"%s","model":"%s","trigger":"%s","logFile":"%s","sessionId":"${q(fields.sessionId || '').replace(/[^A-Za-z0-9-]/g, '')}","harness":"${(fields.harness || '').replace(/[^a-z-]/g, '')}","startEpoch":%s,"endEpoch":%s,"exitCode":%s,"harvest":"%s","timedOut":%s}' ` +
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

function toRecord(spool: SpoolRecord, obsRoot: string): { record: ObservabilityRecord; resultSummary?: string } {
  const durationMs = spool.endEpoch > spool.startEpoch && spool.startEpoch > 0
    ? (spool.endEpoch - spool.startEpoch) * 1000
    : 0;
  let status: ObservabilityRecord['status'] = spool.timedOut
    ? 'timeout'
    : spool.exitCode === 0 ? 'completed' : 'failed';
  let fatalError: string | undefined;
  /** Agent's final message, when the stream carried one (#1131 result.summary). */
  let resultSummary: string | undefined;

  let input = 0, output = 0, cost = 0, cacheRead = 0, cacheWrite = 0;
  let model = spool.model || 'unknown';
  let outcomes: ReturnType<typeof parseStreamJson>['outcomes'] | undefined;
  // Run identity (#1129): the id the wrapper launched with is authoritative;
  // legacy spools without one fall back to whatever the mtime-window scan found.
  let sessionId: string | undefined = spool.sessionId || undefined;

  // Observability parity across providers (cli#1175). Decide by OUTPUT FORMAT,
  // not provider: every lane that ran through the claude harness
  // (`--output-format stream-json`) — claude, glm, deepseek, kimi, gpt,
  // whatever comes next — emits the same stream-json, so it gets the same rich
  // pipeline: real outcomes, normalized exec-events, model + cost. Only a log
  // that ISN'T stream-json (a legacy aider/plain-text provider run) falls back
  // to the per-provider usage parser. (Was `if provider !== 'anthropic'`, which
  // skipped the ENTIRE pipeline for non-Claude runs — 0 events, unknown model,
  // no artifacts: the black box the founder caught 2026-07-19.)
  const rawLog = spool.logFile ? readLogTail(spool.logFile, STREAM_LOG_CAP_BYTES) : '';
  // Parser selection by HARNESS (#1177): opencode lanes emit a different JSONL
  // shape (`opencode run --format json`) with the same StreamResult contract.
  const harness = spool.harness || '';
  const stream = rawLog
    ? (harness === 'opencode' ? parseOpencodeJson(rawLog) : parseStreamJson(rawLog))
    : null;
  const hasStreamEvidence = !!stream && (
    stream.sawResult || stream.outcomes.actions > 0 || stream.text.length > 0 ||
    stream.usage.input_tokens > 0 || stream.usage.output_tokens > 0
  );
  const nonAnthropic = !!spool.provider && spool.provider !== 'anthropic';

  // ── (1) Outcomes + terminal-state classification from the stream ──────────
  // Runs for ANY provider whose log is stream-json (all claude-harness lanes:
  // claude/glm/deepseek/kimi/gpt). (Was gated on `provider === 'anthropic'`,
  // so non-Claude runs never got outcomes/classification — cli#1175.)
  if (hasStreamEvidence && stream) {
    if (stream.outcomes.actions > 0) outcomes = stream.outcomes;

    // #936: some providers print a fatal API error then exit 0 — the
    // stream-json can still look "complete". Scan the raw log for the
    // provider's own fatal signature (glm/deepseek 429/401/quota) too.
    if (status === 'completed' && nonAnthropic) {
      const fatal = detectProviderFatalError(rawLog);
      if (fatal) { status = 'failed'; fatalError = fatal; }
    }

    // #1131: a clean process exit doesn't mean the conversation finished.
    if (status === 'completed') {
      if (stream.sawResult && stream.isError) {
        status = 'failed';
        fatalError = `${spool.provider || 'claude'} reported is_error on its terminal result (${stream.usage.num_turns} turn(s))`;
      } else if (!stream.sawResult) {
        status = 'failed';
        fatalError = `stream ended without a terminal result — likely interrupted mid-response (${stream.outcomes.actions} action(s) logged)`;
      } else if (
        stream.openBackgroundSubagents > 0 &&
        stream.outcomes.commits === 0 && stream.outcomes.prs_created === 0 && stream.outcomes.issues_created === 0
      ) {
        // #1130: a clean terminal result can still be a no-op — a background
        // subagent left un-awaited with no commit/PR/issue.
        status = 'failed';
        fatalError = `run ended its turn with ${stream.openBackgroundSubagents} background subagent(s) still open and no commit/PR/issue created — not a real completion (#1130)`;
      }
    }
    if (stream.text) resultSummary = stream.text.slice(0, RESULT_SUMMARY_MAX_CHARS);
  }

  // ── (2) Usage / cost / model attribution ──────────────────────────────────
  // Claude: the per-session JSONL is the most precise attribution and works
  // even with no stream log (interactive-style), so it stays log-independent.
  // Non-Claude: trust the stream's own total_cost_usd (harness-reported,
  // accurate per provider; the claude-session pricing table wouldn't know the
  // model), with the model backfilled from assistant events (stream-json.ts).
  if (!nonAnthropic) {
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
      if (!sessionId) sessionId = session.session_id;
    } else if (stream && stream.sawResult) {
      input = stream.usage.input_tokens;
      output = stream.usage.output_tokens;
      cost = stream.usage.cost_usd;
      cacheRead = stream.usage.cache_read_tokens;
      cacheWrite = stream.usage.cache_write_tokens;
      if (stream.usage.model) model = stream.usage.model;
    }
  } else if (hasStreamEvidence && stream && stream.sawResult) {
    // Non-Claude stream-json: canonical usage + cost + backfilled model.
    input = stream.usage.input_tokens;
    output = stream.usage.output_tokens;
    cost = stream.usage.cost_usd;
    cacheRead = stream.usage.cache_read_tokens;
    cacheWrite = stream.usage.cache_write_tokens;
    if (stream.usage.model) model = stream.usage.model;
  } else if (nonAnthropic) {
    // Legacy non-stream-json provider log (aider/plain-text) — usage only.
    const tail = rawLog || (spool.logFile ? readLogTail(spool.logFile) : '');
    const fatal = tail ? detectProviderFatalError(tail) : null;
    if (fatal && status === 'completed') { status = 'failed'; fatalError = fatal; }
    const parse = getCLIConfig(spool.provider)?.parseUsage;
    if (parse && tail) {
      const usage = parse(tail);
      if (usage) { input = usage.input_tokens; output = usage.output_tokens; cost = usage.cost_usd; }
    }
  }

  // ── (3) Event normalization — any provider whose log is stream-json ───────
  // The provider travels with the events (cli#1175) so the app badges them.
  if (hasStreamEvidence && stream && rawLog) {
    try {
      normalizeDetachedLog(rawLog, obsRoot, spool.execId, spool.agent, {
        type: 'run_end',
        ok: status === 'completed',
        durationMs,
        totalUsage: { input, output, cacheRead, cacheWrite, costEst: cost },
        outcomes,
      }, spool.provider, harness);
    } catch { /* events are best-effort; the obs record below is the source of truth */ }
  }

  const record: ObservabilityRecord = {
    ts: new Date(spool.endEpoch > 0 ? spool.endEpoch * 1000 : Date.now()).toISOString(),
    id: spool.execId,
    squad: spool.squad,
    agent: spool.agent,
    provider: spool.provider || 'anthropic',
    model,
    session_id: sessionId,
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
  return { record, resultSummary };
}

/**
 * Sweep the spool: every done-file becomes an ObservabilityRecord + a
 * terminal execution status, then is deleted. Idempotent, silent when the
 * spool is empty, never throws (read paths must not break on a bad record —
 * a malformed file is renamed aside instead of retried forever).
 *
 * Six independent read paths (status/usage/exec/run/runs/board) each call
 * this on startup — separate CLI process invocations that can run at the
 * same wall-clock moment and race on the same done-file. Each entry is
 * claimed with an atomic rename before it's read (#1147): `rename()` within
 * the same directory is a single atomic syscall on POSIX filesystems, so
 * when two sweeps race on the same entry only one rename can succeed — the
 * loser gets ENOENT and skips the entry instead of both reading it and
 * double-reporting the terminal record.
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
    // Claim the done-file before touching its contents — losing this race
    // means another sweep already owns (or finished) this entry.
    const claimPath = join(dir, `.processing-${entry}`);
    try {
      renameSync(path, claimPath);
    } catch {
      continue;
    }

    try {
      const spool = JSON.parse(readFileSync(claimPath, 'utf8')) as SpoolRecord;
      const { record, resultSummary } = toRecord(spool, obsRoot);
      logObservability(record);
      const tokenSummary = `Detached run reconciled (${record.input_tokens} in / ${record.output_tokens} out, $${record.cost_usd.toFixed(4)})`;
      try {
        updateExecutionStatus(spool.squad, spool.agent, spool.execId, record.status === 'completed' ? 'completed' : 'failed', {
          outcome: tokenSummary,
          durationMs: record.duration_ms,
          error: record.error,
        });
      } catch { /* status ledger is best-effort; the obs record is the source of truth */ }

      // Report terminal status to API for background runs (#1100).
      // summary prefers the agent's own final message (#1131 result.summary)
      // over the generic token-count line — that's the postmortem a founder
      // reading a FAILED run in the app actually needs.
      // Fire-and-forget: never block reconcile on API reachability
      void reportExecutionComplete(spool.execId, record.status === 'completed' ? 'completed' : 'failed', {
        summary: resultSummary || tokenSummary,
        error: record.error,
        durationMs: record.duration_ms,
      });

      unlinkSync(claimPath);
      ingested++;
    } catch {
      // Malformed/unreadable — quarantine so the sweep never loops on it.
      try { unlinkSync(claimPath); } catch { /* leave it; next sweep retries */ }
    }
  }
  return ingested;
}
