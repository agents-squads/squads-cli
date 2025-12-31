import {
  findMemoryDir,
  searchMemory,
  getSquadState,
  appendToMemory,
  listMemoryEntries
} from '../lib/memory.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  truncate,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface MemoryOptions {
  squad?: string;
  agent?: string;
  type?: string;
}

export async function memoryQueryCommand(
  query: string,
  options: MemoryOptions
): Promise<void> {
  const memoryDir = findMemoryDir();

  if (!memoryDir) {
    writeLine(`  ${colors.red}No .agents/memory directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory query${RESET} "${colors.cyan}${query}${RESET}"`);
  writeLine();

  const results = searchMemory(query, memoryDir);

  if (results.length === 0) {
    writeLine(`  ${colors.yellow}No results found.${RESET}`);
    writeLine();
    return;
  }

  // Filter by squad/agent if specified
  let filtered = results;
  if (options.squad) {
    filtered = filtered.filter(r => r.entry.squad === options.squad);
  }
  if (options.agent) {
    filtered = filtered.filter(r => r.entry.agent === options.agent);
  }

  writeLine(`  ${colors.green}${filtered.length}${RESET} results found`);
  writeLine();

  // Table
  const w = { location: 28, type: 10, score: 8 };
  const tableWidth = w.location + w.type + w.score + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('LOCATION', w.location)}${RESET}` +
    `${bold}${padEnd('TYPE', w.type)}${RESET}` +
    `${bold}SCORE${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const result of filtered.slice(0, 8)) {
    const { entry, score } = result;
    const location = `${entry.squad}/${entry.agent}`;
    const scoreColor = score > 5 ? colors.green : score > 2 ? colors.yellow : colors.dim;

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(location, w.location)}${RESET}` +
      `${colors.dim}${padEnd(entry.type, w.type)}${RESET}` +
      `${scoreColor}${padEnd(score.toFixed(1), w.score)}${RESET}` +
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Show matches
  writeLine(`  ${bold}Matches${RESET}`);
  writeLine();

  for (const result of filtered.slice(0, 5)) {
    const { entry, matches } = result;

    for (const match of matches.slice(0, 2)) {
      const highlighted = match.replace(
        new RegExp(query, 'gi'),
        (m) => `${colors.yellow}${m}${RESET}`
      );
      writeLine(`  ${icons.empty} ${truncate(highlighted, 60)}`);
      writeLine(`    ${colors.dim}└ ${entry.squad}/${entry.agent}${RESET}`);
    }
  }

  if (filtered.length > 5) {
    writeLine(`  ${colors.dim}  +${filtered.length - 5} more results${RESET}`);
  }
  writeLine();

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}<squad>${RESET}   ${colors.dim}View full memory${RESET}`);
  writeLine();
}

export async function memoryShowCommand(
  squadName: string,
  _options: MemoryOptions
): Promise<void> {
  const memoryDir = findMemoryDir();

  if (!memoryDir) {
    writeLine(`  ${colors.red}No .agents/memory directory found${RESET}`);
    process.exit(1);
  }

  const states = getSquadState(squadName);

  if (states.length === 0) {
    writeLine(`  ${colors.yellow}No memory found for squad: ${squadName}${RESET}`);
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();

  writeLine(`  ${colors.dim}${states.length} entries${RESET}`);
  writeLine();

  for (const state of states) {
    writeLine(`  ${icons.progress} ${colors.white}${state.agent}${RESET} ${colors.dim}(${state.type || 'state'})${RESET}`);
    writeLine(`  ${colors.dim}${box.horizontal.repeat(40)}${RESET}`);

    // Show preview
    const lines = state.content.split('\n').slice(0, 12);
    for (const line of lines) {
      writeLine(`  ${colors.dim}${truncate(line, 70)}${RESET}`);
    }

    if (state.content.split('\n').length > 12) {
      writeLine(`  ${colors.dim}... (more content)${RESET}`);
    }
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads memory query ${colors.cyan}"<term>"${RESET}   ${colors.dim}Search memory${RESET}`);
  writeLine();
}

export async function memoryUpdateCommand(
  squadName: string,
  content: string,
  options: MemoryOptions
): Promise<void> {
  const agentName = options.agent || `${squadName}-lead`;
  const type = (options.type || 'learnings') as 'state' | 'output' | 'learnings' | 'feedback';

  writeLine();

  try {
    appendToMemory(squadName, agentName, type, content);
    writeLine(`  ${icons.success} Updated ${colors.cyan}${type}${RESET} for ${colors.white}${squadName}/${agentName}${RESET}`);
  } catch (error) {
    writeLine(`  ${icons.error} ${colors.red}Failed to update memory: ${error}${RESET}`);
    process.exit(1);
  }

  writeLine();
}

export async function memoryListCommand(): Promise<void> {
  const memoryDir = findMemoryDir();

  if (!memoryDir) {
    writeLine(`  ${colors.red}No .agents/memory directory found${RESET}`);
    process.exit(1);
  }

  const entries = listMemoryEntries(memoryDir);

  // Group by squad
  const bySquad: Record<string, typeof entries> = {};
  for (const entry of entries) {
    if (!bySquad[entry.squad]) {
      bySquad[entry.squad] = [];
    }
    bySquad[entry.squad].push(entry);
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}memory list${RESET}`);
  writeLine();

  const squadNames = Object.keys(bySquad);
  writeLine(`  ${colors.cyan}${entries.length}${RESET} entries across ${squadNames.length} squads`);
  writeLine();

  // Table
  const w = { squad: 16, agents: 8, types: 28 };
  const tableWidth = w.squad + w.agents + w.types + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.squad)}${RESET}` +
    `${bold}${padEnd('AGENTS', w.agents)}${RESET}` +
    `${bold}TYPES${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const [squad, squadEntries] of Object.entries(bySquad)) {
    const agents = new Set(squadEntries.map(e => e.agent));
    const types = [...new Set(squadEntries.map(e => e.type))].join(', ');
    const typesDisplay = truncate(types, w.types - 2);

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(squad, w.squad)}${RESET}` +
      `${padEnd(String(agents.size), w.agents)}` +
      `${colors.dim}${padEnd(typesDisplay, w.types)}${RESET}` +
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}<squad>${RESET}     ${colors.dim}View squad memory${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads memory query ${colors.cyan}"<term>"${RESET}   ${colors.dim}Search all memory${RESET}`);
  writeLine();
}
