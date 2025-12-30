import chalk from 'chalk';
import {
  findMemoryDir,
  searchMemory,
  getSquadState,
  appendToMemory,
  listMemoryEntries
} from '../lib/memory.js';

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
    console.error(chalk.red('No .agents/memory directory found.'));
    console.log(chalk.dim('Run `squads init` to create one.'));
    process.exit(1);
  }

  console.log(chalk.dim(`Searching for: "${query}"\n`));

  const results = searchMemory(query, memoryDir);

  if (results.length === 0) {
    console.log(chalk.yellow('No results found.'));
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

  console.log(chalk.green(`Found ${filtered.length} result(s):\n`));

  for (const result of filtered.slice(0, 10)) {
    const { entry, matches, score } = result;

    console.log(
      chalk.cyan(`${entry.squad}/${entry.agent}`) +
      chalk.dim(` (${entry.type})`) +
      chalk.dim(` score: ${score.toFixed(1)}`)
    );

    for (const match of matches) {
      // Highlight the query in the match
      const highlighted = match.replace(
        new RegExp(query, 'gi'),
        (m) => chalk.yellow.bold(m)
      );
      console.log(chalk.dim('  →'), highlighted);
    }

    console.log();
  }

  if (filtered.length > 10) {
    console.log(chalk.dim(`... and ${filtered.length - 10} more results`));
  }
}

export async function memoryShowCommand(
  squadName: string,
  options: MemoryOptions
): Promise<void> {
  const memoryDir = findMemoryDir();

  if (!memoryDir) {
    console.error(chalk.red('No .agents/memory directory found.'));
    process.exit(1);
  }

  const states = getSquadState(squadName);

  if (states.length === 0) {
    console.log(chalk.yellow(`No memory found for squad: ${squadName}`));
    return;
  }

  console.log(chalk.bold.magenta(`Memory: ${squadName}\n`));

  for (const state of states) {
    console.log(chalk.cyan(`Agent: ${state.agent}`));
    console.log(chalk.dim('─'.repeat(40)));

    // Show first 500 chars of state
    const preview = state.content.slice(0, 800);
    console.log(preview);

    if (state.content.length > 800) {
      console.log(chalk.dim(`\n... (${state.content.length - 800} more chars)`));
    }

    console.log();
  }
}

export async function memoryUpdateCommand(
  squadName: string,
  content: string,
  options: MemoryOptions
): Promise<void> {
  const agentName = options.agent || `${squadName}-lead`;
  const type = (options.type || 'learnings') as 'state' | 'output' | 'learnings' | 'feedback';

  try {
    appendToMemory(squadName, agentName, type, content);
    console.log(chalk.green(`✓ Updated ${type} for ${squadName}/${agentName}`));
  } catch (error) {
    console.error(chalk.red(`Failed to update memory: ${error}`));
    process.exit(1);
  }
}

export async function memoryListCommand(): Promise<void> {
  const memoryDir = findMemoryDir();

  if (!memoryDir) {
    console.error(chalk.red('No .agents/memory directory found.'));
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

  console.log(chalk.bold.magenta('Memory Overview\n'));

  for (const [squad, squadEntries] of Object.entries(bySquad)) {
    console.log(chalk.cyan(squad));

    // Group by agent
    const byAgent: Record<string, string[]> = {};
    for (const entry of squadEntries) {
      if (!byAgent[entry.agent]) {
        byAgent[entry.agent] = [];
      }
      byAgent[entry.agent].push(entry.type);
    }

    for (const [agent, types] of Object.entries(byAgent)) {
      console.log(`  ${chalk.white(agent)}: ${chalk.dim(types.join(', '))}`);
    }

    console.log();
  }
}
