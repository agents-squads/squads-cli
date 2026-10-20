/**
 * `squads runs` / `squads kill` — see and control detached background runs
 * (hq#450 D4). Completes the containment loop: spool records what happened,
 * the watchdog bounds it, this surfaces it.
 */
import { readdirSync, readFileSync, existsSync, statSync, appendFileSync } from 'fs';
import { join } from 'path';
import { getProjectRoot } from '../lib/run-utils.js';
import {
  listDetachedRuns,
  cleanStaleRuns,
  killDetachedRun,
  type DetachedRun,
} from '../lib/runs-inventory.js';

// Import isAlive from runs-inventory (it's not exported, so we reimplement here)
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
import { reconcileDetachedRuns } from '../lib/spool.js';
import { reconcileOrphanedRuns, queryExecutions, foldExecutions, type ObservabilityRecord } from '../lib/observability.js';
import { execEventsFile, deriveLifecycleTimingsForRun, type PersistedExecEvent } from '../lib/exec-events.js';
import { renderPersistedEvent, parsePersistedLine } from '../lib/event-render.js';
import { buildContextReport, renderContextReport } from '../lib/context-report.js';
import { colors, RESET, bold, writeLine } from '../lib/terminal.js';

function elapsed(startedAt: number): string {
  const ms = Date.now() - startedAt;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Load a run's persisted events; on a missing file, print help (recent
 * replayable runs) and return null. Shared by --replay and --report.
 */
function loadRunEvents(execId: string, projectRoot: string): PersistedExecEvent[] | null {
  const eventsDir = join(projectRoot, '.agents', 'observability', 'events');
  const file = execEventsFile(projectRoot, execId);

  if (!existsSync(file)) {
    writeLine();
    writeLine(`  ${colors.red}No events recorded for '${execId}'${RESET}`);
    // Help the user find a replayable run: most recent events files.
    try {
      const available = readdirSync(eventsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ id: f.replace(/\.jsonl$/, ''), mtime: statSync(join(eventsDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 10);
      if (available.length > 0) {
        writeLine(`  ${colors.dim}Recent runs with events:${RESET}`);
        for (const a of available) {
          writeLine(`    ${colors.cyan}${a.id}${RESET}`);
        }
      } else {
        writeLine(`  ${colors.dim}No runs have recorded events yet (events land in ${eventsDir}).${RESET}`);
      }
    } catch {
      writeLine(`  ${colors.dim}No events directory yet (${eventsDir}).${RESET}`);
    }
    writeLine();
    return null;
  }

  const lines = readFileSync(file, 'utf8').split('\n');
  const parsed = lines.map(parsePersistedLine).filter((l): l is NonNullable<typeof l> => l !== null);
  if (parsed.length === 0) {
    writeLine(`  ${colors.dim}Events file for '${execId}' is empty or unreadable.${RESET}`);
    return null;
  }
  return parsed;
}

/**
 * `squads runs --replay <execId>` — re-render a finished run's activity feed
 * from its persisted events file (#903). Consumer of the #902 event stream:
 * the same feed watch mode shows live, replayable after the fact.
 */
export function replayRun(execId: string, projectRoot: string): void {
  const parsed = loadRunEvents(execId, projectRoot);
  if (!parsed) return;

  const t0 = Date.parse(parsed[0].ts);
  writeLine();
  writeLine(`  ${bold}Replay: ${execId}${RESET} ${colors.dim}(${parsed.length} events)${RESET}`);
  writeLine();
  for (const line of parsed) {
    const rendered = renderPersistedEvent(line, t0);
    if (rendered !== null) writeLine(rendered);
  }
  writeLine();
}

/**
 * `squads runs --report <execId>` — context-economy report (#904): per-agent
 * tokens/cost + cache-hit ratio (exact), per-tool activity, per-layer
 * assembly cost (estimated). Where did the context go?
 */
export function reportRun(execId: string, projectRoot: string): void {
  const parsed = loadRunEvents(execId, projectRoot);
  if (!parsed) return;
  const report = buildContextReport(parsed);
  for (const line of renderContextReport(report)) writeLine(line);
}

interface RunWaitResult {
  status: 'completed' | 'timeout' | 'error';
  is_error: boolean;
  turns: number;
  duration_s: number;
  denials: number;
  result_tail?: string;
}

/**
 * Parse a run's log file to extract completion information.
 * Looks for the provider's final result event and counts permission denials.
 */
function parseRunResult(logPath: string, startedAt: number): RunWaitResult | null {
  if (!existsSync(logPath)) return null;

  const content = readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  let resultFound = false;
  let isError = false;
  let denials = 0;
  let resultTail: string | undefined;

  // Count denials by parsing stream-json and looking only in tool_result content blocks
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);

      // Look for user-type entries containing tool_result blocks
      if (parsed.type === 'user' && Array.isArray(parsed.content)) {
        for (const block of parsed.content) {
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            // Count denial phrase occurrences within this tool_result content
            const matches = block.content.match(/haven't granted it yet/g);
            if (matches) {
              denials += matches.length;
            }
          }
        }
      }
    } catch {
      // Not a JSON line, skip
    }
  }

  // Look for the provider's final result event
  // In Claude's stream-json format, this is a line with type: 'result'
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);

      // Look for the result event from Claude's stream-json
      if (parsed.type === 'result') {
        resultFound = true;
        isError = parsed.stop_reason === 'max_tokens' || parsed.stop_reason === 'exception';

        // Extract last few lines as result tail
        const allLines = lines.filter(l => l.trim()).slice(-5);
        resultTail = allLines.join('\n').slice(0, 200);

        break;
      }
    } catch {
      // Not a JSON line, skip
    }
  }

  if (!resultFound) {
    // No result event found yet - still running or incomplete
    return null;
  }

  const durationS = (Date.now() - startedAt) / 1000;

  // Estimate turns from the content (count tool use blocks)
  const turnMatches = content.match(/"type":\s*"tool_use"/g);
  const turns = turnMatches ? turnMatches.length : 0;

  return {
    status: isError ? 'error' : 'completed',
    is_error: isError,
    turns,
    duration_s: durationS,
    denials,
    result_tail: resultTail,
  };
}

