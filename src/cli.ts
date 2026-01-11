import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Command } from 'commander';
import chalk from 'chalk';
import { version } from './version.js';
import { autoUpdateOnStartup } from './lib/update.js';

// Disable colors when output is piped (not a TTY)
// This ensures piped output is clean for parsing
if (!process.stdout.isTTY) {
  chalk.level = 0;
}

// Handle EPIPE gracefully when output is piped through head/tail/grep
// These commands close the pipe early, which is normal Unix behavior
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
});

process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') {
    process.exit(0);
  }
  throw err;
});

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
import {
  learnCommand,
  learnShowCommand,
  learnSearchCommand
} from './commands/learn.js';
import { dashboardCommand } from './commands/dashboard.js';
import { issuesCommand } from './commands/issues.js';
import { solveIssuesCommand } from './commands/solve-issues.js';
import { openIssuesCommand } from './commands/open-issues.js';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login.js';
import { updateCommand } from './commands/update.js';
import { progressCommand, progressStartCommand, progressCompleteCommand } from './commands/progress.js';
import { resultsCommand } from './commands/results.js';
import { historyCommand } from './commands/history.js';
import { healthCommand } from './commands/health.js';
import { workersCommand } from './commands/workers.js';
import { contextFeedCommand } from './commands/context-feed.js';
import { watchCommand } from './commands/watch.js';
import { liveCommand } from './commands/live.js';
import { topCommand } from './commands/top.js';
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
import { registerSkillCommand } from './commands/skill.js';
import { registerPermissionsCommand } from './commands/permissions.js';
import { contextShowCommand, contextListCommand, contextActivateCommand } from './commands/context.js';
import { costCommand, budgetCheckCommand } from './commands/cost.js';
import { execListCommand, execShowCommand, execStatsCommand } from './commands/exec.js';
import {
  tonightCommand,
  tonightStatusCommand,
  tonightStopCommand,
  tonightReportCommand
} from './commands/tonight.js';

// Load stack config from ~/.squadsrc (if exists)
applyStackConfig();

// Seamless auto-update on startup (like Gemini CLI)
// Runs in background, shows message on success
// Set SQUADS_NO_AUTO_UPDATE=1 to disable
await autoUpdateOnStartup();

// Register telemetry exit handler early
registerExitHandler();

const program = new Command();

program
  .name('squads')
  .description('A CLI for humans and agents')
  .version(version)
  // Enable typo suggestions (Commander.js built-in feature)
  .showSuggestionAfterError(true)
  // Configure help to exit with code 0 (Unix convention)
  .configureOutput({
    outputError: (str, write) => write(str),
  })
  .exitOverride((err) => {
    // Exit code 0 for help display (Unix convention)
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      process.exit(0);
    }
    // For other commander errors, use the default exit code
    if (err.exitCode !== undefined) {
      process.exit(err.exitCode);
    }
    throw err;
  })
  // Default action when no command provided - show status dashboard
  .action(async () => {
    const { gradient, colors, RESET } = await import('./lib/terminal.js');
    const { checkForUpdate } = await import('./lib/update.js');

    console.log();
    console.log(`  ${gradient('squads')} ${colors.dim}v${version}${RESET}`);
    console.log();

    // Check for updates
    const updateInfo = checkForUpdate();
    if (updateInfo.updateAvailable) {
      console.log(`  ${colors.cyan}⬆${RESET} Update available: ${colors.dim}${updateInfo.currentVersion}${RESET} → ${colors.green}${updateInfo.latestVersion}${RESET}`);
      console.log(`  ${colors.dim}Run \`squads update\` to install${RESET}`);
      console.log();
    }

    // Run status command to show all squads (includes quick commands)
    await statusCommand(undefined, {});
  });

// Init command
program
  .command('init')
  .description('Initialize a new squad project')
  .option('-t, --template <template>', 'Project template', 'default')
  .option('--skip-infra', 'Skip infrastructure setup prompt')
  .option('--force', 'Skip requirement checks (for CI/testing)')
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
  .option('-p, --parallel', 'Run all agents in parallel (N tmux sessions)')
  .option('-l, --lead', 'Lead mode: single orchestrator using Task tool for parallelization')
  .option('-f, --foreground', 'Run in foreground (no tmux, blocks terminal)')
  .option('--use-api', 'Use API credits instead of subscription')
  .option('--effort <level>', 'Effort level: high, medium, low (default: from SQUAD.md or high)')
  .option('--skills <skills...>', 'Skills to load (skill IDs or local paths)')
  .addHelpText('after', `
Examples:
  $ squads run engineering              Run whole squad (shows agent list)
  $ squads run engineering/code-review  Run specific agent (slash notation)
  $ squads run engineering -a code-review  Same as above (flag notation)
  $ squads run engineering --dry-run    Preview what would run
  $ squads run engineering --execute    Execute via Claude CLI
  $ squads run engineering --parallel   Run all agents in parallel (tmux)
  $ squads run engineering --lead       Single orchestrator with Task tool
  $ squads run engineering -f           Run in foreground (blocks terminal)
`)
  .action((target, options) => runCommand(target, { ...options, timeout: parseInt(options.timeout, 10) }));

