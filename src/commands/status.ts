import chalk from 'chalk';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  findSquadsDir,
  loadSquad,
  listSquads,
  listAgents
} from '../lib/squad-parser.js';
import { findMemoryDir, getSquadState } from '../lib/memory.js';

interface StatusOptions {
  verbose?: boolean;
}

export async function statusCommand(
  squadName?: string,
  options: StatusOptions = {}
): Promise<void> {
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    console.error(chalk.red('No .agents/squads directory found.'));
    console.log(chalk.dim('Run `squads init` to create one.'));
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

  console.log(chalk.bold.magenta('\nSquads Status Overview\n'));

  console.log(chalk.dim('─'.repeat(60)));
  console.log(
    chalk.bold('Squad'.padEnd(20)) +
    chalk.bold('Agents'.padEnd(10)) +
    chalk.bold('Memory'.padEnd(15)) +
    chalk.bold('Last Activity')
  );
  console.log(chalk.dim('─'.repeat(60)));

  for (const squadName of squads) {
    const squad = loadSquad(squadName);
    const agents = listAgents(squadsDir, squadName);

    // Check memory
    let memoryStatus = chalk.dim('none');
    let lastActivity = chalk.dim('unknown');

    if (memoryDir) {
      const squadMemoryPath = join(memoryDir, squadName);
      if (existsSync(squadMemoryPath)) {
        const states = getSquadState(squadName);
        memoryStatus = chalk.green(`${states.length} entries`);

        // Find most recent file
        let mostRecent = 0;
        for (const state of states) {
          const stat = statSync(state.path);
          if (stat.mtimeMs > mostRecent) {
            mostRecent = stat.mtimeMs;
          }
        }

        if (mostRecent > 0) {
          const date = new Date(mostRecent);
          const daysAgo = Math.floor((Date.now() - mostRecent) / (1000 * 60 * 60 * 24));
          if (daysAgo === 0) {
            lastActivity = chalk.green('today');
          } else if (daysAgo === 1) {
            lastActivity = chalk.green('yesterday');
          } else if (daysAgo < 7) {
            lastActivity = chalk.yellow(`${daysAgo}d ago`);
          } else {
            lastActivity = chalk.dim(`${daysAgo}d ago`);
          }
        }
      }
    }

    console.log(
      chalk.cyan(squadName.padEnd(20)) +
      String(agents.length).padEnd(10) +
      memoryStatus.padEnd(24) +  // extra for color codes
      lastActivity
    );
  }

  console.log(chalk.dim('─'.repeat(60)));
  console.log();

  console.log(chalk.dim('Commands:'));
  console.log(`  ${chalk.cyan('squads status <squad>')}  View detailed squad status`);
  console.log(`  ${chalk.cyan('squads run <squad>')}     Run a squad`);
  console.log(`  ${chalk.cyan('squads memory query')}    Search squad memory`);
}

async function showSquadStatus(
  squadName: string,
  squadsDir: string,
  options: StatusOptions
): Promise<void> {
  const squad = loadSquad(squadName);

  if (!squad) {
    console.error(chalk.red(`Squad "${squadName}" not found.`));
    process.exit(1);
  }

  console.log(`
${chalk.bold.magenta('Squad:')} ${chalk.cyan(squad.name)}
${chalk.dim('Mission:')} ${squad.mission || 'Not defined'}
`);

  // Agents
  console.log(chalk.bold('Agents:'));
  const agents = listAgents(squadsDir, squadName);

  for (const agent of agents) {
    const status = agent.status?.toLowerCase() === 'active'
      ? chalk.green('●')
      : chalk.dim('○');
    console.log(`  ${status} ${chalk.white(agent.name)}`);
    if (options.verbose && agent.role) {
      console.log(chalk.dim(`      ${agent.role}`));
    }
  }

  // Pipelines
  if (squad.pipelines.length > 0) {
    console.log();
    console.log(chalk.bold('Pipelines:'));
    for (const pipeline of squad.pipelines) {
      console.log(`  ${chalk.dim(pipeline.agents.join(' → '))}`);
    }
  }

  // Memory state
  const memoryDir = findMemoryDir();
  if (memoryDir) {
    const states = getSquadState(squadName);

    if (states.length > 0) {
      console.log();
      console.log(chalk.bold('Memory:'));

      for (const state of states) {
        // Extract key info from state
        const lines = state.content.split('\n').filter(l => l.trim());
        const title = lines.find(l => l.startsWith('#'))?.replace('#', '').trim() || state.agent;

        // Find "Updated" line
        const updated = state.content.match(/Updated:\s*(\S+)/)?.[1] || 'unknown';

        console.log(`  ${chalk.white(state.agent)}`);
        console.log(chalk.dim(`    Last updated: ${updated}`));

        // Show signals or key state
        if (options.verbose) {
          const signalsMatch = state.content.match(/## Active Signals([\s\S]*?)(?=##|$)/);
          if (signalsMatch) {
            const signalLines = signalsMatch[1]
              .split('\n')
              .filter(l => l.match(/^\d+\./))
              .slice(0, 3);

            for (const sig of signalLines) {
              console.log(chalk.dim(`    ${sig.trim()}`));
            }
          }
        }
      }
    }
  }

  // Suggested commands
  console.log();
  console.log(chalk.dim('Commands:'));
  console.log(`  ${chalk.cyan(`squads run ${squadName}`)}           Run the squad`);
  console.log(`  ${chalk.cyan(`squads memory show ${squadName}`)}   View full memory`);
  console.log(`  ${chalk.cyan(`squads status ${squadName} -v`)}     Verbose status`);
}
