import ora from 'ora';
import fs from 'fs/promises';
import path, { dirname } from 'path';
import { execSync, spawn } from 'child_process';
import { findSquadsDir } from '../lib/squad-parser.js';
import { colors, RESET, bold, writeLine } from '../lib/terminal.js';
import { track, Events } from '../lib/telemetry.js';
import {
  isSlackConfigured,
  notifyTonightStart,
  notifyTonightComplete,
} from '../lib/slack.js';

/**
 * Get the project root directory (where .agents/ lives)
 */
function getProjectRoot(): string {
  const squadsDir = findSquadsDir();
  if (squadsDir) {
    // .agents/squads -> .agents -> project root
    return dirname(dirname(squadsDir));
  }
  return process.cwd();
}

export interface TonightOptions {
  costCap?: number;        // Max USD to spend (default: 50)
  stopAt?: string;         // Stop time, e.g., "07:00" (default: 7am)
  maxRetries?: number;     // Restart crashed agents N times (default: 3)
  dryRun?: boolean;        // Show what would run
  verbose?: boolean;
  notify?: string;         // Notification method: "slack" | "email" | "none"
}

interface TonightSession {
  id: string;
  target: string;          // squad or squad/agent
  tmuxSession: string;
  startedAt: Date;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  restarts: number;
  tokensUsed?: number;
  costUsd?: number;
}

interface TonightState {
  startedAt: string;
  stopAt: string;
  costCap: number;
  maxRetries: number;
  sessions: TonightSession[];
  totalCost: number;
  stopped: boolean;
  stoppedReason?: string;
  notify?: string;
  targets?: string[];
}

const TONIGHT_STATE_FILE = '.agents/tonight-state.json';
const TONIGHT_LOG_DIR = '.agents/outputs/tonight';

// Get current cost from bridge/langfuse
async function getCurrentCost(): Promise<number> {
  try {
    const response = await fetch('http://localhost:8088/api/stats/today');
    if (response.ok) {
      const data = await response.json() as { cost_usd?: number };
      return data.cost_usd || 0;
    }
  } catch {
    // Bridge not available
  }
  return 0;
}

// Check if we should stop (reserved for future use)
function _shouldStop(state: TonightState): { stop: boolean; reason?: string } {
  // Cost cap reached
  if (state.totalCost >= state.costCap) {
    return { stop: true, reason: `Cost cap reached: $${state.totalCost.toFixed(2)} >= $${state.costCap}` };
  }

  // Time limit reached
  const now = new Date();
  const [stopHour, stopMin] = state.stopAt.split(':').map(Number);
  const stopTime = new Date();
  stopTime.setHours(stopHour, stopMin, 0, 0);

  // If stop time is before now, it means tomorrow
  if (stopTime <= new Date(state.startedAt)) {
    stopTime.setDate(stopTime.getDate() + 1);
  }

  if (now >= stopTime) {
    return { stop: true, reason: `Stop time reached: ${state.stopAt}` };
  }

  return { stop: false };
}

