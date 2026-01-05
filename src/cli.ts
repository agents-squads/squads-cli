import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Command } from 'commander';
import chalk from 'chalk';
import { version } from './version.js';

// Load .env from multiple locations (first found wins)
const envPaths = [
  join(process.cwd(), '.env'),
  join(process.cwd(), '..', 'hq', '.env'),
  join(homedir(), 'agents-squads', 'hq', '.env'),
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    config({ path: envPath, quiet: true });
    break;
  }
}
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { listCommand } from './commands/list.js';
import { statusCommand } from './commands/status.js';
import {
  memoryQueryCommand,
  memoryShowCommand,
  memoryUpdateCommand,
  memoryListCommand,
  memorySearchCommand,
  memoryExtractCommand
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
import { updateCommand } from './commands/update.js';
import { progressCommand, progressStartCommand, progressCompleteCommand } from './commands/progress.js';
import { resultsCommand } from './commands/results.js';
import { workersCommand } from './commands/workers.js';
import { sessionsCommand, sessionsHistoryCommand, sessionsSummaryCommand, SessionSummaryData } from './commands/sessions.js';
import { sessionStartCommand, sessionStopCommand, sessionHeartbeatCommand, detectSquadCommand } from './commands/session.js';
import { registerExitHandler } from './lib/telemetry.js';
import {
  stackInitCommand,
  stackStatusCommand,
  stackEnvCommand,
  stackUpCommand,
  stackDownCommand,
  stackHealthCommand,
  stackLogsCommand,
  applyStackConfig
} from './commands/stack.js';
import { registerTriggerCommand } from './commands/trigger.js';

// Load stack config from ~/.squadsrc (if exists)
applyStackConfig();

// Register telemetry exit handler early
registerExitHandler();

const program = new Command();

program
  .name('squads')
  .description('A CLI for humans and agents')
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
  .option('-t, --timeout <minutes>', 'Execution timeout in minutes (default: 30)', '30')
  .action((target, options) => runCommand(target, { ...options, timeout: parseInt(options.timeout, 10) }));

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
  .option('-f, --full', 'Include GitHub PR/issue stats (slower, ~30s)')
  .action((options) => dashboardCommand({ ...options, fast: !options.full }));

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

// Workers command - show running processes and tasks
program
  .command('workers')
  .description('Show active workers: Claude sessions, tasks, dev servers')
  .option('-v, --verbose', 'Show more details')
  .option('-k, --kill <pid>', 'Kill a process by PID')
  .action(workersCommand);

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
  .description('Sync memory from git: pull remote changes, process commits, optionally push')
  .option('-v, --verbose', 'Show detailed commit info')
  .option('-p, --push', 'Push local memory changes to remote after sync')
  .option('--no-pull', 'Skip pulling from remote')
  .action((options) => syncCommand({ verbose: options.verbose, push: options.push, pull: options.pull }));

memory
  .command('search <query>')
  .description('Search conversations stored in postgres (via squads-bridge)')
  .option('-l, --limit <limit>', 'Number of results', '10')
  .option('-r, --role <role>', 'Filter by role: user, assistant, thinking')
  .option('-i, --importance <importance>', 'Filter by importance: low, normal, high')
  .action((query, opts) => memorySearchCommand(query, {
    limit: parseInt(opts.limit, 10),
    role: opts.role,
    importance: opts.importance
  }));

memory
  .command('extract')
  .description('Extract memories from recent conversations into Engram')
  .option('-s, --session <session>', 'Extract specific session only')
  .option('-h, --hours <hours>', 'Look back period in hours', '24')
  .option('-d, --dry-run', 'Preview without sending to Engram')
  .action((opts) => memoryExtractCommand({
    session: opts.session,
    hours: parseInt(opts.hours, 10),
    dryRun: opts.dryRun
  }));

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

// Sessions command group - list active sessions and history
const sessions = program
  .command('sessions')
  .description('Show active Claude Code sessions across squads')
  .option('-v, --verbose', 'Show session details')
  .option('-j, --json', 'Output as JSON')
  .action(sessionsCommand);

sessions
  .command('history')
  .description('Show session history and statistics')
  .option('-d, --days <days>', 'Days of history to show', '7')
  .option('-s, --squad <squad>', 'Filter by squad')
  .option('-j, --json', 'Output as JSON')
  .action((options) => sessionsHistoryCommand({
    days: parseInt(options.days, 10),
    squad: options.squad,
    json: options.json,
  }));

sessions
  .command('summary')
  .description('Show pretty session summary (auto-detects current session or pass JSON)')
  .option('-d, --data <json>', 'JSON data for summary (overrides auto-detection)')
  .option('-f, --file <path>', 'Path to JSON file with summary data')
  .option('-j, --json', 'Output as JSON instead of pretty format')
  .action(async (options) => {
    const { buildCurrentSessionSummary } = await import('./commands/sessions.js');
    let data: SessionSummaryData;

    if (options.file) {
      // Read from file
      const { readFileSync } = await import('fs');
      data = JSON.parse(readFileSync(options.file, 'utf-8'));
    } else if (options.data) {
      // Parse from --data argument
      data = JSON.parse(options.data);
    } else if (!process.stdin.isTTY) {
      // Read from stdin only if piped
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      const input = Buffer.concat(chunks).toString('utf-8').trim();
      if (input) {
        data = JSON.parse(input);
      } else {
        data = await buildCurrentSessionSummary();
      }
    } else {
      // Auto-detect current session
      data = await buildCurrentSessionSummary();
    }

    await sessionsSummaryCommand(data, { json: options.json });
  });

// Session command group - lifecycle management
const session = program
  .command('session')
  .description('Manage current session lifecycle');

session
  .command('start')
  .description('Register a new session')
  .option('-s, --squad <squad>', 'Override squad detection')
  .option('-q, --quiet', 'Suppress output')
  .action((options) => sessionStartCommand({ squad: options.squad, quiet: options.quiet }));

session
  .command('stop')
  .description('End current session')
  .option('-q, --quiet', 'Suppress output')
  .action((options) => sessionStopCommand({ quiet: options.quiet }));

session
  .command('heartbeat')
  .description('Update session heartbeat')
  .option('-q, --quiet', 'Suppress output')
  .action((options) => sessionHeartbeatCommand({ quiet: options.quiet }));

// Detect squad command - useful for hooks
program
  .command('detect-squad')
  .description('Detect current squad based on cwd (for use in hooks)')
  .action(detectSquadCommand);

// Stack command group - manage local Docker stack
const stack = program
  .command('stack')
  .description('Manage local Docker stack (postgres, redis, langfuse, bridge)');

stack
  .command('init')
  .description('Auto-detect Docker containers and configure CLI connection')
  .action(stackInitCommand);

stack
  .command('status')
  .description('Show container health and connection status')
  .action(stackStatusCommand);

stack
  .command('env')
  .description('Print environment variables for shell export')
  .action(stackEnvCommand);

stack
  .command('up')
  .description('Start Docker containers via docker-compose')
  .action(stackUpCommand);

stack
  .command('down')
  .description('Stop Docker containers')
  .action(stackDownCommand);

stack
  .command('health')
  .description('Comprehensive health check with diagnostics')
  .option('-v, --verbose', 'Show logs for unhealthy services')
  .action((options) => stackHealthCommand(options.verbose));

stack
  .command('logs <service>')
  .description('Show logs for a service (postgres, redis, neo4j, bridge, langfuse, mem0, engram)')
  .option('-n, --tail <lines>', 'Number of lines to show', '50')
  .action((service, options) => stackLogsCommand(service, parseInt(options.tail, 10)));

// Trigger command group - smart value-driven triggers
registerTriggerCommand(program);

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

// Update command
program
  .command('update')
  .description('Check for and install updates')
  .option('-y, --yes', 'Auto-confirm update without prompting')
  .option('-c, --check', 'Check for updates without installing')
  .action((options) => updateCommand(options));

// Parse arguments (use parseAsync to properly await async actions)
await program.parseAsync();

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

${chalk.dim('Smart Triggers:')}
  ${chalk.cyan('squads trigger list')}                 View all triggers
  ${chalk.cyan('squads trigger sync')}                 Sync from SQUAD.md
  ${chalk.cyan('squads trigger fire <name>')}          Manually fire trigger

${chalk.dim('Examples:')}
  ${chalk.cyan('squads run website')}                  Run website squad
  ${chalk.cyan('squads goal set finance "Track costs"')} Set finance goal
  ${chalk.cyan('squads trigger status')}               Scheduler health

${chalk.dim('Run')} ${chalk.cyan('squads --help')} ${chalk.dim('for all commands.')}
`);
}
