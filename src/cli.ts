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
import {
  goalSetCommand,
  goalListCommand,
  goalCompleteCommand,
  goalProgressCommand
} from './commands/goal.js';
import {
  feedbackAddCommand,
  feedbackShowCommand,
  feedbackStatsCommand
} from './commands/feedback.js';
import { dashboardCommand } from './commands/dashboard.js';

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

// Dashboard command
program
  .command('dashboard')
  .alias('dash')
  .description('Show comprehensive goals and metrics dashboard')
  .option('-v, --verbose', 'Show additional details')
  .action(dashboardCommand);

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

// Goal command group
const goal = program
  .command('goal')
  .description('Manage squad goals');

goal
  .command('set <squad> <description>')
  .description('Set a goal for a squad')
  .option('-m, --metric <metrics...>', 'Metrics to track')
  .action(goalSetCommand);

goal
  .command('list [squad]')
  .description('List goals for squad(s)')
  .option('-a, --all', 'Show completed goals too')
  .action(goalListCommand);

goal
  .command('complete <squad> <index>')
  .description('Mark a goal as completed')
  .action(goalCompleteCommand);

goal
  .command('progress <squad> <index> <progress>')
  .description('Update goal progress')
  .action(goalProgressCommand);

// Feedback command group
const feedback = program
  .command('feedback')
  .description('Record and view execution feedback');

feedback
  .command('add <squad> <rating> <feedback>')
  .description('Add feedback for last execution (rating 1-5)')
  .option('-l, --learning <learnings...>', 'Learnings to extract')
  .action(feedbackAddCommand);

feedback
  .command('show <squad>')
  .description('Show feedback history')
  .option('-n, --limit <n>', 'Number of entries to show', '5')
  .action(feedbackShowCommand);

feedback
  .command('stats')
  .description('Show feedback summary across all squads')
  .action(feedbackStatsCommand);

// Parse arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  console.log(`
${chalk.bold.magenta('squads')} - AI agent squad management

${chalk.dim('Quick start:')}
  ${chalk.cyan('squads status')}                  View all squads status
  ${chalk.cyan('squads run <squad>')}             Run a squad
  ${chalk.cyan('squads memory query "<term>"')}   Search squad memory

${chalk.dim('Goals & Feedback:')}
  ${chalk.cyan('squads goal set <squad> "<goal>"')}    Set a goal
  ${chalk.cyan('squads goal list')}                    View active goals
  ${chalk.cyan('squads feedback add <squad> 4 "msg"')} Rate last execution

${chalk.dim('Examples:')}
  ${chalk.cyan('squads run website')}                  Run website squad
  ${chalk.cyan('squads goal set finance "Track costs"')} Set finance goal
  ${chalk.cyan('squads feedback stats')}               View feedback summary

${chalk.dim('Run')} ${chalk.cyan('squads --help')} ${chalk.dim('for all commands.')}
`);
}
