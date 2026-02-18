import { config } from 'dotenv';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { Command } from 'commander';
import chalk from 'chalk';
import { version } from './version.js';
import { autoUpdateOnStartup } from './lib/update.js';
import { colors as termColors, RESET as termReset, bold as termBold } from './lib/terminal.js';

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
import { autonomyCommand } from './commands/autonomy.js';
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
import { renderDashboard, showAvailableDashboards, findDashboard } from './lib/dashboard/index.js';
import { loginCommand, logoutCommand, whoamiCommand } from './commands/login.js';
import { updateCommand } from './commands/update.js';
import { progressCommand, progressStartCommand, progressCompleteCommand } from './commands/progress.js';
import { resultsCommand } from './commands/results.js';
import { historyCommand } from './commands/history.js';
import { healthCommand } from './commands/health.js';
import { contextFeedCommand } from './commands/context-feed.js';
import { sessionsCommand, sessionsHistoryCommand, sessionsSummaryCommand, SessionSummaryData } from './commands/sessions.js';
import { sessionStartCommand, sessionStopCommand, sessionHeartbeatCommand, detectSquadCommand } from './commands/session.js';
import { registerExitHandler } from './lib/telemetry.js';
import { applyStackConfig } from './lib/stack-config.js';
import { registerTriggerCommand } from './commands/trigger.js';
import { registerAutonomousCommand } from './commands/autonomous.js';
import { registerApprovalCommand } from './commands/approval.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerEvalCommand } from './commands/eval.js';
import { registerOrchestrateCommand } from './commands/orchestrate.js';
import { contextShowCommand, contextListCommand, contextActivateCommand, contextPromptCommand } from './commands/context.js';
import { costCommand, budgetCheckCommand } from './commands/cost.js';
import { execListCommand, execShowCommand, execStatsCommand } from './commands/exec.js';
import { providersCommand } from './commands/providers.js';
import {
  kpiShowCommand,
  kpiRecordCommand,
  kpiTrendCommand,
  kpiInsightsCommand,
  kpiListCommand,
} from './commands/kpi.js';

// Load stack config from ~/.squadsrc (if exists)
applyStackConfig();

// Seamless auto-update on startup (like Gemini CLI)
// Runs in background, shows message on success
// Set SQUADS_NO_AUTO_UPDATE=1 to disable
await autoUpdateOnStartup();

// Register telemetry exit handler early
registerExitHandler();

// Helper: show removed command message
function removedCommand(name: string, alternative: string): () => void {
  return () => {
    console.error(chalk.red(`\n  Command "${name}" has been removed.`));
    console.error(chalk.dim(`  ${alternative}\n`));
    process.exit(1);
  };
}

// ─── Friendly error messages for missing arguments (#317) ─────────────────────
// Maps command paths to user-friendly hints when required arguments are missing.
// Each entry: { message: plain-language explanation, example: usage example }
const friendlyArgErrors: Record<string, { message: string; example: string }> = {
  'run': {
    message: 'Specify which squad or agent to run.',
    example: 'squads run engineering            # run the whole squad\n  squads run engineering/code-review  # run a specific agent',
  },
  'orchestrate': {
    message: 'Specify which squad to orchestrate.',
    example: 'squads orchestrate intelligence',
  },
  'eval': {
    message: 'Specify which squad or agent to evaluate.',
    example: 'squads eval company           # evaluate all agents in squad\n  squads eval company/coo        # evaluate a specific agent',
  },
  'budget': {
    message: 'Specify which squad to check budget for.',
    example: 'squads budget engineering',
  },
  'goal set': {
    message: 'Provide the squad name and a goal description.',
    example: 'squads goal set marketing "Increase blog traffic by 20%"',
  },
  'goal complete': {
    message: 'Provide the squad name and the goal index to mark complete.',
    example: 'squads goal complete marketing 1',
  },
  'goal progress': {
    message: 'Provide the squad, goal index, and progress update.',
    example: 'squads goal progress marketing 1 "50% — halfway through campaign"',
  },
};