/** Print a wait result in json or human form (shared by the live-poll and already-ended paths). */
function printRunResult(result: RunWaitResult, json?: boolean): void {
  if (json) {
    writeLine(JSON.stringify(result, null, 2));
  } else {
    const statusColor = result.is_error ? colors.red : colors.green;
    writeLine(`  ${statusColor}${result.status.toUpperCase()}${RESET} ${colors.dim}in ${result.duration_s.toFixed(1)}s${RESET}`);
    writeLine(`  ${colors.dim}Turns: ${result.turns}${RESET}`);
    if (result.denials > 0) {
      writeLine(`  ${colors.yellow}Permission denials: ${result.denials}${RESET}`);
    }
  }
}

/**
 * Wait for a detached run to complete, then print a summary.
 */
export async function waitRun(runId: string | boolean, projectRoot: string, json?: boolean): Promise<void> {
  const runs = listDetachedRuns(projectRoot);
  const live = runs.filter((r) => r.alive);

  let targetRun: DetachedRun | undefined;

  if (typeof runId === 'boolean' || runId === '') {
    // Wait on newest live run
    targetRun = live.sort((a, b) => b.startedAt - a.startedAt)[0];
    if (!targetRun) {
      writeLine(`  ${colors.dim}No live runs to wait on${RESET}`);
      process.exit(1);
    }
  } else {
    // Find run by ID (squad/agent or just squad)
    targetRun = live.find((r) => r.squad === runId || `${r.squad}/${r.agent}` === runId);
    if (!targetRun) {
      // Not live — but it may have already ended between dispatch and this
      // call (or the caller is polling after the fact). If there's a
      // pid/log trail on disk for this id, treat it as already-ended:
      // parse the log and report the same summary a live wait would have
      // produced, rather than erroring just because the process is gone.
      const ended = runs.find((r) => r.squad === runId || `${r.squad}/${r.agent}` === runId);
      if (ended) {
        const result = parseRunResult(ended.logFile, ended.startedAt);
        if (result) {
          printRunResult(result, json);
          if (result.is_error) process.exit(1);
          return;
        }
      }
      writeLine(`  ${colors.red}No live run matching '${runId}'${RESET}`);
      process.exit(1);
    }
  }

  const timeout = 40 * 60 * 1000; // 40 minutes
  const pollInterval = 1000; // 1 second
  const startTime = Date.now();

  writeLine();
  writeLine(`  ${bold}Waiting for ${targetRun.squad}/${targetRun.agent}${RESET} ${colors.dim}(pid ${targetRun.pid})${RESET}`);
  writeLine();

  // Poll until the run completes
  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeout) {
      const result: RunWaitResult = {
        status: 'timeout',
        is_error: true,
        turns: 0,
        duration_s: elapsed / 1000,
        denials: 0,
      };
      if (json) {
        writeLine(JSON.stringify(result, null, 2));
      } else {
        writeLine(`  ${colors.yellow}Timeout after ${(elapsed / 1000 / 60).toFixed(1)} minutes${RESET}`);
      }
      process.exit(1);
      return;
    }

    // Check if the process is still alive
    if (!isAlive(targetRun.pid)) {
      // Process died, check the log for results
      const result = parseRunResult(targetRun.logFile, targetRun.startedAt);
      if (result) {
        printRunResult(result, json);
        // Exit with error code if the run failed
        if (result.is_error) {
          process.exit(1);
        }
        return;
      }
      // No result found yet, wait a bit more
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }
}

