import {
  findSquadsDir,
  listSquads,
  listAgents
} from '../lib/squad-parser.js';
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

interface ListOptions {
  squads?: boolean;
  agents?: boolean;
}

export async function listCommand(options: ListOptions): Promise<void> {
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  const squads = listSquads(squadsDir);
  const allAgents = listAgents(squadsDir);

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}list${RESET}`);
  writeLine();

  // Stats
  writeLine(`  ${colors.cyan}${squads.length}${RESET} squads  ${colors.dim}│${RESET}  ${colors.cyan}${allAgents.length}${RESET} agents`);
  writeLine();

  if (!options.agents) {
    // Show squads table
    const w = { name: 16, agents: 8, lead: 24 };
    const tableWidth = w.name + w.agents + w.lead + 4;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

    const header = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
      `${bold}${padEnd('AGENTS', w.agents)}${RESET}` +
      `${bold}LEAD${RESET}` +
      ` ${colors.purple}${box.vertical}${RESET}`;
    writeLine(header);

    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const squadName of squads) {
      const agents = listAgents(squadsDir, squadName);
      const lead = agents.find(a => a.name.includes('lead'))?.name || agents[0]?.name || '-';

      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(squadName, w.name)}${RESET}` +
        `${padEnd(String(agents.length), w.agents)}` +
        `${colors.dim}${padEnd(lead, w.lead)}${RESET}` +
        `${colors.purple}${box.vertical}${RESET}`;

      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
    writeLine();
  }

  if (!options.squads && options.agents) {
    // Show agents list
    writeLine(`  ${bold}Agents${RESET}`);
    writeLine();

    for (const agent of allAgents) {
      const squadPart = agent.squad ? `${colors.dim}${agent.squad}/${RESET}` : '';
      const statusIcon = agent.status?.toLowerCase() === 'active' ? icons.active : icons.pending;

      writeLine(`  ${statusIcon} ${squadPart}${colors.white}${agent.name}${RESET}`);
      if (agent.role) {
        writeLine(`    ${colors.dim}└ ${agent.role}${RESET}`);
      }
    }
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads status ${colors.cyan}<squad>${RESET}   ${colors.dim}Squad details${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}<squad>${RESET}      ${colors.dim}Execute a squad${RESET}`);
  writeLine();
}