/**
 * Detect which command the user invoked from process.argv.
 * Returns the command path (e.g. "goal set" or "run").
 */
function detectCommandFromArgs(): string | null {
  // argv: [node, script, ...commands/options]
  const args = process.argv.slice(2).filter(a => !a.startsWith('-'));
  if (args.length === 0) return null;
  // Try two-word command first (e.g. "goal set"), then single word
  if (args.length >= 2) {
    const twoWord = `${args[0]} ${args[1]}`;
    if (friendlyArgErrors[twoWord]) return twoWord;
  }
  return args[0] || null;
}

/**
 * Handle Commander.js outputError: intercept "missing required argument"
 * errors and show friendly, colorized messages instead of raw format.
 */
function handleOutputError(str: string, write: (s: string) => void): void {
  const missingArgMatch = str.match(/^error: missing required argument '(.+)'/);
  if (missingArgMatch) {
    const argName = missingArgMatch[1];
    const command = detectCommandFromArgs();
    const hint = command ? friendlyArgErrors[command] : null;

    // Friendly error header
    process.stderr.write(`\n  ${termColors.red}Missing argument: ${termReset}${termBold}${argName}${termReset}\n`);

    if (hint) {
      process.stderr.write(`  ${hint.message}\n\n`);
      process.stderr.write(`  ${termColors.dim}Usage:${termReset}\n`);
      for (const line of hint.example.split('\n')) {
        process.stderr.write(`  ${termColors.cyan}$${termReset} ${line.trim()}\n`);
      }
    } else {
      process.stderr.write(`  Run the command with ${termColors.cyan}--help${termReset} for usage information.\n`);
    }

    process.stderr.write('\n');
    return;
  }

  // For all other errors (unknown option, etc.), pass through
  write(str);
}

const program = new Command();