/**
 * `squads runs --outcome <execId>` — did the run's output LAND? (#817)
 * Resolves the run's artifact refs live against GitHub: merged/open/closed.
 * The evaluation question activity counters can't answer.
 */
export async function outcomeRun(execId: string, projectRoot: string, json?: boolean): Promise<void> {
  const parsed = loadRunEvents(execId, projectRoot);
  if (!parsed) return;
  const { resolveRunOutcome } = await import('../lib/outcome-resolve.js');
  const outcome = resolveRunOutcome(parsed);

  if (json) {
    writeLine(JSON.stringify(outcome, null, 2));
    return;
  }

  writeLine();
  const hasArtifacts = outcome.artifacts.length > 0 || outcome.unconfirmed.length > 0 || outcome.summary.commits > 0;
  const verdict = outcome.landed
    ? `${colors.green}LANDED${RESET}`
    : hasArtifacts ? `${colors.yellow}NOT LANDED YET${RESET}` : `${colors.dim}NO ARTIFACTS${RESET}`;
  writeLine(`  ${bold}Outcome: ${execId}${RESET}  ${verdict}`);
  writeLine();

  for (const a of outcome.artifacts) {
    const state = a.state === 'merged' ? `${colors.green}merged${RESET}`
      : a.state === 'open' ? `${colors.cyan}open${RESET}`
      : a.state === 'closed' ? `${colors.red}closed${RESET}`
      : `${colors.dim}unknown${RESET}`;
    writeLine(`    ${a.kind.toUpperCase().padEnd(5)} ${state}  ${colors.dim}${a.ref}${a.agent ? ` · ${a.agent}` : ''}${RESET}`);
  }
  if (outcome.summary.commits > 0) {
    writeLine(`    ${colors.dim}+ ${outcome.summary.commits} commit${outcome.summary.commits > 1 ? 's' : ''} recorded (not individually resolved)${RESET}`);
  }
  for (const u of outcome.unconfirmed) {
    writeLine(`    ${colors.yellow}? ${u.kind}${RESET} ${colors.dim}create seen but no URL captured: ${u.ref.slice(0, 80)}${RESET}`);
  }
  if (!hasArtifacts) {
    writeLine(`    ${colors.dim}This run created no commits, PRs, or issues — spend without output.${RESET}`);
  }
  writeLine();
}

/**
 * Reconcile is best-effort so a read path never dies on a ledger write, but a
 * swallowed failure hides a broken ledger (review F4). DEBUG makes it visible
 * on stderr, which keeps `--json` on stdout parseable.
 */
function debugReconcileFailure(step: string, err: unknown): void {
  if (!process.env.DEBUG) return;
  console.error(`[runs] ${step} failed:`, err instanceof Error ? err.message : err);
}

