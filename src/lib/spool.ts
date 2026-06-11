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
import { getCLIConfig } from './llm-clis.js';
import {
  logObservability,
  captureSessionUsage,
  type ObservabilityRecord,
} from './observability.js';
import { updateExecutionStatus } from './execution-log.js';

/** Tail cap when parsing executor logs — matches the #826 live-stream buffer. */
const LOG_TAIL_CAP_BYTES = 256 * 1024;

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
}): string {
  const q = (s: string) => s.replace(/'/g, '');
  // execIds are CLI-generated, but the done-file name and embedded id are
  // sanitized to [A-Za-z0-9_-] as defense in depth.
  const safeId = fields.execId.replace(/[^A-Za-z0-9_-]/g, '');
  const dir = spoolDir(fields.obsRoot);
  const file = join(dir, `${safeId}.json`);
  // printf %s with embedded JSON skeleton; EXIT/START/HARVEST interpolated by sh.
  return (
    `; mkdir -p '${dir}'` +
    `; SPOOL_TMP=$(mktemp '${dir}/.tmp.XXXXXX')` +
    `; printf '{"execId":"%s","squad":"%s","agent":"%s","provider":"%s","model":"%s","trigger":"%s","logFile":"%s","startEpoch":%s,"endEpoch":%s,"exitCode":%s,"harvest":"%s"}' ` +
    `'${safeId}' '${q(fields.squad)}' '${q(fields.agent)}' '${q(fields.provider)}' '${q(fields.model)}' '${q(fields.trigger)}' '${q(fields.logFile)}' ` +
    `"\${START:-0}" "$(date +%s)" "\${EXIT:-1}" "\${HARVEST:-}" > "$SPOOL_TMP"` +
    `; mv "$SPOOL_TMP" '${file}'`
  );
}

function readLogTail(logFile: string): string {
  try {
    const size = statSync(logFile).size;
    const start = Math.max(0, size - LOG_TAIL_CAP_BYTES);
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

function toRecord(spool: SpoolRecord): ObservabilityRecord {
  const durationMs = spool.endEpoch > spool.startEpoch && spool.startEpoch > 0
    ? (spool.endEpoch - spool.startEpoch) * 1000
    : 0;
  const status: ObservabilityRecord['status'] = spool.exitCode === 0 ? 'completed' : 'failed';

  let input = 0, output = 0, cost = 0;
  let model = spool.model || 'unknown';

  if (spool.provider && spool.provider !== 'anthropic') {
    const parse = getCLIConfig(spool.provider)?.parseUsage;
    if (parse && spool.logFile) {
      const usage = parse(readLogTail(spool.logFile));
      if (usage) {
        input = usage.input_tokens;
        output = usage.output_tokens;
        cost = usage.cost_usd;
      }
    }
  } else if (spool.startEpoch > 0) {
    const session = captureSessionUsage(spool.startEpoch * 1000);
    if (session) {
      input = session.input_tokens;
      output = session.output_tokens;
      cost = session.cost_usd;
      if (session.model) model = session.model;
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
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: cost,
    context_tokens: 0,
    error: spool.exitCode !== 0 ? `detached run exited with code ${spool.exitCode}` : undefined,
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
      const record = toRecord(spool);
      logObservability(record);
      try {
        updateExecutionStatus(spool.squad, spool.agent, spool.execId, record.status === 'completed' ? 'completed' : 'failed', {
          outcome: `Detached run reconciled (${record.input_tokens} in / ${record.output_tokens} out, $${record.cost_usd.toFixed(4)})`,
          durationMs: record.duration_ms,
          error: record.error,
        });
      } catch { /* status ledger is best-effort; the obs record is the source of truth */ }
      unlinkSync(path);
      ingested++;
    } catch {
      // Malformed/unreadable — quarantine so the sweep never loops on it.
      try { unlinkSync(path); } catch { /* leave it; next sweep retries */ }
    }
  }
  return ingested;
}