program
  .name('squads')
  .description('Your AI workforce — business operating system for AI managers')
  .version(version)
  // Enable typo suggestions (Commander.js built-in feature)
  .showSuggestionAfterError(true)
  // Configure help to exit with code 0 (Unix convention)
  .configureOutput({
    outputError: handleOutputError,
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

// ─── Execute (daily operations) ──────────────────────────────────────────────

// Init command - plant the seed (manager agent + CLI skill + starter squads)
program
  .command('init')
  .description('Plant the seed: create manager agent, CLI skill, and starter squads')
  .option('-p, --provider <provider>', 'LLM provider (claude, gemini, openai, ollama, none)')
  .option('--skip-infra', 'Skip infrastructure setup prompt')
  .option('--force', 'Skip requirement checks (for CI/testing)')
  .option('-y, --yes', 'Accept all defaults (non-interactive mode)')
  .option('-q, --quick', 'Quick init - create files only, skip interactive prompts')
  .action(initCommand);

// Run command - execute squads or individual agents
program
  .command('run <target>')
  .description('Run a squad or agent')
  .option('-v, --verbose', 'Verbose output')
  .option('-d, --dry-run', 'Show what would be run without executing')
  .option('-a, --agent <agent>', 'Run specific agent within squad')
  .option('-t, --timeout <minutes>', 'Execution timeout in minutes (default: 30)', '30')
  .option('-p, --parallel', 'Run all agents in parallel (N tmux sessions)')
  .option('-l, --lead', 'Lead mode: single orchestrator using Task tool for parallelization')
  .option('-b, --background', 'Run agent in background (detached process)')
  .option('-w, --watch', 'Run in background but tail the log for visibility')
  .option('--use-api', 'Use API credits instead of subscription')
  .option('--effort <level>', 'Effort level: high, medium, low (default: from SQUAD.md or high)')
  .option('--skills <skills...>', 'Skills to load (skill IDs or local paths)')
  .option('--provider <provider>', 'LLM provider: anthropic, google, openai, mistral, xai, aider, ollama')
  .option('--model <model>', 'Model to use (e.g., opus, sonnet, haiku, gemini-2.5-flash, gpt-4o)')
  .option('--trigger <type>', 'Trigger source: manual, scheduled, event, smart (default: manual)')
  .option('-j, --json', 'Output as JSON')
  .addHelpText('after', `
Examples:
  $ squads run engineering              Run whole squad (shows agent list)
  $ squads run engineering/code-review  Run specific agent (slash notation)
  $ squads run engineering -a code-review  Same as above (flag notation)
  $ squads run engineering --dry-run    Preview what would run
  $ squads run engineering --parallel   Run all agents in parallel (tmux)
  $ squads run engineering --lead       Single orchestrator with Task tool
  $ squads run engineering -b           Run in background (detached)
  $ squads run engineering -w           Run in background but tail logs
  $ squads run research --provider=google  Use Gemini CLI instead of Claude
`)
  .action((target, options) => runCommand(target, { ...options, timeout: parseInt(options.timeout, 10) }));

// List command
program
  .command('list')
  .description('List agents and squads')
  .option('-s, --squads', 'List squads only')
  .option('-a, --agents', 'List agents only')
  .option('-v, --verbose', 'Show additional details')
  .option('-j, --json', 'Output as JSON')
  .action(listCommand);

// Orchestrate command - lead-coordinated squad execution
registerOrchestrateCommand(program);

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

env
  .command('prompt <squad>')
  .description('Output ready-to-use prompt for Claude Code execution')
  .option('-a, --agent <agent>', 'Agent to execute (required)')
  .option('--json', 'Output as JSON')
  .action(contextPromptCommand);

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

// ─── Understand (situational awareness) ──────────────────────────────────────

// Dashboard command
program
  .command('dashboard [name]')
  .alias('dash')
  .description('Show dashboards. Use "squads dash" for overview, "squads dash <name>" for specific dashboard, "squads dash --list" to see all.')
  .option('-v, --verbose', 'Show additional details')
  .option('-c, --ceo', 'Executive summary with priorities and blockers')
  .option('-f, --full', 'Include GitHub PR/issue stats (slower, ~30s)')
  .option('-l, --list', 'List available declarative dashboards')
  .option('--view <view>', 'Render specific view from dashboard')
  .option('-j, --json', 'Output as JSON')
  .action(async (name, options) => {
    // List available dashboards
    if (options.list) {
      showAvailableDashboards();
      return;
    }

    // If a name is provided, try declarative dashboard first
    if (name) {
      const def = findDashboard(name);
      if (def) {
        const views = options.view ? [options.view] : undefined;
        await renderDashboard(name, { verbose: options.verbose, views });
        return;
      }
      // Fall through to default dashboard with a warning
      console.log(`  Dashboard "${name}" not found. Showing default dashboard.\n`);
    }

    // Default: show the comprehensive dashboard
    dashboardCommand({ ...options, fast: !options.full });
  });

// Status command
program
  .command('status [squad]')
  .description('Show squad status and state')
  .option('-v, --verbose', 'Show detailed status')
  .option('-j, --json', 'Output as JSON')
  .action(statusCommand);

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

// Health command - quick infrastructure check
program
  .command('health')
  .description('Quick health check for all infrastructure services')
  .option('-v, --verbose', 'Show optional services')
  .action((options) => healthCommand(options));

// History command - show recent agent executions
program
  .command('history')
  .description('Show recent agent execution history')
  .option('-d, --days <days>', 'Days to look back', '7')
  .option('-s, --squad <squad>', 'Filter by squad')
  .option('-v, --verbose', 'Show cost and token details')
  .option('-j, --json', 'Output as JSON')
  .action((options) => historyCommand(options));

// Results command - KPI goals vs actuals
program
  .command('results [squad]')
  .description('Show squad results: git activity + KPI goals vs actuals')
  .option('-d, --days <days>', 'Days to look back', '7')
  .option('-v, --verbose', 'Show detailed KPIs per goal')
  .action((squad, options) => resultsCommand({ ...options, squad }));

// ─── Track (objectives + metrics) ────────────────────────────────────────────

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
  .option('-j, --json', 'Output as JSON')
  .action(goalListCommand);

goal
  .command('complete <squad> <index>')
  .description('Mark a goal as completed')
  .action(goalCompleteCommand);

goal
  .command('progress <squad> <index> <progress>')
  .description('Update goal progress')
  .action(goalProgressCommand);

// KPI command group - track squad metrics
const kpi = program
  .command('kpi')
  .description('Track and analyze squad KPIs (defined in SQUAD.md frontmatter)')
  .addHelpText('after', `
Examples:
  $ squads kpi list                       List all defined KPIs
  $ squads kpi show engineering           Show KPI status for a squad
  $ squads kpi record engineering leads_generated 15
  $ squads kpi trend engineering leads_generated
  $ squads kpi insights                   Show insights across all squads
`);

kpi
  .command('list')
  .description('List all KPIs across squads')
  .option('-j, --json', 'Output as JSON')
  .action(kpiListCommand);

kpi
  .command('show <squad>')
  .description('Show KPI status for a squad')
  .option('-j, --json', 'Output as JSON')
  .action(kpiShowCommand);

kpi
  .command('record <squad> <kpi> <value>')
  .description('Record a KPI value')
  .option('-n, --note <note>', 'Add a note to the record')
  .option('-j, --json', 'Output as JSON')
  .action(kpiRecordCommand);

kpi
  .command('trend <squad> <kpi>')
  .description('Show KPI trend over time')
  .option('-p, --periods <n>', 'Number of periods to show', '7')
  .option('-j, --json', 'Output as JSON')
  .action(kpiTrendCommand);

kpi
  .command('insights [squad]')
  .description('Generate insights from KPI data')
  .option('-j, --json', 'Output as JSON')
  .action(kpiInsightsCommand);

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

// Autonomy command - show autonomous operation readiness
program
  .command('autonomy')
  .description('Show autonomy score and confidence metrics')
  .option('-s, --squad <squad>', 'Filter by squad')
  .option('-p, --period <period>', 'Time period: today, week, month', 'today')
  .option('-j, --json', 'Output as JSON')
  .action((options) => autonomyCommand({ squad: options.squad, period: options.period, json: options.json }));

// ─── Learn (memory + knowledge) ─────────────────────────────────────────────

// Memory command group
const memory = program
  .command('memory')
  .description('Query and manage squad memory')
  .addHelpText('after', `
Examples:
  $ squads memory read engineering      View engineering squad's memory
  $ squads memory write research "Found: MCP adoption at 15%"
  $ squads memory search "pricing"      Search all memory
  $ squads memory list                  List all memory entries
  $ squads memory sync --push           Sync and push to git
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

// read (new name) + show (alias)
memory
  .command('read <squad>')
  .alias('show')
  .description('Show memory for a squad')
  .action(memoryShowCommand);

// write (new name) + update (alias)
memory
  .command('write <squad> <content>')
  .alias('update')
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
  .description('Sync memory from git: pull remote changes, process commits, optionally push to Postgres')
  .option('-v, --verbose', 'Show detailed commit info')
  .option('-p, --push', 'Push local memory changes to remote after sync')
  .option('--no-pull', 'Skip pulling from remote')
  .option('--postgres', 'Sync cycle data (goals, feedback, KPIs, learnings) to Postgres')
  .option('--dimensions', 'Sync squad/agent definitions to Postgres dim tables')
  .option('--learnings', 'Sync learnings.md files to Postgres')
  .option('--auto-learn', 'Auto-generate learnings from session commits')
  .action((options) => syncCommand({ verbose: options.verbose, push: options.push, pull: options.pull, postgres: options.postgres, dimensions: options.dimensions, learnings: options.learnings, autoLearn: options.autoLearn }));

// search (new name) — also keep old 'search' subcommand
memory
  .command('search <query>')
  .description('Search conversations stored via squads-bridge (requires bridge service)')
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

// Sync command (also available as `memory sync`)
program
  .command('sync')
  .description('Git memory synchronization (Postgres sync optional)')
  .option('-v, --verbose', 'Show detailed commit info')
  .option('-p, --push', 'Push local memory changes to remote after sync')
  .option('--no-pull', 'Skip pulling from remote')
  .option('--postgres', 'Sync cycle data to Postgres')
  .action((options) => syncCommand({ verbose: options.verbose, push: options.push, pull: options.pull, postgres: options.postgres }));

// ─── Schedule (automation) ───────────────────────────────────────────────────

// Trigger command group - smart value-driven triggers
registerTriggerCommand(program);

// Approval command group - human-in-the-loop for agents
registerApprovalCommand(program);

// Autonomous command group - scheduled routines
registerAutonomousCommand(program);

// ─── System ──────────────────────────────────────────────────────────────────

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

// Eval command - agent readiness scoring
registerEvalCommand(program);

// Deploy command group - push agents to platform
registerDeployCommand(program);

// Providers command - show LLM CLI availability for multi-LLM support
program
  .command('providers')
  .description('Show available LLM CLI providers (claude, gemini, codex, etc.)')
  .option('-j, --json', 'Output as JSON')
  .action((options) => providersCommand(options));

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

// ─── Removed commands (hidden from --help, show helpful message if invoked) ──

program.command('stack', { hidden: true }).description('[removed]').action(removedCommand('stack', 'Infrastructure is managed separately. Use: docker compose up -d'));
program.command('cron', { hidden: true }).description('[removed]').action(removedCommand('cron', 'Use platform scheduler: squads trigger list'));
program.command('tonight', { hidden: true }).description('[removed]').action(removedCommand('tonight', 'Use platform scheduler for overnight runs: squads autonomous start'));
program.command('live', { hidden: true }).description('[removed]').action(removedCommand('live', 'Use: squads dash'));
program.command('top', { hidden: true }).description('[removed]').action(removedCommand('top', 'Use: squads sessions'));
program.command('watch', { hidden: true }).description('[removed]').action(removedCommand('watch', 'Use: watch -n 2 squads status'));
program.command('setup', { hidden: true }).description('[removed]').action(removedCommand('setup', 'Use: squads init'));
program.command('slack', { hidden: true }).description('[removed]').action(removedCommand('slack', 'Slack integration runs as a service, not a CLI command'));
program.command('skill', { hidden: true }).description('[removed]').action(removedCommand('skill', 'Skills are defined in agent .md files. See: .agents/skills/'));
program.command('baseline', { hidden: true }).description('[removed]').action(removedCommand('baseline', 'Use: squads dash --ceo'));
program.command('permissions', { hidden: true }).description('[removed]').action(removedCommand('permissions', 'Permissions are defined in SQUAD.md approvals config'));
program.command('issues', { hidden: true }).description('[removed]').action(removedCommand('issues', 'Use: gh issue list'));
program.command('solve-issues', { hidden: true }).description('[removed]').action(removedCommand('solve-issues', 'Issue solving is agent behavior. Use: squads run engineering/issues-solver'));
program.command('open-issues', { hidden: true }).description('[removed]').action(removedCommand('open-issues', 'Evaluators are agents. Use: squads run <squad>/<evaluator>'));
program.command('workers', { hidden: true }).description('[removed]').action(removedCommand('workers', 'Use: squads sessions'));

// ─── Error handling ──────────────────────────────────────────────────────────

// Global error handler for uncaught exceptions
// Provides helpful recovery steps instead of raw stack traces (#31)
function handleError(error: unknown): void {
  const err = error instanceof Error ? error : new Error(String(error));

  // Check for common error types and provide helpful messages
  if (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed')) {
    console.error(chalk.red('\nConnection error:'), err.message);
    console.error(chalk.dim('\nCore commands (init, run, status, eval) work without infrastructure.'));
    console.error(chalk.dim('If you need scheduling or telemetry:'));
    console.error(chalk.dim('  1. Check infrastructure: squads health'));
    console.error(chalk.dim('  2. Start containers: docker compose up -d'));
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
