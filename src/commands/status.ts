import { existsSync, statSync } from 'fs';
import { join } from 'path';
import {
  findSquadsDir,
  loadSquad,
  listSquads,
  listAgents
} from '../lib/squad-parser.js';
import { findMemoryDir, getSquadState } from '../lib/memory.js';
import { getLiveSessionSummary, cleanupStaleSessions } from '../lib/sessions.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface StatusOptions {
  verbose?: boolean;
}

export async function statusCommand(
  squadName?: string,
  options: StatusOptions = {}
): Promise<void> {
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
  _options: StatusOptions
): Promise<void> {
  const squads = listSquads(squadsDir);
  const memoryDir = findMemoryDir();

  // Get active sessions (real-time process detection)
  cleanupStaleSessions();
  const sessionSummary = getLiveSessionSummary();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}status${RESET}`);

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

  // Stats row
  const totalSquads = squads.length;
  const activeCount = squads.length; // All loaded squads are "active"
  writeLine(`  ${colors.cyan}${activeCount}${RESET}/${totalSquads} squads  ${colors.dim}│${RESET}  ${colors.dim}memory: ${memoryDir ? 'enabled' : 'none'}${RESET}`);
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
    writeLine(`${colors.red}Squad "${squadName}" not found.${RESET}`);
    process.exit(1);
  }

  writeLine();
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