// Kill all tonight sessions
function killAllSessions(): number {
  try {
    const sessions = execSync('tmux ls 2>/dev/null | grep "squads-tonight-" | cut -d: -f1', { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    for (const session of sessions) {
      try {
        execSync(`tmux kill-session -t "${session}"`, { stdio: 'ignore' });
      } catch {
        // Session may already be dead
      }
    }
    return sessions.length;
  } catch {
    return 0;
  }
}

// Get running session count
function getRunningSessionCount(): number {
  try {
    const output = execSync('tmux ls 2>/dev/null | grep "squads-tonight-" | wc -l', { encoding: 'utf-8' });
    return parseInt(output.trim()) || 0;
  } catch {
    return 0;
  }
}

// Launch a single agent in tmux
function launchAgent(
  target: string,
  projectRoot: string,
  sessionId: string,
  logFile: string
): string {
  const sessionName = `squads-tonight-${sessionId}`;

  // Build the command with logging
  // Unset ANTHROPIC_API_KEY to force subscription auth (not API credits)
  const claudeCmd = [
    `cd '${projectRoot}'`,
    `unset ANTHROPIC_API_KEY`,
    `echo "=== Tonight Session: ${target} ===" >> '${logFile}'`,
    `echo "Started: $(date)" >> '${logFile}'`,
    `claude --dangerously-skip-permissions -p 'You are running as part of an overnight autonomous session. Execute your tasks efficiently. If you encounter errors, document them clearly and move on. Do not ask for user input.' -- "Run squad: ${target}" 2>&1 | tee -a '${logFile}'`,
    `echo "Ended: $(date)" >> '${logFile}'`,
  ].join(' && ');

  spawn('tmux', [
    'new-session',
    '-d',
    '-s', sessionName,
    '-x', '200',
    '-y', '50',
    '/bin/sh', '-c', claudeCmd
  ], {
    stdio: 'ignore',
    detached: true,
  }).unref();

  return sessionName;
}

// Generate morning report
async function generateReport(state: TonightState, projectRoot: string): Promise<string> {
  const duration = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000 / 60);
  const completed = state.sessions.filter(s => s.status === 'completed').length;
  const failed = state.sessions.filter(s => s.status === 'failed').length;

  const report = `# Tonight Report - ${new Date().toLocaleDateString()}

## Summary
- **Duration**: ${duration} minutes
- **Total Cost**: $${state.totalCost.toFixed(2)} / $${state.costCap} cap
- **Sessions**: ${completed} completed, ${failed} failed, ${state.sessions.length} total
- **Stopped**: ${state.stoppedReason || 'All tasks completed'}

## Sessions

| Target | Status | Restarts | Duration |
|--------|--------|----------|----------|
${state.sessions.map(s => {
  const dur = s.startedAt ? Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000 / 60) : 0;
  return `| ${s.target} | ${s.status} | ${s.restarts} | ${dur}min |`;
}).join('\n')}

## Logs
See \`.agents/outputs/tonight/\` for detailed logs.

---
*Generated by squads tonight*
`;

  const reportPath = path.join(projectRoot, TONIGHT_LOG_DIR, `report-${Date.now()}.md`);
  await fs.writeFile(reportPath, report);

  return reportPath;
}

// Main tonight command
export async function tonightCommand(
  targets: string[],
  options: TonightOptions
): Promise<void> {
  const costCap = options.costCap ?? 50;
  const stopAt = options.stopAt ?? '07:00';
  const maxRetries = options.maxRetries ?? 3;
  const dryRun = options.dryRun ?? false;
  const verbose = options.verbose ?? false;

  writeLine();
  writeLine(`  ${bold}squads tonight${RESET}`);
  writeLine();

  // Find project root
  const projectRoot = getProjectRoot();

  // Validate targets
  if (targets.length === 0) {
    writeLine(`  ${colors.red}✖${RESET} No targets specified`);
    writeLine();
    writeLine(`  ${colors.dim}Usage: squads tonight <squad> [squad/agent...]${RESET}`);
    writeLine(`  ${colors.dim}Example: squads tonight intelligence customer/outreach${RESET}`);
    writeLine();
    return;
  }

  // Show config
  writeLine(`  ${colors.dim}Config:${RESET}`);
  writeLine(`    Cost cap:    ${colors.cyan}$${costCap}${RESET}`);
  writeLine(`    Stop at:     ${colors.cyan}${stopAt}${RESET}`);
  writeLine(`    Max retries: ${colors.cyan}${maxRetries}${RESET}`);
  writeLine(`    Targets:     ${colors.cyan}${targets.join(', ')}${RESET}`);
  writeLine();

  if (dryRun) {
    writeLine(`  ${colors.yellow}DRY RUN${RESET} - would launch:`);
    for (const target of targets) {
      writeLine(`    • ${target}`);
    }
    writeLine();
    return;
  }

  // Create log directory
  const logDir = path.join(projectRoot, TONIGHT_LOG_DIR);
  await fs.mkdir(logDir, { recursive: true });

  // Initialize state
  const state: TonightState = {
    startedAt: new Date().toISOString(),
    stopAt,
    costCap,
    maxRetries,
    sessions: [],
    totalCost: await getCurrentCost(),
    stopped: false,
    notify: options.notify,
    targets,
  };

  // Launch agents
  const spinner = ora('Launching agents...').start();

  for (const target of targets) {
    const sessionId = `${target.replace('/', '-')}-${Date.now()}`;
    const logFile = path.join(logDir, `${sessionId}.log`);

    const tmuxSession = launchAgent(target, projectRoot, sessionId, logFile);

    state.sessions.push({
      id: sessionId,
      target,
      tmuxSession,
      startedAt: new Date(),
      status: 'running',
      restarts: 0,
    });
  }

  spinner.succeed(`Launched ${targets.length} agent(s)`);

  // Save initial state
  await fs.writeFile(
    path.join(projectRoot, TONIGHT_STATE_FILE),
    JSON.stringify(state, null, 2)
  );

  // Track
  await track(Events.CLI_TONIGHT, {
    targets: targets.length,
    costCap,
    stopAt,
  });

  // Slack notification (if enabled)
  const notifySlack = options.notify === 'slack';
  if (notifySlack && isSlackConfigured()) {
    await notifyTonightStart(targets, { costCap, stopAt });
    writeLine(`  ${colors.green}✓${RESET} Slack notifications enabled`);
  }

  writeLine();
  writeLine(`  ${colors.green}✓${RESET} Tonight mode active`);
  writeLine();
  writeLine(`  ${colors.dim}Monitor:${RESET}`);
  writeLine(`    ${colors.cyan}squads tonight status${RESET}  - Check progress`);
  writeLine(`    ${colors.cyan}squads tonight stop${RESET}    - Kill all agents`);
  writeLine(`    ${colors.cyan}tmux ls | grep tonight${RESET} - List sessions`);
  writeLine();
  writeLine(`  ${colors.dim}Logs: ${logDir}${RESET}`);
  writeLine();

  // Calculate stop timestamp for proper overnight handling
  // If stop time (e.g., 07:00) is before or equal to current time, it means tomorrow
  const now = new Date();
  const [stopHour, stopMin] = stopAt.split(':').map(Number);
  const stopTime = new Date();
  stopTime.setHours(stopHour, stopMin, 0, 0);
  if (stopTime <= now) {
    stopTime.setDate(stopTime.getDate() + 1);
  }
  const stopTimestamp = Math.floor(stopTime.getTime() / 1000);

  // Start watcher in background
  const watcherCmd = `
    STOP_TS=${stopTimestamp}
    while true; do
      sleep 60
      # Check cost
      COST=$(curl -s http://localhost:8088/api/stats/today 2>/dev/null | jq -r '.cost_usd // 0')
      if [ "$(echo "$COST >= ${costCap}" | bc)" -eq 1 ]; then
        echo "Cost cap reached: $COST" >> '${logDir}/watcher.log'
        tmux ls 2>/dev/null | grep squads-tonight | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
        break
      fi
      # Check time using unix timestamps (handles overnight correctly)
      NOW_TS=$(date +%s)
      if [ "$NOW_TS" -ge "$STOP_TS" ]; then
        echo "Stop time reached: ${stopAt}" >> '${logDir}/watcher.log'
        tmux ls 2>/dev/null | grep squads-tonight | cut -d: -f1 | xargs -I{} tmux kill-session -t {}
        break
      fi
      # Check if any sessions still running
      COUNT=$(tmux ls 2>/dev/null | grep squads-tonight | wc -l)
      if [ "$COUNT" -eq 0 ]; then
        echo "All sessions completed" >> '${logDir}/watcher.log'
        break
      fi
    done
  `;

  spawn('tmux', [
    'new-session',
    '-d',
    '-s', 'squads-tonight-watcher',
    '/bin/sh', '-c', watcherCmd
  ], {
    stdio: 'ignore',
    detached: true,
  }).unref();

  if (verbose) {
    writeLine(`  ${colors.dim}Watcher session started${RESET}`);
  }
}

// Status subcommand
export async function tonightStatusCommand(): Promise<void> {
  writeLine();
  writeLine(`  ${bold}Tonight Status${RESET}`);
  writeLine();

  const projectRoot = getProjectRoot();
  const statePath = path.join(projectRoot, TONIGHT_STATE_FILE);

  // Check for state file
  let state: TonightState | null = null;
  try {
    const content = await fs.readFile(statePath, 'utf-8');
    state = JSON.parse(content);
  } catch {
    // No state file
  }

  // Count running sessions
  const running = getRunningSessionCount();
  const cost = await getCurrentCost();

  if (running === 0 && !state) {
    writeLine(`  ${colors.dim}No tonight session active${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Start with: squads tonight <squad> [squad...]${RESET}`);
    writeLine();
    return;
  }

  // Show status
  writeLine(`  ${colors.cyan}${running}${RESET} agents running`);

  if (state) {
    const duration = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000 / 60);
    writeLine(`  ${colors.dim}Duration:${RESET} ${duration} minutes`);
    writeLine(`  ${colors.dim}Cost:${RESET} $${cost.toFixed(2)} / $${state.costCap} cap`);
    writeLine(`  ${colors.dim}Stop at:${RESET} ${state.stopAt}`);
  }

  writeLine();

  // List sessions
  try {
    const sessions = execSync('tmux ls 2>/dev/null | grep squads-tonight', { encoding: 'utf-8' })
      .trim()
      .split('\n')
      .filter(Boolean);

    if (sessions.length > 0) {
      writeLine(`  ${colors.dim}Sessions:${RESET}`);
      for (const session of sessions) {
        const name = session.split(':')[0];
        writeLine(`    • ${name}`);
      }
      writeLine();
      writeLine(`  ${colors.dim}Attach: tmux attach -t <session>${RESET}`);
    }
  } catch {
    // No sessions
  }

  writeLine();
}