// List command
program
  .command('list')
  .description('List agents and squads')
  .option('-s, --squads', 'List squads only')
  .option('-a, --agents', 'List agents only')
  .option('-v, --verbose', 'Show additional details')
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

// Env command - squad execution environment (MCP, skills, budget, model)
const env = program
  .command('env')
  .description('View squad execution environment (MCP, skills, model, budget)');

env
  .command('show <squad>')
  .description('Show execution environment for a squad')
  .option('--json', 'Output as JSON')
  .action(contextShowCommand);

env
  .command('list')
  .description('List execution environment for all squads')
  .option('--json', 'Output as JSON')
  .action(contextListCommand);

env
  .command('activate <squad>')
  .description('Activate execution context for a squad (generates scoped MCP config)')
  .option('-d, --dry-run', 'Show what would be generated without writing files')
  .option('-f, --force', 'Force regeneration even if config exists')
  .option('--json', 'Output as JSON')
  .action(contextActivateCommand);

// Cost command - cost introspection for self-improvement
program
  .command('cost')
  .description('Show cost summary (today, week, by squad)')
  .option('-s, --squad <squad>', 'Filter to specific squad')
  .option('--json', 'Output as JSON')
  .action(costCommand);

// Budget check command - pre-flight budget validation
program
  .command('budget')
  .description('Check budget status for a squad')
  .argument('<squad>', 'Squad to check')
  .option('--json', 'Output as JSON')
  .action(budgetCheckCommand);

// Exec command group - execution history introspection
const exec = program
  .command('exec')
  .description('View execution history and statistics');

exec
  .command('list')
  .description('List recent executions')
  .option('-s, --squad <squad>', 'Filter by squad')
  .option('-a, --agent <agent>', 'Filter by agent')
  .option('--status <status>', 'Filter by status (running, completed, failed)')
  .option('-n, --limit <n>', 'Number of executions to show', '20')
  .option('--json', 'Output as JSON')
  .action((options) => execListCommand({ ...options, limit: parseInt(options.limit, 10) }));

exec
  .command('show <id>')
  .description('Show execution details')
  .option('--json', 'Output as JSON')
  .action(execShowCommand);

exec
  .command('stats')
  .description('Show execution statistics')
  .option('-s, --squad <squad>', 'Filter by squad')
  .option('--json', 'Output as JSON')
  .action(execStatsCommand);

// Default action: show list
exec.action((options) => execListCommand(options));

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

// History command - show recent agent executions
program
  .command('history')
  .description('Show recent agent execution history')
  .option('-d, --days <days>', 'Days to look back', '7')
  .option('-s, --squad <squad>', 'Filter by squad')
  .option('-v, --verbose', 'Show cost and token details')
  .option('-j, --json', 'Output as JSON')
  .action((options) => historyCommand(options));

// Context command - business context for alignment
program
  .command('context')
  .alias('feed')
  .description('Get business context for alignment: goals, memory, costs, activity')
  .option('-s, --squad <squad>', 'Focus on specific squad')
  .option('-t, --topic <topic>', 'Search memory for relevant context')
  .option('-a, --agent', 'Output JSON for agent consumption')
  .option('-j, --json', 'Output as JSON (alias for --agent)')
  .option('-v, --verbose', 'Show additional details')
  .action((options) => contextFeedCommand(options));

// Workers command - show running processes and tasks
program
  .command('workers')
  .description('Show active workers: Claude sessions, tasks, dev servers')
  .option('-v, --verbose', 'Show more details')
  .option('-k, --kill <pid>', 'Kill a process by PID')
  .action(workersCommand);

// Health command - quick infrastructure check
program
  .command('health')
  .description('Quick health check for all infrastructure services')
  .option('-v, --verbose', 'Show optional services')
  .action((options) => healthCommand(options));

// Watch command - live refresh any command
program
  .command('watch <command> [args...]')
  .description('Live refresh any squads command (like Unix watch)')
  .option('-n, --interval <seconds>', 'Refresh interval in seconds', '2')
  .option('--no-clear', 'Don\'t clear screen between refreshes')
  .action((command, args, options) => watchCommand(command, args, {
    interval: parseInt(options.interval, 10),
    clear: options.clear
  }));

// Live command - TUI dashboard
program
  .command('live')
  .description('Live TUI dashboard with real-time metrics (like htop)')
  .option('-m, --minimal', 'Minimal view')
  .option('-f, --focus <panel>', 'Focus on specific panel (agents, cost, activity, memory)')
  .action((options) => liveCommand(options));

// Top command - live process table like Unix top
program
  .command('top')
  .description('Live process table (like Unix top) - numbers update in place')
  .action(() => topCommand());

