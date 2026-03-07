/**
 * squads deploy — Push agent definitions to the Squads platform.
 *
 * Reads .agents/ directory (squads, agents, routines, memory),
 * packages the deployment manifest, and syncs it to the platform API.
 *
 * This is the upgrade path from Layer 2 (local autonomous) to Layer 3 (platform).
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import {
  findSquadsDir,
  listSquads,
  loadSquad,
  listAgents,
} from '../lib/squad-parser.js';
import { writeLine } from '../lib/terminal.js';
import matter from 'gray-matter';
import { loadSession } from '../lib/auth.js';
import { track } from '../lib/telemetry.js';

// Platform API URL
const PLATFORM_API_URL = process.env.SQUADS_PLATFORM_URL || process.env.SQUADS_API_URL || process.env.SQUADS_SCHEDULER_URL || '';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DeployManifest {
  /** Squads with their agents and routines */
  squads: SquadManifest[];
  /** Triggers to sync (from routines) */
  triggers: TriggerSync[];
  /** Timestamp of deployment */
  deployedAt: string;
  /** Git SHA if available */
  gitSha?: string;
}

interface SquadManifest {
  name: string;
  agentCount: number;
  agents: AgentManifest[];
  routineCount: number;
}

interface AgentManifest {
  name: string;
  squad: string;
  role: string;
  model: string;
  schedule?: string;
  status: string;
}

interface TriggerSync {
  name: string;
  squad: string;
  agent: string | null;
  condition: string;
  cooldown: string;
  priority: number;
  context: Record<string, unknown>;
}

interface DeployResult {
  triggersCreated: number;
  triggersSynced: string[];
  errors: Array<{ name: string; error: string }>;
}

// ─── Commands ────────────────────────────────────────────────────────────────

