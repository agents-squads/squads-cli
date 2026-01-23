/**
 * squads orchestrate <squad> - Run squad with lead orchestration
 *
 * Starts the squad lead as a persistent session that:
 * - Spawns worker agents
 * - Reviews their outputs
 * - Coordinates multi-agent work
 *
 * Usage:
 *   squads orchestrate intelligence
 *   squads orchestrate cli --foreground
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  initEventsDir,
  buildLeadPrompt,
  buildWorkerCommand,
  getPendingEvents,
  watchForEvents,
} from '../lib/orchestration/lead-orchestrator.js';

// ANSI colors
const colors = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

function writeLine(msg: string) {
  process.stdout.write(msg + '\n');
}

interface OrchestrateOptions {
  foreground?: boolean;
  verbose?: boolean;
  timeout?: number;
}

/**
 * Find the lead agent for a squad
 */
function findLeadAgent(squadDir: string): string | null {
  const files = readdirSync(squadDir).filter(f => f.endsWith('.md') && !f.startsWith('_'));

  // Look for *-lead.md or squad-lead.md
  const leadFile = files.find(f =>
    f.endsWith('-lead.md') ||
    f === 'lead.md' ||
    f.includes('lead')
  );

  return leadFile ? leadFile.replace('.md', '') : null;
}

/**
 * Get all non-lead agents in a squad
 */
function getWorkerAgents(squadDir: string, leadAgent: string): string[] {
  const files = readdirSync(squadDir).filter(f =>
    f.endsWith('.md') &&
    !f.startsWith('_') &&
    !f.startsWith('README') &&
    f !== `${leadAgent}.md`
  );

  return files.map(f => f.replace('.md', ''));
}

/**
 * Main orchestrate command
 */
async function orchestrateSquad(
  squadName: string,
  options: OrchestrateOptions
): Promise<void> {
  const projectRoot = process.cwd();
  const squadsDir = join(projectRoot, '.agents', 'squads');
  const squadDir = join(squadsDir, squadName);

  // Validate squad exists
  if (!existsSync(squadDir)) {
    writeLine(`${colors.red}Squad not found: ${squadName}${colors.reset}`);
    writeLine(`${colors.dim}Available: ${readdirSync(squadsDir).filter(f => !f.startsWith('_')).join(', ')}${colors.reset}`);
    process.exit(1);
  }

  // Find lead agent
  const leadAgent = findLeadAgent(squadDir);
  if (!leadAgent) {
    writeLine(`${colors.red}No lead agent found in squad ${squadName}${colors.reset}`);
    writeLine(`${colors.dim}Expected: *-lead.md or lead.md${colors.reset}`);
    process.exit(1);
  }

  // Get worker agents
  const workers = getWorkerAgents(squadDir, leadAgent);

  writeLine(`${colors.cyan}Orchestrating squad: ${squadName}${colors.reset}`);
  writeLine(`  ${colors.green}Lead:${colors.reset} ${leadAgent}`);
  writeLine(`  ${colors.green}Workers:${colors.reset} ${workers.length} agents`);
  if (options.verbose) {
    workers.forEach(w => writeLine(`    - ${w}`));
  }

  // Initialize events directory
  const eventsDir = initEventsDir(projectRoot);
  writeLine(`  ${colors.dim}Events: ${eventsDir}${colors.reset}`);

  // Build lead prompt
  const leadPrompt = buildLeadPrompt({
    squad: squadName,
    lead: leadAgent,
    projectRoot,
    agents: workers,
  });

  // Session name
  const sessionName = `squads-lead-${squadName}-${Date.now()}`;

  if (options.foreground) {
    // Run lead in foreground (interactive)
    writeLine(`\n${colors.cyan}Starting lead in foreground...${colors.reset}`);
    writeLine(`${colors.dim}Press Ctrl+C to stop${colors.reset}\n`);

    const claude = spawn('claude', [
      '--permission-mode', 'acceptEdits',
      '-p', leadPrompt,
    ], {
      stdio: 'inherit',
      env: {
        ...process.env,
        SQUADS_SQUAD: squadName,
        SQUADS_AGENT: leadAgent,
        SQUADS_ROLE: 'lead',
        SQUADS_EVENTS_DIR: eventsDir,
      },
    });

    claude.on('exit', (code) => {
      writeLine(`\n${colors.cyan}Lead session ended (exit code: ${code})${colors.reset}`);
    });
  } else {
    // Run lead in tmux (background)
    const escapedPrompt = leadPrompt.replace(/'/g, "'\\''");
    const mcpConfigPath = join(process.env.HOME || '~', '.claude.json');

    const claudeCmd = `cd '${projectRoot}' && claude --permission-mode acceptEdits --mcp-config '${mcpConfigPath}' -p '${escapedPrompt}'`;

    const tmux = spawn('tmux', [
      'new-session',
      '-d',
      '-s', sessionName,
      '-x', '200',
      '-y', '50',
      '/bin/sh', '-c', claudeCmd,
    ], {
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        SQUADS_SQUAD: squadName,
        SQUADS_AGENT: leadAgent,
        SQUADS_ROLE: 'lead',
        SQUADS_EVENTS_DIR: eventsDir,
      },
    });

    tmux.unref();

    writeLine(`\n${colors.green}Lead started in background${colors.reset}`);
    writeLine(`  ${colors.dim}Session: ${sessionName}${colors.reset}`);
    writeLine(`  ${colors.dim}Attach:  tmux attach -t ${sessionName}${colors.reset}`);

    // Watch for events if verbose
    if (options.verbose) {
      writeLine(`\n${colors.cyan}Watching for worker events...${colors.reset}`);
      writeLine(`${colors.dim}Press Ctrl+C to stop watching (lead continues)${colors.reset}\n`);

      const stopWatching = watchForEvents(eventsDir, (event) => {
        const icon = event.type === 'completed' ? '✓' : '✗';
        const color = event.type === 'completed' ? colors.green : colors.red;
        writeLine(`${color}${icon} ${event.agent}${colors.reset} ${colors.dim}(${event.type})${colors.reset}`);
      });

      process.on('SIGINT', () => {
        stopWatching();
        writeLine(`\n${colors.dim}Stopped watching. Lead continues in tmux.${colors.reset}`);
        process.exit(0);
      });

      // Keep process alive
      await new Promise(() => {});
    }
  }
}

/**
 * Register the orchestrate command
 */
export function registerOrchestrateCommand(program: Command): void {
  program
    .command('orchestrate <squad>')
    .description('Run squad with lead agent orchestration')
    .option('-f, --foreground', 'Run lead in foreground (interactive)')
    .option('-v, --verbose', 'Show detailed output and watch events')
    .option('-t, --timeout <minutes>', 'Maximum runtime in minutes', '60')
    .action(async (squad: string, options: OrchestrateOptions) => {
      await orchestrateSquad(squad, options);
    });
}

export default registerOrchestrateCommand;