export async function runsCommand(options: { json?: boolean; clean?: boolean; replay?: string; report?: string; outcome?: string; wait?: string | boolean }): Promise<void> {
  const projectRoot = getProjectRoot();

  // Reconcile before reading anything (#1321): ingest finished spools and
  // resolve dead-pid rows from their logs, so `squads runs` never reports a
  // run as running after its process is gone.
  try { reconcileDetachedRuns(projectRoot); } catch (err) { debugReconcileFailure('spool reconcile', err); }
  try { reconcileOrphanedRuns(); } catch (err) { debugReconcileFailure('orphaned-run reconcile', err); }

  if (options.replay) {
    replayRun(options.replay, projectRoot);
    return;
  }
  if (options.report) {
    reportRun(options.report, projectRoot);
    return;
  }
  if (options.outcome) {
    await outcomeRun(options.outcome, projectRoot, options.json);
    return;
  }
  if (options.wait !== undefined) {
    await waitRun(options.wait, projectRoot, options.json);
    return;
  }

  const runs = listDetachedRuns(projectRoot);
  const live = runs.filter((r) => r.alive);
  const stale = runs.filter((r) => !r.alive);

  let cleaned = { removedPidFiles: 0, salvaged: [] as Array<{ squad: string; agent: string; outcome: string }> };
  if (options.clean) {
    cleaned = await cleanStaleRuns(projectRoot);
    reconcileDetachedRuns(projectRoot);
  }

  if (options.json) {
    // #1355: expose the folded ledger rows — billing + lifecycle timings.
    // Timings are (re)derived from each run's events file so post-run
    // gate/review events (cli#1354, appended after the run ended) surface here.
    const records: ObservabilityRecord[] = foldExecutions(queryExecutions({})).map((r) => ({
      ...r,
      ...deriveLifecycleTimingsForRun(execEventsFile(projectRoot, r.id)),
    }));
    writeLine(JSON.stringify({ live, stale: options.clean ? [] : stale, cleaned, records }, null, 2));
    return;
  }

  writeLine();
  if (live.length === 0) {
    writeLine(`  ${colors.dim}No live background runs${RESET}`);
  } else {
    writeLine(`  ${bold}Live background runs${RESET}`);
    for (const r of live) {
      writeLine(`  ${colors.green}●${RESET} ${r.squad}/${r.agent}  ${colors.dim}pid ${r.pid} · up ${elapsed(r.startedAt)} · ${r.logFile}${RESET}`);
    }
  }
  if (options.clean) {
    if (cleaned.removedPidFiles > 0) {
      writeLine(`  ${colors.dim}cleaned ${cleaned.removedPidFiles} stale pid file(s)${RESET}`);
    }
    for (const s of cleaned.salvaged) {
      writeLine(`  ${colors.yellow}salvaged${RESET} ${s.squad}/${s.agent} ${colors.dim}(${s.outcome})${RESET}`);
    }
  } else if (stale.length > 0) {
    writeLine(`  ${colors.dim}${stale.length} stale pid file(s) — run: squads runs --clean${RESET}`);
  }
  writeLine();
}

export async function killCommand(target: string | undefined, options: { all?: boolean }): Promise<void> {
  const projectRoot = getProjectRoot();
  const live = listDetachedRuns(projectRoot).filter((r) => r.alive);

  let victims: DetachedRun[];
  if (options.all) {
    victims = live;
  } else if (target && /^\d+$/.test(target)) {
    victims = live.filter((r) => r.pid === parseInt(target, 10));
  } else if (target && target.includes('/')) {
    const [squad, agent] = target.split('/');
    victims = live.filter((r) => r.squad === squad && r.agent === agent);
  } else if (target) {
    victims = live.filter((r) => r.squad === target);
  } else {
    writeLine(`  ${colors.dim}Usage: squads kill <pid|squad|squad/agent> | squads kill --all${RESET}`);
    return;
  }

  if (victims.length === 0) {
    writeLine(`  ${colors.dim}No matching live runs${RESET}`);
    return;
  }
  for (const run of victims) {
    const res = killDetachedRun(run);
    const how = res.method === 'children-term'
      ? 'executor stopped — wrapper will harvest + report'
      : res.method === 'wrapper-term' ? 'wrapper stopped' : 'was not running';
    writeLine(`  ${colors.yellow}kill${RESET} ${run.squad}/${run.agent} ${colors.dim}pid ${run.pid} — ${how}${RESET}`);
  }
}

interface AnnotateOptions {
  commit: string;
  gate?: 'pass' | 'fail';
  tests?: string;
  newFailures?: string;
  pr?: string;
  verdict?: string;
  findings?: string;
  severity?: string;
  reviewerRunId?: string;
  json?: boolean;
}

/**
 * `squads runs annotate` — attach gate result or review verdict to the run
 * that produced a given commit. The event is appended to the run's events file.
 */
