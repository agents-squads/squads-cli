import { existsSync, statSync } from 'fs';
import { reconcileDetachedRuns } from '../lib/spool.js';
import { join } from 'path';
import {
  findSquadsDir,
  loadSquad,
  listSquads,
  listAgents,
  resolveExecutionContext,
  findSimilarSquads,
} from '../lib/squad-parser.js';
import { findMemoryDir, getSquadState } from '../lib/memory.js';
import {
  getLiveSessionSummaryAsync,
  cleanupStaleSessions,
} from '../lib/sessions.js';
import { fetchOperationalStatus } from '../lib/git.js';
import {
  listExecutions,
  formatDuration,
  formatRelativeTime,
} from '../lib/executions.js';
import { reconcileOrphanedRuns, type ObservabilityRecord } from '../lib/observability.js';
import { checkForUpdate } from '../lib/update.js';
import { track, Events } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  icons,
  writeLine,
  privacyHeader,
} from '../lib/terminal.js';

interface StatusOptions {
  verbose?: boolean;
  json?: boolean;
  /** Show every squad row and completed milestones (default: only what's moving). */
  all?: boolean;
}

/** 24h ledger view: fold + reap, then split into live and terminal. */
function ledgerStats24h(): {
  running: ObservabilityRecord[];
  completed: number;
  failed: number;
  total: number;
  lastTerminalBySquad: Map<string, number>;
} {
  // reconcileOrphanedRuns folds the event log AND reaps dead-pid rows, so a
  // run only counts as running if its process is actually alive right now —
  // the 191-zombie / "17 running" lie this rewrite kills (cli#1142).
  const folded = reconcileOrphanedRuns();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const running = folded.filter(r => r.status === 'running');
  const day = folded.filter(r => r.status !== 'running' && new Date(r.ts).getTime() >= dayAgo);
  const lastTerminalBySquad = new Map<string, number>();
  for (const r of folded) {
    if (r.status === 'running') continue;
    const t = new Date(r.ts).getTime();
    if (t > (lastTerminalBySquad.get(r.squad) ?? 0)) lastTerminalBySquad.set(r.squad, t);
  }
  return {
    running,
    completed: day.filter(r => r.status === 'completed').length,
    failed: day.filter(r => r.status === 'failed' || r.status === 'timeout' || r.status === 'orphaned').length,
    total: running.length + day.length,
    lastTerminalBySquad,
  };
}

export async function statusCommand(
  squadName?: string,
  options: StatusOptions = {}
): Promise<void> {
  // hq#450 D2: ingest done-files from detached runs before reading any ledger.
  try {
    const { getProjectRoot } = await import('../lib/run-utils.js');
    const n = reconcileDetachedRuns(getProjectRoot());
    if (n > 0) console.log(`  reconciled ${n} detached run(s) into observability`);
  } catch { /* read paths never break on spool issues */ }
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  if (squadName) {
    await showSquadStatus(squadName, squadsDir, options);
  } else {
    await showOverallStatus(squadsDir, options);
  }
}