// Stop subcommand
export async function tonightStopCommand(): Promise<void> {
  writeLine();
  writeLine(`  ${bold}Stopping Tonight Mode${RESET}`);
  writeLine();

  const killed = killAllSessions();

  if (killed > 0) {
    writeLine(`  ${colors.green}✓${RESET} Killed ${killed} session(s)`);
  } else {
    writeLine(`  ${colors.dim}No sessions to kill${RESET}`);
  }

  // Generate report
  const projectRoot = getProjectRoot();
  const statePath = path.join(projectRoot, TONIGHT_STATE_FILE);

  try {
    const content = await fs.readFile(statePath, 'utf-8');
    const state: TonightState = JSON.parse(content);
    state.stopped = true;
    state.stoppedReason = 'Manual stop';
    state.totalCost = await getCurrentCost();

    const reportPath = await generateReport(state, projectRoot);
    writeLine(`  ${colors.green}✓${RESET} Report: ${reportPath}`);

    // Slack notification (if enabled)
    if (state.notify === 'slack' && state.targets && isSlackConfigured()) {
      const duration = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000 / 60);
      const completed = state.sessions.filter(s => s.status === 'completed').length;
      const failed = state.sessions.filter(s => s.status === 'failed').length;

      await notifyTonightComplete(state.targets, {
        duration,
        cost: state.totalCost,
        completed,
        failed,
      });
      writeLine(`  ${colors.green}✓${RESET} Slack notification sent`);
    }

    // Clean up state
    await fs.unlink(statePath).catch(() => {});
  } catch {
    // No state to report on
  }

  writeLine();
}

// Report subcommand
export async function tonightReportCommand(): Promise<void> {
  writeLine();
  writeLine(`  ${bold}Tonight Report${RESET}`);
  writeLine();

  const projectRoot = getProjectRoot();
  const logDir = path.join(projectRoot, TONIGHT_LOG_DIR);

  try {
    const files = await fs.readdir(logDir);
    const reports = files.filter(f => f.startsWith('report-')).sort().reverse();

    if (reports.length === 0) {
      writeLine(`  ${colors.dim}No reports found${RESET}`);
      writeLine();
      return;
    }

    // Show latest report
    const latest = reports[0];
    const content = await fs.readFile(path.join(logDir, latest), 'utf-8');

    writeLine(content);
  } catch {
    writeLine(`  ${colors.dim}No reports found${RESET}`);
  }

  writeLine();
}