export async function deployCommand(options: {
  dryRun?: boolean;
  squad?: string;
  verbose?: boolean;
}): Promise<void> {
  const session = loadSession();

  if (!session || session.status !== 'active') {
    writeLine(`
${chalk.yellow('Not logged in or account not active.')}

${chalk.bold('To deploy agents to the platform:')}
  1. ${chalk.cyan('squads login')}     — Authenticate with your team account
  2. ${chalk.cyan('squads deploy')}    — Push agents to the platform

${chalk.dim('Status:')} ${session ? `${session.email} (${session.status})` : 'Not logged in'}
${chalk.dim('Need access?')} ${chalk.cyan('hello@agents-squads.com')}
`);
    await track('cli.deploy.not_authenticated');
    return;
  }

  // Find .agents/ directory
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    console.error(chalk.red('No .agents/squads/ directory found.'));
    writeLine(chalk.dim('Run: squads init'));
    return;
  }

  const spinner = ora('Building deployment manifest...').start();

  try {
    // Build manifest
    const manifest = buildManifest(squadsDir, options.squad);

    if (manifest.squads.length === 0) {
      spinner.warn('No squads found to deploy.');
      return;
    }

    spinner.succeed(`Found ${manifest.squads.length} squad(s), ${manifest.triggers.length} trigger(s)`);

    // Show what will be deployed
    writeLine('');
    writeLine(chalk.bold('Deployment Manifest'));
    writeLine(chalk.dim('─'.repeat(50)));

    for (const squad of manifest.squads) {
      writeLine(`  ${chalk.cyan(squad.name)} — ${squad.agentCount} agent(s), ${squad.routineCount} routine(s)`);
      if (options.verbose) {
        for (const agent of squad.agents) {
          const status = agent.status === 'active' ? chalk.green('active') : chalk.yellow(agent.status);
          writeLine(`    ${chalk.dim('→')} ${agent.name} (${agent.model}) [${status}]`);
          if (agent.schedule) {
            writeLine(`      ${chalk.dim('schedule:')} ${agent.schedule}`);
          }
        }
      }
    }

    if (manifest.triggers.length > 0) {
      writeLine('');
      writeLine(chalk.bold('Triggers to sync'));
      writeLine(chalk.dim('─'.repeat(50)));
      for (const trigger of manifest.triggers) {
        writeLine(`  ${chalk.magenta(trigger.name)} — ${trigger.squad}${trigger.agent ? '/' + trigger.agent : ''}`);
        if (options.verbose) {
          writeLine(`    ${chalk.dim('schedule:')} ${trigger.condition}`);
          writeLine(`    ${chalk.dim('cooldown:')} ${trigger.cooldown}`);
        }
      }
    }

    if (manifest.gitSha) {
      writeLine('');
      writeLine(chalk.dim(`Git SHA: ${manifest.gitSha}`));
    }

    // Dry run stops here
    if (options.dryRun) {
      writeLine('');
      writeLine(chalk.yellow('Dry run — no changes pushed to platform.'));
      writeLine(chalk.dim('Remove --dry-run to deploy.'));
      await track('cli.deploy.dry_run', {
        squads: manifest.squads.length,
        triggers: manifest.triggers.length,
      });
      return;
    }

    // Push to platform
    writeLine('');
    const pushSpinner = ora('Pushing to platform...').start();

    const result = await pushToplatform(manifest, session.accessToken || '');

    if (result.errors.length > 0) {
      pushSpinner.warn(`Deployed with ${result.errors.length} error(s)`);
      for (const err of result.errors) {
        writeLine(`  ${chalk.red('✗')} ${err.name}: ${err.error}`);
      }
    } else {
      pushSpinner.succeed(`Deployed ${result.triggersCreated} trigger(s) to platform`);
    }

    if (result.triggersSynced.length > 0 && options.verbose) {
      writeLine('');
      writeLine(chalk.dim('Synced triggers:'));
      for (const name of result.triggersSynced) {
        writeLine(`  ${chalk.green('✓')} ${name}`);
      }
    }

    writeLine(`
${chalk.green('✓ Deployment complete.')}

${chalk.bold('Next steps:')}
  ${chalk.dim('→')} View in dashboard: ${chalk.cyan(process.env.SQUADS_CONSOLE_URL || 'squads deploy status')}
  ${chalk.dim('→')} Check status: ${chalk.cyan('squads deploy status')}
  ${chalk.dim('→')} Pull cloud state: ${chalk.cyan('squads deploy pull')}
`);

    await track('cli.deploy.success', {
      squads: manifest.squads.length,
      triggers: manifest.triggers.length,
      errors: result.errors.length,
    });

  } catch (error) {
    spinner.fail('Deployment failed');
    const message = error instanceof Error ? error.message : String(error);
    console.error(chalk.red(message));

    if (message.includes('fetch failed') || message.includes('ECONNREFUSED')) {
      writeLine(chalk.dim('\nPlatform may be unreachable. Check your connection.'));
    }

    await track('cli.deploy.error', { error: message });
  }
}

