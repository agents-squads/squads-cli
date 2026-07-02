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

export async function runsCommand(options: { json?: boolean; clean?: boolean; replay?: string; report?: string; outcome?: string }): Promise<void> {
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