async function showOverallStatus(
  squadsDir: string,
  options: StatusOptions
): Promise<void> {
  const squads = listSquads(squadsDir);
  const memoryDir = findMemoryDir();

  // Get active sessions (real-time process detection with parallel lsof)
  cleanupStaleSessions();
  const sessionSummary = await getLiveSessionSummaryAsync();

  // JSON output
  if (options.json) {
    const ledger = ledgerStats24h();
    const squadData = squads.map(name => {
      const agents = listAgents(squadsDir, name);
      const states = memoryDir ? getSquadState(name) : [];
      return { name, agentCount: agents.length, memoryEntries: states.length };
    });
    console.log(JSON.stringify({
      ok: true,
      command: 'status',
      data: {
        squads: squadData,
        totalSquads: squads.length,
        sessions: sessionSummary,
        executions24h: {
          total: ledger.total,
          running: ledger.running.length,
          completed: ledger.completed,
          failed: ledger.failed,
        },
        working_now: ledger.running.map(r => ({
          id: r.id, squad: r.squad, agent: r.agent, provider: r.provider, since: r.ts,
        })),
        memoryEnabled: !!memoryDir,
      },
    }, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}status${RESET}`);

  // Check for updates (cached, non-blocking)
  const updateInfo = checkForUpdate();
  if (updateInfo.updateAvailable) {
    writeLine(`  ${colors.cyan}⬆${RESET} Update available: ${colors.dim}${updateInfo.currentVersion}${RESET} → ${colors.green}${updateInfo.latestVersion}${RESET} ${colors.dim}(run \`squads update\`)${RESET}`);
  }

  // Session indicator line (only if there are active sessions)
  if (sessionSummary.totalSessions > 0) {
    const sessionText = sessionSummary.totalSessions === 1 ? 'session' : 'sessions';
    const squadText = sessionSummary.squadCount === 1 ? 'squad' : 'squads';

    // Build tool breakdown string (e.g., "claude 4, cursor 2")
    let toolInfo = '';
    if (sessionSummary.byTool && Object.keys(sessionSummary.byTool).length > 0) {
      const toolParts = Object.entries(sessionSummary.byTool)
        .sort((a, b) => b[1] - a[1]) // Sort by count descending
        .map(([tool, count]) => `${colors.dim}${tool}${RESET} ${colors.cyan}${count}${RESET}`);
      toolInfo = ` ${colors.dim}(${RESET}${toolParts.join(` ${colors.dim}·${RESET} `)}${colors.dim})${RESET}`;
    }

    writeLine(`  ${colors.green}${icons.active}${RESET} ${colors.white}${sessionSummary.totalSessions}${RESET} active ${sessionText} ${colors.dim}across${RESET} ${colors.cyan}${sessionSummary.squadCount}${RESET} ${squadText}${toolInfo}`);
  }
  writeLine();

  // Execution truth (last 24h) — from the folded run ledger + live pids,
  // never from unreconciled per-agent markdown (cli#1142).
  const ledger = ledgerStats24h();
  const workingSquads = new Set(ledger.running.map(r => r.squad));
  const execSummary = ledger.total > 0
    ? `${colors.green}${ledger.completed}${RESET} ${colors.dim}completed${RESET}` +
      (ledger.failed > 0 ? ` ${colors.red}${ledger.failed}${RESET} ${colors.dim}failed${RESET}` : '')
    : `${colors.dim}no executions${RESET}`;

  // Headline: what's happening RIGHT NOW.
  if (ledger.running.length > 0) {
    writeLine(`  ${colors.green}●${RESET} ${bold}${workingSquads.size}${RESET} ${workingSquads.size === 1 ? 'squad' : 'squads'} working ${colors.dim}(${ledger.running.length} ${ledger.running.length === 1 ? 'run' : 'runs'})${RESET}  ${colors.dim}│${RESET}  ${colors.dim}24h:${RESET} ${execSummary}  ${colors.dim}│${RESET}  ${colors.dim}${squads.length} squads${RESET}`);
    for (const run of ledger.running.slice(0, 8)) {
      const mins = Math.round((Date.now() - new Date(run.ts).getTime()) / 60000);
      writeLine(`    ${colors.yellow}◆${RESET} ${colors.cyan}${run.squad}${RESET}/${colors.white}${run.agent}${RESET} ${colors.dim}${run.provider} · ${mins}m${run.task ? ` · ${run.task.slice(0, 44)}` : ''}${RESET}`);
    }
    if (ledger.running.length > 8) {
      writeLine(`    ${colors.dim}… and ${ledger.running.length - 8} more (squads board)${RESET}`);
    }
  } else {
    writeLine(`  ${colors.dim}○ nothing running${RESET}  ${colors.dim}│${RESET}  ${colors.dim}24h:${RESET} ${execSummary}  ${colors.dim}│${RESET}  ${colors.dim}${squads.length} squads · memory: ${memoryDir ? 'enabled' : 'none'}${RESET}`);
  }
  writeLine();

  // Roster: by default only squads that are moving — working now, or with a
  // run/memory touch in the last 7 days. The rest collapse to one line.
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
  const rows: Array<{ name: string; agents: number; memory: string; activity: string }> = [];
  let pausedCount = 0;
  let idleCount = 0;

  for (const squadName of squads) {
    const squadData = loadSquad(squadName);
    if (squadData?.status === 'paused') { pausedCount++; if (!options.all) continue; }

    // Last activity = the LATER of last terminal run (ledger) and last memory
    // write. Memory alone kept dead squads looking alive for weeks.
    let lastTouch = ledger.lastTerminalBySquad.get(squadName) ?? 0;
    if (memoryDir) {
      const squadMemoryPath = join(memoryDir, squadName);
      if (existsSync(squadMemoryPath)) {
        for (const state of getSquadState(squadName)) {
          const stat = statSync(state.path);
          if (stat.mtimeMs > lastTouch) lastTouch = stat.mtimeMs;
        }
      }
    }

    const working = workingSquads.has(squadName);
    if (!working && !options.all && Date.now() - lastTouch > SEVEN_DAYS) { idleCount++; continue; }

    const states = memoryDir ? getSquadState(squadName) : [];
    const daysAgo = lastTouch > 0 ? Math.floor((Date.now() - lastTouch) / (24 * 60 * 60 * 1000)) : null;
    const activity = working
      ? `${colors.green}● working${RESET}`
      : squadData?.status === 'paused'
        ? `${colors.yellow}⏸ paused${RESET}`
        : daysAgo === null
          ? `${colors.dim}—${RESET}`
          : daysAgo === 0
            ? `${colors.green}today${RESET}`
            : `${daysAgo < 7 ? colors.yellow : colors.dim}${daysAgo}d ago${RESET}`;

    rows.push({
      name: squadName,
      agents: listAgents(squadsDir, squadName).length,
      memory: states.length > 0 ? `${states.length} ${states.length === 1 ? 'entry' : 'entries'}` : 'none',
      activity,
    });
  }

  if (rows.length > 0) {
    const w = { name: 16, agents: 8, memory: 14, activity: 12 };
    const tableWidth = w.name + w.agents + w.memory + w.activity + 6;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
    writeLine(`  ${colors.purple}${box.vertical}${RESET} ` +
      `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
      `${bold}${padEnd('AGENTS', w.agents)}${RESET}` +
      `${bold}${padEnd('MEMORY', w.memory)}${RESET}` +
      `${bold}ACTIVITY${RESET}` +
      ` ${colors.purple}${box.vertical}${RESET}`);
    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);
    for (const r of rows) {
      writeLine(`  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(r.name, w.name)}${RESET}` +
        `${padEnd(String(r.agents), w.agents)}` +
        `${padEnd(r.memory, w.memory)}` +
        `${padEnd(r.activity, w.activity)}` +
        `${colors.purple}${box.vertical}${RESET}`);
    }
    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  }

  if (!options.all && (idleCount > 0 || pausedCount > 0)) {
    const parts: string[] = [];
    if (idleCount > 0) parts.push(`${idleCount} idle >7d`);
    if (pausedCount > 0) parts.push(`${pausedCount} paused`);
    writeLine(`  ${colors.dim}${parts.join(' · ')} — squads status --all shows everything${RESET}`);
  }
  writeLine();

  // Discover repos from squad definitions (SQUAD.md `repo` field)
  const repoSet = new Set<string>();
  for (const name of squads) {
    const squad = loadSquad(name);
    if (squad?.repo) repoSet.add(squad.repo);
  }
  const ops = await fetchOperationalStatus([...repoSet]);

  // Compute column width from actual repo names
  const allRepoNames = [...ops.milestones.map(m => m.repo), ...ops.openPRs.map(p => p.repo)];
  const repoColWidth = Math.max(10, ...allRepoNames.map(r => r.length + 2));

  // Milestones AHEAD — a finished milestone is history, not status. Parked
  // ones aren't being worked either; both hide unless --all.
  const isParked = (title: string) => /^parked\b/i.test(title.trim());
  const ahead = options.all
    ? ops.milestones
    : ops.milestones.filter(ms => ms.percent < 100 && !isParked(ms.title));
  const hiddenMs = ops.milestones.length - ahead.length;

  if (ahead.length > 0) {
    writeLine(`  ${bold}Milestones ahead${RESET}${hiddenMs > 0 ? ` ${colors.dim}(${hiddenMs} done/parked hidden — --all)${RESET}` : ''}`);
    writeLine();
    for (const ms of ahead) {
      const filled = Math.round(ms.percent / 10);
      const bar = `${colors.green}${'█'.repeat(filled)}${colors.dim}${'░'.repeat(10 - filled)}${RESET}`;
      const pctColor = ms.percent >= 80 ? colors.green : ms.percent >= 40 ? colors.yellow : colors.red;
      writeLine(`  ${colors.dim}${padEnd(ms.repo, repoColWidth)}${RESET}${padEnd(ms.title, 12)}${bar} ${pctColor}${ms.percent}%${RESET} ${colors.dim}(${ms.closedIssues}/${ms.totalIssues})${RESET}`);
    }
    writeLine();
  }

  if (ops.openPRs.length > 0) {
    writeLine(`  ${bold}Open PRs${RESET}`);
    writeLine();
    for (const pr of ops.openPRs) {
      const title = pr.title.length > 44 ? pr.title.substring(0, 41) + '...' : pr.title;
      const ciBadge = pr.ci === 'pass' ? `${colors.green}✓ ci${RESET}`
        : pr.ci === 'fail' ? `${colors.red}✗ ci${RESET}`
        : pr.ci === 'pending' ? `${colors.yellow}○ ci${RESET}`
        : `${colors.dim}– ci${RESET}`;
      const ageDays = pr.createdAt ? Math.floor((Date.now() - new Date(pr.createdAt).getTime()) / (24 * 60 * 60 * 1000)) : null;
      const age = ageDays === null ? '' : ageDays === 0 ? 'today' : `${ageDays}d`;
      const ageColor = ageDays !== null && ageDays > 30 ? colors.red : ageDays !== null && ageDays > 7 ? colors.yellow : colors.dim;
      writeLine(`  ${colors.dim}${padEnd(pr.repo, repoColWidth)}${RESET}${colors.cyan}#${pr.number}${RESET} ${padEnd(title, 46)} ${ciBadge} ${colors.dim}→ ${pr.base}${RESET} ${ageColor}${age}${RESET}`);
    }
    writeLine();
  }

  if (ops.error) {
    writeLine(`  ${colors.dim}GitHub: ${ops.error} (run \`gh auth login\`)${RESET}`);
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads status ${colors.cyan}<squad>${RESET}    ${colors.dim}Squad details${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads dash             ${colors.dim}Full dashboard${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}<squad>${RESET}       ${colors.dim}Execute a squad${RESET}`);
  writeLine();
}

async function showSquadStatus(
  squadName: string,
  squadsDir: string,
  options: StatusOptions
): Promise<void> {
  const squad = loadSquad(squadName);

  if (!squad) {
    if (options.json) {
      console.log(JSON.stringify({ ok: false, command: 'status', error: `Squad "${squadName}" not found` }, null, 2));
      process.exit(1);
    }
    writeLine(`${colors.red}Squad "${squadName}" not found.${RESET}`);
    const similar = findSimilarSquads(squadName, listSquads(squadsDir));
    if (similar.length > 0) {
      writeLine(`${colors.dim}Did you mean: ${similar.join(', ')}?${RESET}`);
    }
    writeLine(`${colors.dim}Run \`squads status\` to see available squads.${RESET}`);
    process.exit(1);
  }

  // JSON output for specific squad
  if (options.json) {
    const agents = listAgents(squadsDir, squadName);
    const execContext = resolveExecutionContext(squad);
    const recentExecs = listExecutions({ squad: squadName, limit: 5 });
    const memDir = findMemoryDir();
    const states = memDir ? getSquadState(squadName) : [];
    console.log(JSON.stringify({
      ok: true,
      command: 'status',
      data: {
        squad: {
          name: squad.name,
          mission: squad.mission || null,
          agents: agents.map(a => ({ name: a.name, role: a.role || null, status: a.status || 'active' })),
          pipelines: squad.pipelines,
          context: {
            skills: execContext.resolved.skills.map(s => s.name),
            mcpServers: execContext.resolved.mcpServers,
            model: squad.context?.model?.default || null,
          },
          recentExecutions: recentExecs,
          memoryEntries: states.length,
        },
      },
    }, null, 2));
    return;
  }

  writeLine();

  // Show privacy header for sensitive squads (client, finance, etc.)
  const sensitiveSquads = ['client-'];
  const isSensitive = sensitiveSquads.some(prefix => squadName.startsWith(prefix));
  if (isSensitive) {
    writeLine(privacyHeader('internal'));
    writeLine();
  }

  writeLine(`  ${gradient('squads')} ${colors.dim}status${RESET} ${colors.cyan}${squad.name}${RESET}`);
  writeLine();

  // Paused banner
  if (squad.status === 'paused') {
    const since = squad.paused_since
      ? ` since ${new Date(squad.paused_since).toLocaleDateString()}`
      : '';
    const reason = squad.paused_reason ? ` — ${squad.paused_reason}` : '';
    writeLine(`  ${colors.yellow}⏸  PAUSED${since}${reason}${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads resume ${squadName}\` to reactivate, or \`squads run ${squadName} --force\` to override.${RESET}`);
    writeLine();
  }

  // Mission
  if (squad.mission) {
    writeLine(`  ${colors.dim}${squad.mission}${RESET}`);
    writeLine();
  }

  // Agents table
  const agents = listAgents(squadsDir, squadName);
  const w = { name: 24, role: 36 };
  const tableWidth = w.name + w.role + 4;

  writeLine(`  ${bold}Agents${RESET} ${colors.dim}(${agents.length})${RESET}`);
  writeLine();

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  for (const agent of agents) {
    const status = agent.status?.toLowerCase() === 'active'
      ? icons.active
      : icons.pending;

    const role = options.verbose && agent.role
      ? `${colors.dim}${agent.role.substring(0, w.role - 2)}${RESET}`
      : '';

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${status} ${padEnd(agent.name, w.name - 2)}` +
      `${padEnd(role, w.role)}` +
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);

  // Pipelines
  if (squad.pipelines.length > 0) {
    writeLine();
    writeLine(`  ${bold}Pipelines${RESET}`);
    for (const pipeline of squad.pipelines) {
      writeLine(`  ${colors.dim}${pipeline.agents.join(' → ')}${RESET}`);
    }
  }

  // Context profile
  const execContext = resolveExecutionContext(squad);
  const hasContext = execContext.resolved.skills.length > 0 ||
                     execContext.resolved.mcpServers.length > 0 ||
                     (squad.context?.model?.default);

  if (hasContext) {
    writeLine();
    writeLine(`  ${bold}Context${RESET}`);

    // MCP servers
    if (execContext.resolved.mcpServers.length > 0) {
      const sourceLabel = execContext.resolved.mcpSource === 'squad-local' ? `${colors.green}local${RESET}` :
                          execContext.resolved.mcpSource === 'generated' ? `${colors.cyan}generated${RESET}` :
                          execContext.resolved.mcpSource === 'user-override' ? `${colors.yellow}override${RESET}` :
                          '';
      writeLine(`  ${colors.dim}MCP:${RESET}    ${colors.cyan}${execContext.resolved.mcpServers.join(', ')}${RESET}${sourceLabel ? ` ${colors.dim}(${sourceLabel})${RESET}` : ''}`);
    }

    // Skills (grouped by source)
    if (execContext.resolved.skills.length > 0) {
      const bySource = execContext.resolved.skills.reduce((acc, s) => {
        acc[s.source] = acc[s.source] || [];
        acc[s.source].push(s.name);
        return acc;
      }, {} as Record<string, string[]>);

      const skillParts: string[] = [];
      if (bySource['squad-local']) {
        skillParts.push(`${colors.green}${bySource['squad-local'].join(', ')}${RESET} ${colors.dim}(local)${RESET}`);
      }
      if (bySource['project']) {
        skillParts.push(`${colors.cyan}${bySource['project'].join(', ')}${RESET}`);
      }
      if (bySource['global']) {
        skillParts.push(`${colors.dim}${bySource['global'].join(', ')}${RESET}`);
      }
      writeLine(`  ${colors.dim}Skills:${RESET} ${skillParts.join(', ')}`);
    }

    // Model
    if (squad.context?.model?.default) {
      writeLine(`  ${colors.dim}Model:${RESET}  ${colors.white}${squad.context.model.default}${RESET}`);
    }
  }

  // Recent executions
  const recentExecs = listExecutions({ squad: squadName, limit: 5 });
  if (recentExecs.length > 0) {
    writeLine();
    writeLine(`  ${bold}Recent Executions${RESET}`);
    writeLine();

    for (const exec of recentExecs) {
      // Use plain symbols - icons already have colors embedded
      const statusIcon = exec.status === 'completed' ? `${colors.green}●${RESET}` :
                         exec.status === 'failed' ? `${colors.red}●${RESET}` :
                         `${colors.yellow}◆${RESET}`;
      const duration = exec.durationMs ? ` ${colors.dim}(${formatDuration(exec.durationMs)})${RESET}` : '';
      const relTime = formatRelativeTime(exec.startTime);

      writeLine(`  ${statusIcon} ${colors.white}${exec.agent}${RESET}${duration} ${colors.dim}${relTime}${RESET}`);

      // Show error message for failed executions
      if (exec.status === 'failed' && exec.error && options.verbose) {
        writeLine(`    ${colors.red}└ ${exec.error.substring(0, 60)}${exec.error.length > 60 ? '...' : ''}${RESET}`);
      }

      // Show outcome for completed executions in verbose mode
      if (exec.status === 'completed' && exec.outcome && options.verbose) {
        writeLine(`    ${colors.dim}└ ${exec.outcome.substring(0, 60)}${exec.outcome.length > 60 ? '...' : ''}${RESET}`);
      }
    }
  }

  // Memory state
  const memoryDir = findMemoryDir();
  if (memoryDir) {
    const states = getSquadState(squadName);

    if (states.length > 0) {
      writeLine();
      writeLine(`  ${bold}Memory${RESET} ${colors.dim}(${states.length} ${states.length === 1 ? 'entry' : 'entries'})${RESET}`);
      writeLine();

      for (const state of states) {
        const updated = state.content.match(/Updated:\s*(\S+)/)?.[1] || 'unknown';
        writeLine(`  ${icons.progress} ${colors.white}${state.agent}${RESET}`);
        writeLine(`    ${colors.dim}└ updated: ${updated}${RESET}`);

        if (options.verbose) {
          const signalsMatch = state.content.match(/## Active Signals([\s\S]*?)(?=##|$)/);
          if (signalsMatch) {
            const signalLines = signalsMatch[1]
              .split('\n')
              .filter(l => l.match(/^\d+\./))
              .slice(0, 3);

            for (const sig of signalLines) {
              writeLine(`    ${colors.dim}  ${sig.trim()}${RESET}`);
            }
          }
        }
      }
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET}           ${colors.dim}Run the squad${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads dash                    ${colors.dim}ROI metrics & cost projections${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}${squadName}${RESET}   ${colors.dim}View full memory${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads status ${colors.cyan}${squadName}${RESET} -v     ${colors.dim}Verbose status${RESET}`);
  writeLine();
}
