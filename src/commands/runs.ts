/**
 * `squads runs` / `squads kill` — see and control detached background runs
 * (hq#450 D4). Completes the containment loop: spool records what happened,
 * the watchdog bounds it, this surfaces it.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
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
import { execEventsFile, type PersistedExecEvent } from '../lib/exec-events.js';
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

  // Count denials first
  const denialMatches = content.match(/haven't granted it yet/g);
  denials = denialMatches ? denialMatches.length : 0;

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

export async function runsCommand(options: { json?: boolean; clean?: boolean; replay?: string; report?: string; outcome?: string; wait?: string | boolean }): Promise<void> {
  const projectRoot = getProjectRoot();

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
    writeLine(JSON.stringify({ live, stale: options.clean ? [] : stale, cleaned }, null, 2));
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