export async function annotateRunCommand(options: AnnotateOptions): Promise<void> {
  const projectRoot = getProjectRoot();
  const eventsDir = join(projectRoot, '.agents', 'observability', 'events');

  if (!existsSync(eventsDir)) {
    const msg = `No events directory found at ${eventsDir}`;
    if (options.json) {
      writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      writeLine(`  ${colors.red}${msg}${RESET}`);
    }
    process.exit(1);
  }

  // Find the run whose artifact event has kind: commit, ref: <sha>
  let targetRunId: string | null = null;

  try {
    const files = readdirSync(eventsDir).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const runId = file.replace(/\.jsonl$/, '');
      const filePath = join(eventsDir, file);
      const lines = readFileSync(filePath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as PersistedExecEvent;
          if (ev.event && ev.event.type === 'artifact') {
            const artifact = ev.event as { kind?: string; ref?: string };
            if (artifact.kind === 'commit' && artifact.ref?.includes(options.commit)) {
              targetRunId = runId;
              break;
            }
          }
        } catch { /* malformed line, skip */ }
      }
      if (targetRunId) break;
    }
  } catch {
    const msg = `Failed to read events directory`;
    if (options.json) {
      writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      writeLine(`  ${colors.red}${msg}${RESET}`);
    }
    process.exit(1);
  }

  if (!targetRunId) {
    const msg = `No run found that produced commit ${options.commit}`;
    if (options.json) {
      writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      writeLine(`  ${colors.red}${msg}${RESET}`);
    }
    process.exit(1);
  }

  // Validate mutually exclusive options
  const hasGate = !!options.gate;
  const hasVerdict = !!options.verdict;
  if (hasGate && hasVerdict) {
    const msg = 'Cannot specify both --gate and --verdict; choose one';
    if (options.json) {
      writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      writeLine(`  ${colors.red}${msg}${RESET}`);
    }
    process.exit(1);
  }
  if (!hasGate && !hasVerdict) {
    const msg = 'Must specify either --gate (pass|fail) or --verdict (PASS|FAIL)';
    if (options.json) {
      writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      writeLine(`  ${colors.red}${msg}${RESET}`);
    }
    process.exit(1);
  }

  // `--verdict` is free-form at the CLI; only PASS/FAIL are meaningful to the
  // review_verdict event schema. Upper-case the input so `--verdict pass` is
  // accepted, and reject anything that isn't one of the two values.
  let verdict: 'PASS' | 'FAIL' | undefined;
  if (hasVerdict) {
    const normalized = (options.verdict ?? '').toUpperCase();
    if (normalized === 'PASS' || normalized === 'FAIL') {
      verdict = normalized;
    } else {
      const msg = `--verdict must be PASS or FAIL (got "${options.verdict}")`;
      if (options.json) {
        writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
      } else {
        writeLine(`  ${colors.red}${msg}${RESET}`);
      }
      process.exit(1);
    }
  }

  // Build the event
  let newEvent: PersistedExecEvent['event'];
  const now = new Date().toISOString();

  if (hasGate) {
    if (!options.tests) {
      const msg = '--gate requires --tests (e.g. 3104/3109)';
      if (options.json) {
        writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
      } else {
        writeLine(`  ${colors.red}${msg}${RESET}`);
      }
      process.exit(1);
    }
    const newFailures = options.newFailures ? options.newFailures.split(',').map(s => s.trim()).filter(Boolean) : [];
    newEvent = {
      type: 'gate_result',
      ok: options.gate === 'pass',
      newFailures,
      tests: options.tests,
      ...(options.pr ? { prUrl: options.pr } : {}),
      sha: options.commit,
    };
  } else {
    if (!options.findings) {
      const msg = '--verdict requires --findings (number of findings)';
      if (options.json) {
        writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
      } else {
        writeLine(`  ${colors.red}${msg}${RESET}`);
      }
      process.exit(1);
    }
    const findings = parseInt(options.findings, 10);
    if (isNaN(findings) || findings < 0) {
      const msg = '--findings must be a non-negative integer';
      if (options.json) {
        writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
      } else {
        writeLine(`  ${colors.red}${msg}${RESET}`);
      }
      process.exit(1);
    }
    newEvent = {
      type: 'review_verdict',
      pr: options.pr || '',
      verdict: verdict!, // validated + normalized above
      findings,
      ...(options.severity ? { severity: options.severity } : {}),
      ...(options.reviewerRunId ? { reviewerRunId: options.reviewerRunId } : {}),
      sha: options.commit,
    };
  }

  // Append to the run's events file
  const filePath = execEventsFile(projectRoot, targetRunId);
  try {
    // Read existing events to get the next seq
    let seq = 0;
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, 'utf8');
      for (let i = 0; i < existing.length; i++) {
        if (existing.charCodeAt(i) === 10) seq++;
      }
    }

    const line: PersistedExecEvent = {
      schema_version: 1,
      v: 2,
      runId: targetRunId,
      seq,
      ts: now,
      event: newEvent,
    };

    const serialized = JSON.stringify(line) + '\n';
    appendFileSync(filePath, serialized);

    if (options.json) {
      writeLine(JSON.stringify({ ok: true, runId: targetRunId, event: newEvent }, null, 2));
    } else {
      const eventType = newEvent.type === 'gate_result' ? 'gate_result' : 'review_verdict';
      writeLine(`  ${colors.green}Appended ${eventType} to run ${targetRunId}${RESET}`);
    }
  } catch (err) {
    const msg = `Failed to write event: ${err instanceof Error ? err.message : String(err)}`;
    if (options.json) {
      writeLine(JSON.stringify({ ok: false, error: msg }, null, 2));
    } else {
      writeLine(`  ${colors.red}${msg}${RESET}`);
    }
    process.exit(1);
  }
}
