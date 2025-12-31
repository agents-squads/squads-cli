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
import { syncCommand } from './commands/sync.js';
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
import { issuesCommand } from './commands/issues.js';
import { solveIssuesCommand } from './commands/solve-issues.js';
import { openIssuesCommand } from './commands/open-issues.js';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login.js';
import { progressCommand, progressStartCommand, progressCompleteCommand } from './commands/progress.js';
import { resultsCommand } from './commands/results.js';

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
  .option('-e, --execute', 'Execute agent via Claude CLI (requires claude installed)')
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
  .option('-c, --ceo', 'Executive summary with priorities and blockers')
  .action(dashboardCommand);

// Issues command
program
  .command('issues')
  .description('Show GitHub issues across repos')
  .option('-o, --org <org>', 'GitHub organization', 'agents-squads')
  .option('-r, --repos <repos>', 'Comma-separated repo names')
  .action(issuesCommand);

// Solve issues command - close issues by creating PRs
program
  .command('solve-issues')
  .description('Solve ready-to-fix issues by creating PRs')
  .option('-r, --repo <repo>', 'Target repo (hq, agents-squads-web)')
  .option('-i, --issue <number>', 'Specific issue number', parseInt)
  .option('-d, --dry-run', 'Show what would be solved')
  .option('-e, --execute', 'Execute with Claude CLI')
  .action(solveIssuesCommand);

// Open issues command - run evaluators to find new issues
program
  .command('open-issues')
  .description('Run evaluators/critics to find and create issues')
  .option('-s, --squad <squad>', 'Target squad (website, engineering, etc.)')
  .option('-a, --agent <agent>', 'Specific evaluator agent')
  .option('-d, --dry-run', 'Show what would run')
  .option('-e, --execute', 'Execute with Claude CLI')
  .action(openIssuesCommand);

// Progress command - track agent task progress
const progress = program
  .command('progress')
  .description('Track active and completed agent tasks')
  .option('-v, --verbose', 'Show more activity')
  .action(progressCommand);

progress
  .command('start <squad> <description>')
  .description('Register a new active task')
  .action(progressStartCommand);

progress
  .command('complete <taskId>')
  .description('Mark a task as completed')
  .option('-f, --failed', 'Mark as failed instead')
  .action(progressCompleteCommand);

// Results command - KPI goals vs actuals
program
  .command('results [squad]')
  .description('Show squad results: git activity + KPI goals vs actuals')
  .option('-d, --days <days>', 'Days to look back', '7')
  .option('-v, --verbose', 'Show detailed KPIs per goal')
  .action((squad, options) => resultsCommand({ ...options, squad }));

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

memory
  .command('sync')
  .description('Sync memory from recent git commits (auto-update)')
  .option('-v, --verbose', 'Show detailed commit info')
  .action(syncCommand);

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

// Auth commands
program
  .command('login')
  .description('Log in to Squads (Pro & Enterprise)')
  .action(loginCommand);

program
  .command('logout')
  .description('Log out from Squads')
  .action(logoutCommand);

program
  .command('whoami')
  .description('Show current logged in user')
  .action(whoamiCommand);

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
