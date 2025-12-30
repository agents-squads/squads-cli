import { Command } from 'commander';
import chalk from 'chalk';
import { version } from './version.js';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { listCommand } from './commands/list.js';
import { statusCommand } from './commands/status.js';
import {
  memoryQueryCommand,
  memoryShowCommand,
  memoryUpdateCommand,
  memoryListCommand
} from './commands/memory.js';

const program = new Command();

program
  .name('squads')
  .description('CLI for managing AI agent squads')
  .version(version);

// Init command
program
  .command('init')
  .description('Initialize a new squad project')
  .option('-t, --template <template>', 'Project template', 'default')
  .action(initCommand);

// Run command - runs squads or individual agents
program
  .command('run <target>')
  .description('Run a squad or agent')
  .option('-v, --verbose', 'Verbose output')
  .option('-d, --dry-run', 'Show what would be run without executing')
  .option('-a, --agent <agent>', 'Run specific agent within squad')
  .action(runCommand);

// List command
program
  .command('list')
  .description('List agents and squads')
  .option('-s, --squads', 'List squads only')
  .option('-a, --agents', 'List agents only')
  .action(listCommand);

// Status command
program
  .command('status [squad]')
  .description('Show squad status and state')
  .option('-v, --verbose', 'Show detailed status')
  .action(statusCommand);

// Memory command group
const memory = program
  .command('memory')
  .description('Query and manage squad memory');

memory
  .command('query <query>')
  .description('Search across all squad memory')
  .option('-s, --squad <squad>', 'Limit search to specific squad')
  .option('-a, --agent <agent>', 'Limit search to specific agent')
  .action(memoryQueryCommand);

memory
  .command('show <squad>')
  .description('Show memory for a squad')
  .action(memoryShowCommand);

memory
  .command('update <squad> <content>')
  .description('Add to squad memory')
  .option('-a, --agent <agent>', 'Specific agent (default: squad-lead)')
  .option('-t, --type <type>', 'Memory type: state, learnings, feedback', 'learnings')
  .action(memoryUpdateCommand);

memory
  .command('list')
  .description('List all memory entries')
  .action(memoryListCommand);

// Parse arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  console.log(`
${chalk.bold.magenta('squads')} - AI agent squad management

${chalk.dim('Quick start:')}
  ${chalk.cyan('squads init')}              Initialize a new project
  ${chalk.cyan('squads run <squad>')}       Run a squad (e.g., squads run intel-squad)
  ${chalk.cyan('squads status')}            View all squads status
  ${chalk.cyan('squads memory query')}      Search squad memory

${chalk.dim('Examples:')}
  ${chalk.cyan('squads run website')}       Run the website squad
  ${chalk.cyan('squads status intel')}      View intel squad status
  ${chalk.cyan('squads memory query "MCP"')} Search for MCP across all memory

${chalk.dim('Run')} ${chalk.cyan('squads --help')} ${chalk.dim('for all commands.')}
`);
}