// Memory command group
const memory = program
  .command('memory')
  .description('Query and manage squad memory')
  .addHelpText('after', `
Examples:
  $ squads memory query "pricing"     Search all memory for "pricing"
  $ squads memory show engineering    View engineering squad's memory
  $ squads memory update research "Found: MCP adoption at 15%"
  $ squads memory list                List all memory entries
  $ squads memory sync --push         Sync and push to git
`)
  .action(() => {
    memory.outputHelp();
  });

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
  .description('Manage squad goals')
  .action(() => {
    goal.outputHelp();
  });

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

// Learn command - capture learnings for autonomous improvement
program
  .command('learn <insight>')
  .description('Capture a learning for future sessions')
  .option('-s, --squad <squad>', 'Squad to associate learning with')
  .option('-c, --category <category>', 'Category: success, failure, pattern, tip')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .option('--context <context>', 'Additional context')
  .action(learnCommand);

const learn = program
  .command('learnings')
  .description('View and search learnings');

learn
  .command('show <squad>')
  .description('Show learnings for a squad')
  .option('-n, --limit <n>', 'Number to show', '10')
  .option('-c, --category <category>', 'Filter by category')
  .option('--tag <tag>', 'Filter by tag')
  .action(learnShowCommand);

learn
  .command('search <query>')
  .description('Search learnings across all squads')
  .option('-n, --limit <n>', 'Max results', '10')
  .action(learnSearchCommand);

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

// Skill command group - Agent Skills API
registerSkillCommand(program);

// Permissions command group - Phase 3 execution contexts
registerPermissionsCommand(program);

// Tonight command group - autonomous overnight execution
const tonight = program
  .command('tonight')
  .description('Run agents autonomously overnight with safety limits');

tonight
  .command('run <targets...>')
  .description('Start tonight mode with specified squads/agents')
  .option('-c, --cost-cap <usd>', 'Max USD to spend (default: 50)', '50')
  .option('-s, --stop-at <time>', 'Stop time HH:MM (default: 07:00)', '07:00')
  .option('-r, --max-retries <n>', 'Max restarts per agent (default: 3)', '3')
  .option('-d, --dry-run', 'Show what would run without executing')
  .option('-v, --verbose', 'Verbose output')
  .action((targets, options) => tonightCommand(targets, {
    costCap: parseFloat(options.costCap),
    stopAt: options.stopAt,
    maxRetries: parseInt(options.maxRetries, 10),
    dryRun: options.dryRun,
    verbose: options.verbose,
  }));

tonight
  .command('status')
  .description('Check tonight mode status')
  .action(tonightStatusCommand);

tonight
  .command('stop')
  .description('Stop all tonight agents and generate report')
  .action(tonightStopCommand);

tonight
  .command('report')
  .description('Show latest tonight report')
  .action(tonightReportCommand);

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

// Version command (following npm/docker pattern)
program
  .command('version')
  .description('Show version information')
  .action(() => {
    console.log(`squads-cli ${version}`);
  });

// Global error handler for uncaught exceptions
// Provides helpful recovery steps instead of raw stack traces (#31)
function handleError(error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));

  // Check for common error types and provide helpful messages
  if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
    console.error(chalk.red('\nConnection error:'), err.message);
    console.error(chalk.dim('\nPossible fixes:'));
    console.error(chalk.dim('  1. Check if Docker containers are running: squads stack status'));
    console.error(chalk.dim('  2. Start the stack: squads stack up'));
    console.error(chalk.dim('  3. Check your network connection'));
  } else if (err.message.includes('ENOENT')) {
    console.error(chalk.red('\nFile not found:'), err.message);
    console.error(chalk.dim('\nPossible fixes:'));
    console.error(chalk.dim('  1. Make sure you are in the correct directory'));
    console.error(chalk.dim('  2. Initialize the project: squads init'));
  } else if (err.message.includes('permission denied') || err.message.includes('EACCES')) {
    console.error(chalk.red('\nPermission denied:'), err.message);
    console.error(chalk.dim('\nPossible fixes:'));
    console.error(chalk.dim('  1. Check file permissions'));
    console.error(chalk.dim('  2. Avoid running with sudo if not needed'));
  } else if (err.message.includes('rate limit') || err.message.includes('429')) {
    console.error(chalk.red('\nRate limit exceeded'));
    console.error(chalk.dim('\nPossible fixes:'));
    console.error(chalk.dim('  1. Wait a few minutes and try again'));
    console.error(chalk.dim('  2. Check your API usage: squads dash'));
  } else {
    // Generic error with stack trace only in verbose mode
    console.error(chalk.red('\nError:'), err.message);
    if (process.env.DEBUG || process.env.VERBOSE) {
      console.error(chalk.dim('\nStack trace:'));
      console.error(chalk.dim(err.stack));
    } else {
      console.error(chalk.dim('\nRun with DEBUG=1 for more details'));
    }
  }

  console.error(chalk.dim('\nIf this persists, please report at:'));
  console.error(chalk.cyan('  https://github.com/agents-squads/squads-cli/issues\n'));

  process.exit(1);
}

// Register global error handlers
process.on('uncaughtException', handleError);
process.on('unhandledRejection', handleError);

// Parse arguments (use parseAsync to properly await async actions)
try {
  await program.parseAsync();
} catch (error) {
  handleError(error);
}