export async function deployStatusCommand(): Promise<void> {
  const session = loadSession();
  if (!session?.accessToken) {
    writeLine(chalk.yellow('Not logged in. Run: squads login'));
    return;
  }

  const spinner = ora('Fetching deployment status...').start();

  try {
    const response = await fetch(`${PLATFORM_API_URL}/triggers`, {
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
      },
    });

    if (!response.ok) {
      spinner.fail(`Failed to fetch triggers: ${response.status}`);
      return;
    }

    const data = await response.json() as Array<{
      name: string;
      squad: string;
      agent: string | null;
      enabled: boolean;
      last_fired_at: string | null;
      trigger_type: string;
    }>;

    spinner.succeed(`${data.length} trigger(s) on platform`);

    if (data.length === 0) {
      writeLine(chalk.dim('\nNo triggers deployed. Run: squads deploy'));
      return;
    }

    writeLine('');
    writeLine(chalk.bold('Platform Triggers'));
    writeLine(chalk.dim('─'.repeat(60)));

    for (const trigger of data) {
      const status = trigger.enabled ? chalk.green('enabled') : chalk.red('disabled');
      const lastFired = trigger.last_fired_at
        ? chalk.dim(new Date(trigger.last_fired_at).toLocaleString())
        : chalk.dim('never');

      writeLine(`  ${status} ${chalk.cyan(trigger.name)} — ${trigger.squad}${trigger.agent ? '/' + trigger.agent : ''}`);
      writeLine(`    ${chalk.dim('type:')} ${trigger.trigger_type}  ${chalk.dim('last fired:')} ${lastFired}`);
    }

    // Show execution stats
    const execResponse = await fetch(`${PLATFORM_API_URL}/stats`, {
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
      },
    });

    if (execResponse.ok) {
      const stats = await execResponse.json() as Record<string, unknown>;
      writeLine('');
      writeLine(chalk.bold('Platform Stats'));
      writeLine(chalk.dim('─'.repeat(60)));
      if (stats.running_agents !== undefined) {
        writeLine(`  Running agents: ${chalk.cyan(String(stats.running_agents))}`);
      }
      if (stats.executions_today !== undefined) {
        writeLine(`  Executions today: ${chalk.cyan(String(stats.executions_today))}`);
      }
      if (stats.total_cost_today !== undefined) {
        writeLine(`  Cost today: ${chalk.cyan('$' + String(stats.total_cost_today))}`);
      }
    }

  } catch (error) {
    spinner.fail('Failed to fetch status');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

export async function deployPullCommand(options: { verbose?: boolean }): Promise<void> {
  const session = loadSession();
  if (!session?.accessToken) {
    writeLine(chalk.yellow('Not logged in. Run: squads login'));
    return;
  }

  const spinner = ora('Pulling execution data from platform...').start();

  try {
    // Pull recent executions
    const response = await fetch(`${PLATFORM_API_URL}/executions?limit=20`, {
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
      },
    });

    if (!response.ok) {
      spinner.fail(`Failed to pull executions: ${response.status}`);
      return;
    }

    const executions = await response.json() as Array<{
      id: string;
      trigger_name: string;
      squad: string;
      agent: string | null;
      status: string;
      started_at: string;
      completed_at: string | null;
      cost_usd: number | null;
    }>;

    spinner.succeed(`Pulled ${executions.length} recent execution(s)`);

    if (executions.length === 0) {
      writeLine(chalk.dim('\nNo executions found on platform.'));
      return;
    }

    writeLine('');
    writeLine(chalk.bold('Recent Platform Executions'));
    writeLine(chalk.dim('─'.repeat(70)));

    for (const exec of executions) {
      const statusColor = exec.status === 'completed' ? chalk.green
        : exec.status === 'failed' ? chalk.red
        : exec.status === 'running' ? chalk.yellow
        : chalk.dim;

      const cost = exec.cost_usd !== null ? chalk.dim(`$${exec.cost_usd.toFixed(2)}`) : '';
      const time = new Date(exec.started_at).toLocaleString();

      writeLine(`  ${statusColor(exec.status.padEnd(10))} ${chalk.cyan(exec.trigger_name)} ${chalk.dim(time)} ${cost}`);

      if (options.verbose && exec.completed_at) {
        const duration = (new Date(exec.completed_at).getTime() - new Date(exec.started_at).getTime()) / 1000;
        writeLine(`    ${chalk.dim(`duration: ${duration.toFixed(0)}s`)}`);
      }
    }

    // Pull learnings (collective memory from cloud runs)
    const learningsResponse = await fetch(`${PLATFORM_API_URL}/learnings/relevant?limit=5`, {
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
      },
    });

    if (learningsResponse.ok) {
      const learnings = await learningsResponse.json() as Array<{
        squad: string;
        agent: string;
        insight: string;
        created_at: string;
      }>;

      if (learnings.length > 0) {
        writeLine('');
        writeLine(chalk.bold('Recent Learnings'));
        writeLine(chalk.dim('─'.repeat(70)));
        for (const l of learnings) {
          writeLine(`  ${chalk.cyan(l.squad)}/${l.agent}: ${l.insight.substring(0, 80)}${l.insight.length > 80 ? '...' : ''}`);
        }
      }
    }

  } catch (error) {
    spinner.fail('Failed to pull data');
    console.error(chalk.red(error instanceof Error ? error.message : String(error)));
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildManifest(squadsDir: string, filterSquad?: string): DeployManifest {
  const squadNames = filterSquad ? [filterSquad] : listSquads(squadsDir);
  const squads: SquadManifest[] = [];
  const triggers: TriggerSync[] = [];

  // Try to get git SHA
  let gitSha: string | undefined;
  try {
    gitSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    // Not in a git repo
  }

  for (const squadName of squadNames) {
    const squad = loadSquad(squadName);
    if (!squad) continue;

    const agents: AgentManifest[] = [];
    const agentList = listAgents(squadsDir, squadName);

    for (const agent of agentList) {
      // Parse agent frontmatter for model, schedule, status
      let role = '';
      let model = 'sonnet';
      let schedule: string | undefined;
      let status = 'active';

      if (agent.filePath && existsSync(agent.filePath)) {
        const raw = readFileSync(agent.filePath, 'utf-8');
        const { data: fm } = matter(raw);
        role = (fm.role as string) || '';
        model = (fm.model as string) || 'sonnet';
        schedule = fm.schedule as string | undefined;
        status = (fm.status as string) || 'active';
      }

      agents.push({
        name: agent.name,
        squad: squadName,
        role,
        model,
        schedule,
        status,
      });
    }

    // Extract triggers from routines
    for (const routine of squad.routines) {
      if (routine.enabled === false) continue;

      for (const agent of routine.agents) {
        triggers.push({
          name: `${squadName}-${routine.name}-${agent}`,
          squad: squadName,
          agent,
          condition: routine.schedule, // cron expression
          cooldown: routine.cooldown || '1 hour',
          priority: routine.priority || 50,
          context: {
            routine: routine.name,
            model: routine.model || squad.effort || 'sonnet',
          },
        });
      }
    }

    squads.push({
      name: squadName,
      agentCount: agents.length,
      agents,
      routineCount: squad.routines.length,
    });
  }

  return {
    squads,
    triggers,
    deployedAt: new Date().toISOString(),
    gitSha,
  };
}

async function pushToplatform(manifest: DeployManifest, token: string): Promise<DeployResult> {
  if (manifest.triggers.length === 0) {
    return { triggersCreated: 0, triggersSynced: [], errors: [] };
  }

  const response = await fetch(`${PLATFORM_API_URL}/triggers/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(manifest.triggers),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Platform sync failed (${response.status}): ${text}`);
  }

  const result = await response.json() as {
    synced: number;
    triggers: string[];
    errors: Array<{ name: string; error: string }>;
  };

  return {
    triggersCreated: result.synced,
    triggersSynced: result.triggers,
    errors: result.errors,
  };
}

// ─── Command Registration ────────────────────────────────────────────────────

export function registerDeployCommand(program: Command): void {
  const deploy = program
    .command('deploy')
    .description('Deploy agents to the Squads platform')
    .option('-n, --dry-run', 'Show what would be deployed without pushing')
    .option('-s, --squad <squad>', 'Deploy only a specific squad')
    .option('-v, --verbose', 'Show detailed agent and trigger info')
    .action((options) => deployCommand({
      dryRun: options.dryRun,
      squad: options.squad,
      verbose: options.verbose,
    }));

  deploy
    .command('status')
    .description('Show current platform deployment status')
    .action(() => deployStatusCommand());

  deploy
    .command('pull')
    .description('Pull execution data and learnings from platform')
    .option('-v, --verbose', 'Show detailed execution info')
    .action((options) => deployPullCommand({ verbose: options.verbose }));
}
