import { existsSync, statSync } from 'fs';
import { join } from 'path';
import {
  findSquadsDir,
  loadSquad,
  listSquads,
  listAgents,
  resolveExecutionContext,
} from '../lib/squad-parser.js';
import { findMemoryDir, getSquadState } from '../lib/memory.js';
import {
  getLiveSessionSummaryAsync,
  cleanupStaleSessions,
} from '../lib/sessions.js';
import {
  listExecutions,
  getExecutionStats,
  formatDuration,
  formatRelativeTime,
} from '../lib/executions.js';
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
}

export async function statusCommand(
  squadName?: string,
  options: StatusOptions = {}
): Promise<void> {
  await track(Events.CLI_STATUS, { squad: squadName || 'all', verbose: options.verbose });
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`${colors.dim}Run \`squads init\` to create one.${RESET}`);
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
    const execStats = getExecutionStats({ since: new Date(Date.now() - 24 * 60 * 60 * 1000) });
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
        executions24h: execStats,
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

  // Execution stats (last 24h)
  const execStats = getExecutionStats({ since: new Date(Date.now() - 24 * 60 * 60 * 1000) });
  const execSummary = execStats.total > 0
    ? `${colors.green}${execStats.completed}${RESET} ${colors.dim}completed${RESET}` +
      (execStats.failed > 0 ? ` ${colors.red}${execStats.failed}${RESET} ${colors.dim}failed${RESET}` : '') +
      (execStats.running > 0 ? ` ${colors.yellow}${execStats.running}${RESET} ${colors.dim}running${RESET}` : '')
    : `${colors.dim}no executions${RESET}`;

  // Stats row
  const totalSquads = squads.length;
  const activeCount = squads.length; // All loaded squads are "active"
  writeLine(`  ${colors.cyan}${activeCount}${RESET}/${totalSquads} squads  ${colors.dim}│${RESET}  ${colors.dim}memory: ${memoryDir ? 'enabled' : 'none'}${RESET}  ${colors.dim}│${RESET}  ${colors.dim}24h:${RESET} ${execSummary}`);
  writeLine();

  // Table
  const w = { name: 16, agents: 8, memory: 14, activity: 12 };
  const tableWidth = w.name + w.agents + w.memory + w.activity + 6;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
    `${bold}${padEnd('AGENTS', w.agents)}${RESET}` +
    `${bold}${padEnd('MEMORY', w.memory)}${RESET}` +
    `${bold}ACTIVITY${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const squadName of squads) {
    const agents = listAgents(squadsDir, squadName);

    // Check memory
    let memoryStatus = `${colors.dim}none${RESET}`;
    let lastActivity = `${colors.dim}—${RESET}`;
    let activityColor = colors.dim;

    if (memoryDir) {
      const squadMemoryPath = join(memoryDir, squadName);
      if (existsSync(squadMemoryPath)) {
        const states = getSquadState(squadName);
        memoryStatus = `${colors.green}${states.length} ${states.length === 1 ? 'entry' : 'entries'}${RESET}`;

        // Find most recent file
        let mostRecent = 0;
        for (const state of states) {
          const stat = statSync(state.path);
          if (stat.mtimeMs > mostRecent) {
            mostRecent = stat.mtimeMs;
          }
        }

        if (mostRecent > 0) {
          const daysAgo = Math.floor((Date.now() - mostRecent) / (1000 * 60 * 60 * 24));
          if (daysAgo === 0) {
            lastActivity = 'today';
            activityColor = colors.green;
          } else if (daysAgo === 1) {
            lastActivity = 'yesterday';
            activityColor = colors.green;
          } else if (daysAgo < 7) {
            lastActivity = `${daysAgo}d ago`;
            activityColor = colors.yellow;
          } else {
            lastActivity = `${daysAgo}d ago`;
            activityColor = colors.dim;
          }
        }
      }
    }

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(squadName, w.name)}${RESET}` +
      `${padEnd(String(agents.length), w.agents)}` +
      `${padEnd(memoryStatus, w.memory)}` +
      `${padEnd(`${activityColor}${lastActivity}${RESET}`, w.activity)}` +
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

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
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}${squadName}${RESET}   ${colors.dim}View full memory${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads status ${colors.cyan}${squadName}${RESET} -v     ${colors.dim}Verbose status${RESET}`);
  writeLine();
}
