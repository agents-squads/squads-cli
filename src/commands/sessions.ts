import { Command } from 'commander';
/**
 * List active Claude Code sessions across squads
 */

import {
  getActiveSessions,
  getSessionSummary,
  cleanupStaleSessions,
  getSessionHistoryStats,
  getRecentSessions,
  SessionState,
} from '../lib/sessions.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface SessionsOptions {
  verbose?: boolean;
  json?: boolean;
}

export async function sessionsCommand(
  options: SessionsOptions = {}
): Promise<void> {
  // Clean up stale sessions first
  cleanupStaleSessions();

  const sessions = getActiveSessions();
  const summary = getSessionSummary();

  // JSON output for scripts
  if (options.json) {
    console.log(JSON.stringify({ sessions, summary }, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}sessions${RESET}`);
  writeLine();

  if (sessions.length === 0) {
    writeLine(`  ${colors.dim}No active sessions${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Sessions are tracked automatically when Claude Code runs.${RESET}`);
    writeLine(`  ${colors.dim}Each session updates its heartbeat via squads CLI commands.${RESET}`);
    writeLine();
    return;
  }

  // Summary line
  const squadText = summary.squadCount === 1 ? 'squad' : 'squads';
  const sessionText = summary.totalSessions === 1 ? 'session' : 'sessions';
  writeLine(`  ${colors.green}${summary.totalSessions}${RESET} active ${sessionText} ${colors.dim}across${RESET} ${colors.cyan}${summary.squadCount}${RESET} ${squadText}`);
  writeLine();

  // Group by squad
  const bySquad: Record<string, SessionState[]> = {};
  for (const session of sessions) {
    const squad = session.squad || 'unknown';
    if (!bySquad[squad]) bySquad[squad] = [];
    bySquad[squad].push(session);
  }

  // Table
  const w = { squad: 16, sessions: 10, activity: 14 };
  const tableWidth = w.squad + w.sessions + w.activity + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.squad)}${RESET}` +
    `${bold}${padEnd('SESSIONS', w.sessions)}${RESET}` +
    `${bold}LAST ACTIVITY${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const [squad, squadSessions] of Object.entries(bySquad).sort()) {
    // Find most recent activity
    let mostRecent = 0;
    for (const session of squadSessions) {
      const ts = new Date(session.lastHeartbeat).getTime();
      if (ts > mostRecent) mostRecent = ts;
    }

    const lastActivity = formatTimeAgo(mostRecent);
    const activityColor = getActivityColor(mostRecent);

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(squad, w.squad)}${RESET}` +
      `${padEnd(String(squadSessions.length), w.sessions)}` +
      `${padEnd(`${activityColor}${lastActivity}${RESET}`, w.activity)}` +
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);

  // Verbose: show individual sessions
  if (options.verbose) {
    writeLine();
    writeLine(`  ${bold}Session Details${RESET}`);
    writeLine();

    for (const session of sessions) {
      const squad = session.squad || 'unknown';
      const ago = formatTimeAgo(new Date(session.lastHeartbeat).getTime());

      writeLine(`  ${icons.active} ${colors.white}${session.sessionId}${RESET}`);
      writeLine(`    ${colors.dim}squad: ${squad} | pid: ${session.pid} | heartbeat: ${ago}${RESET}`);
      writeLine(`    ${colors.dim}cwd: ${session.cwd}${RESET}`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}$${RESET} squads sessions -v    ${colors.dim}Show session details${RESET}`);
  writeLine();
}

/**
 * Format timestamp as "Xm ago" or "Xs ago"
 */
function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);

  if (minutes >= 1) {
    return `${minutes}m ago`;
  }
  return `${seconds}s ago`;
}

/**
 * Get color based on how recent the activity is
 */
function getActivityColor(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / (1000 * 60));

  if (minutes < 1) return colors.green;
  if (minutes < 3) return colors.yellow;
  return colors.dim;
}

interface HistoryOptions {
  days?: number;
  squad?: string;
  json?: boolean;
}

interface SummaryOptions {
  json?: boolean;
}

export interface SessionSummaryData {
  squads: Array<{
    name: string;
    actions: string;
    outputs: string;
  }>;
  decisions?: Array<{
    question: string;
    answer: string;
  }>;
  customer?: {
    vertical: string;
    persona: string;
    painPoints: string[];
  };
  nextActions?: Array<{
    squad: string;
    action: string;
  }>;
  filesUpdated?: string[];
  targets?: {
    metric: string;
    value: string;
  }[];
  model?: string;  // e.g., "Claude Opus 4.5"
  duration?: string;  // e.g., "45m"
}

/**
 * Show a pretty summary of session work
 */
export async function sessionsSummaryCommand(
  data: SessionSummaryData,
  options: SummaryOptions = {}
): Promise<void> {
  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}session summary${RESET}`);
  writeLine();

  // Squads table
  if (data.squads.length > 0) {
    const w = { squad: 14, actions: 26, outputs: 36 };
    const tableWidth = w.squad + w.actions + w.outputs + 6;

    // Helper to truncate text
    const truncate = (text: string, max: number) =>
      text.length > max ? text.substring(0, max - 1) + '…' : text;

    writeLine(`  ${colors.green}${icons.active}${RESET} ${bold}${data.squads.length} Squads Active${RESET}`);
    writeLine();

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

    const header = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${bold}${padEnd('SQUAD', w.squad)}${RESET}` +
      `${bold}${padEnd('ACTIONS', w.actions)}${RESET}` +
      `${bold}${padEnd('KEY OUTPUTS', w.outputs)}${RESET}` +
      `${colors.purple}${box.vertical}${RESET}`;
    writeLine(header);

    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const squad of data.squads) {
      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(truncate(squad.name, w.squad - 1), w.squad)}${RESET}` +
        `${padEnd(truncate(squad.actions, w.actions - 1), w.actions)}` +
        `${padEnd(truncate(squad.outputs, w.outputs - 1), w.outputs)}` +
        `${colors.purple}${box.vertical}${RESET}`;
      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  }

  // Decisions
  if (data.decisions && data.decisions.length > 0) {
    writeLine();
    writeLine(`  ${bold}Strategic Decisions${RESET}`);
    writeLine();

    const w = { question: 16, answer: 50 };
    const tableWidth = w.question + w.answer + 4;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

    for (const decision of data.decisions) {
      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.yellow}${padEnd(decision.question, w.question)}${RESET}` +
        `${padEnd(decision.answer, w.answer)}` +
        `${colors.purple}${box.vertical}${RESET}`;
      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  }

  // Target customer
  if (data.customer) {
    writeLine();
    writeLine(`  ${bold}Target Customer${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Vertical:${RESET} ${colors.cyan}${data.customer.vertical}${RESET}`);
    writeLine(`  ${colors.dim}Persona:${RESET}  ${colors.white}${data.customer.persona}${RESET}`);
    writeLine(`  ${colors.dim}Pain:${RESET}     ${data.customer.painPoints.join(', ')}`);
  }

  // Next actions
  if (data.nextActions && data.nextActions.length > 0) {
    writeLine();
    writeLine(`  ${bold}Next Actions${RESET}`);
    writeLine();

    for (const action of data.nextActions) {
      writeLine(`  ${colors.cyan}${padEnd(action.squad, 14)}${RESET}${colors.dim}→${RESET} ${action.action}`);
    }
  }

  // Q1 Targets
  if (data.targets && data.targets.length > 0) {
    writeLine();
    writeLine(`  ${bold}Q1 Targets${RESET}`);
    writeLine();

    for (const target of data.targets) {
      writeLine(`  ${colors.dim}•${RESET} ${target.metric}: ${colors.green}${target.value}${RESET}`);
    }
  }

  // Files updated
  if (data.filesUpdated && data.filesUpdated.length > 0) {
    writeLine();
    writeLine(`  ${colors.dim}Files updated:${RESET}`);
    for (const file of data.filesUpdated) {
      writeLine(`  ${colors.dim}  •${RESET} ${colors.cyan}${file}${RESET}`);
    }
  }

  writeLine();

  // Footer with model attribution
  const modelText = data.model ? data.model : 'Claude';
  const durationText = data.duration ? ` ${colors.dim}(${data.duration})${RESET}` : '';
  writeLine(`  ${colors.dim}Generated by${RESET} ${colors.purple}${modelText}${RESET}${durationText}`);
  writeLine();
}

/**
 * Build summary from current session by detecting recent activity
 */
export async function buildCurrentSessionSummary(): Promise<SessionSummaryData> {
  const { existsSync, readdirSync, statSync, readFileSync } = await import('fs');
  const { join } = await import('path');
  const { findMemoryDir } = await import('../lib/memory.js');

  const memoryDir = findMemoryDir();
  const squads: SessionSummaryData['squads'] = [];
  const filesUpdated: string[] = [];

  // Look for files modified in last 2 hours (current session window)
  const sessionWindow = 2 * 60 * 60 * 1000; // 2 hours
  const now = Date.now();

  if (memoryDir && existsSync(memoryDir)) {
    const squadDirs = readdirSync(memoryDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const squadDir of squadDirs) {
      const squadPath = join(memoryDir, squadDir.name);
      let squadModified = false;
      let stateContent = '';
      let executionContent = '';

      try {
        const agentDirs = readdirSync(squadPath, { withFileTypes: true })
          .filter(d => d.isDirectory());

        for (const agentDir of agentDirs) {
          const agentPath = join(squadPath, agentDir.name);
          const files = readdirSync(agentPath).filter(f => f.endsWith('.md'));

          for (const file of files) {
            const filePath = join(agentPath, file);
            const stats = statSync(filePath);

            if (now - stats.mtimeMs < sessionWindow) {
              squadModified = true;
              const relativePath = `${squadDir.name}/${agentDir.name}/${file}`;
              filesUpdated.push(relativePath);

              // Read content for summary
              if (file === 'state.md') {
                stateContent = readFileSync(filePath, 'utf-8');
              } else if (file === 'executions.md') {
                executionContent = readFileSync(filePath, 'utf-8');
              }
            }
          }
        }

        if (squadModified) {
          // Extract summary from state/execution content
          let actions = 'State updated';
          let outputs = 'Memory refreshed';

          // Try to extract info from execution log
          if (executionContent) {
            const lines = executionContent.split('\n').filter(l => l.trim());
            const recentEntry = lines.slice(-10).join(' ');
            if (recentEntry.includes('completed')) {
              actions = 'Execution completed';
            }
            // Extract key points
            const keyMatch = recentEntry.match(/Key (?:findings|decisions|outputs)?:?\s*([^.]+)/i);
            if (keyMatch) {
              outputs = keyMatch[1].substring(0, 50);
            }
          }

          // Try to extract from state header
          if (stateContent) {
            const updatedMatch = stateContent.match(/Updated:\s*([^\n]+)/);
            if (updatedMatch) {
              actions = `Updated ${updatedMatch[1]}`;
            }
          }

          squads.push({
            name: squadDir.name.charAt(0).toUpperCase() + squadDir.name.slice(1),
            actions,
            outputs: outputs.length > 44 ? outputs.substring(0, 41) + '...' : outputs,
          });
        }
      } catch {
        // Skip if can't read
      }
    }
  }

  // If no recent activity found
  if (squads.length === 0) {
    squads.push({
      name: 'No recent activity',
      actions: '—',
      outputs: 'Run squads to see activity here',
    });
  }

  return {
    squads,
    filesUpdated: filesUpdated.length > 0 ? filesUpdated : undefined,
    model: process.env.ANTHROPIC_MODEL || 'Claude',
  };
}

/**
 * Show session history and statistics
 */
export async function sessionsHistoryCommand(
  options: HistoryOptions = {}
): Promise<void> {
  const days = options.days || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const stats = await getSessionHistoryStats({
    since,
    squad: options.squad,
  });

  const recentSessions = await getRecentSessions(10);

  // JSON output
  if (options.json) {
    console.log(JSON.stringify({ stats, recentSessions }, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}sessions history${RESET} ${colors.dim}(${days}d)${RESET}`);
  writeLine();

  if (stats.totalSessions === 0) {
    writeLine(`  ${colors.dim}No session history found${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Session events are logged to .agents/sessions/history.jsonl${RESET}`);
    writeLine();
    return;
  }

  // Summary stats
  const avgMinutes = Math.round(stats.avgDurationMs / 60000);
  const totalHours = Math.round(stats.totalDurationMs / 3600000 * 10) / 10;

  writeLine(`  ${bold}Summary${RESET}`);
  writeLine(`  ${colors.cyan}${stats.totalSessions}${RESET} sessions  ${colors.dim}│${RESET}  ${colors.green}${totalHours}h${RESET} total  ${colors.dim}│${RESET}  ${colors.yellow}${avgMinutes}m${RESET} avg  ${colors.dim}│${RESET}  ${colors.purple}${stats.peakConcurrent}${RESET} peak`);
  writeLine();

  // By squad table
  const squads = Object.entries(stats.bySquad).sort((a, b) => b[1].count - a[1].count);

  if (squads.length > 0) {
    const w = { squad: 16, sessions: 10, duration: 12 };
    const tableWidth = w.squad + w.sessions + w.duration + 4;

    writeLine(`  ${bold}By Squad${RESET}`);
    writeLine();
    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

    const header = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${bold}${padEnd('SQUAD', w.squad)}${RESET}` +
      `${bold}${padEnd('SESSIONS', w.sessions)}${RESET}` +
      `${bold}DURATION${RESET}` +
      ` ${colors.purple}${box.vertical}${RESET}`;
    writeLine(header);

    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const [squad, data] of squads) {
      const hours = Math.round(data.durationMs / 3600000 * 10) / 10;

      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(squad, w.squad)}${RESET}` +
        `${padEnd(String(data.count), w.sessions)}` +
        `${padEnd(`${hours}h`, w.duration)}` +
        `${colors.purple}${box.vertical}${RESET}`;

      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  }

  // Recent sessions
  if (recentSessions.length > 0) {
    writeLine();
    writeLine(`  ${bold}Recent Sessions${RESET}`);
    writeLine();

    for (const event of recentSessions.slice(0, 5)) {
      const squad = event.squad || 'unknown';
      const date = new Date(event.ts);
      const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

      writeLine(`  ${colors.dim}${dateStr} ${timeStr}${RESET}  ${colors.cyan}${squad}${RESET}  ${colors.dim}${event.sessionId.slice(0, 8)}${RESET}`);
    }
  }

  // By date (last 7 days)
  const dates = Object.entries(stats.byDate)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 7);

  if (dates.length > 1) {
    writeLine();
    writeLine(`  ${bold}Daily Activity${RESET}`);
    writeLine();

    for (const [date, count] of dates) {
      const bar = '█'.repeat(Math.min(count, 20));
      writeLine(`  ${colors.dim}${date}${RESET}  ${colors.green}${bar}${RESET} ${count}`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}$${RESET} squads sessions history --days 30   ${colors.dim}Longer history${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads sessions history -s website  ${colors.dim}Filter by squad${RESET}`);
  writeLine();
}

export function registerSessionsCommand(program: Command): void {
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
    .action((options: { days: string; squad?: string; json?: boolean }) => sessionsHistoryCommand({
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
    .action(async (options: { data?: string; file?: string; json?: boolean }) => {
      let data: SessionSummaryData;

      if (options.file) {
        const { readFileSync } = await import('fs');
        data = JSON.parse(readFileSync(options.file, 'utf-8'));
      } else if (options.data) {
        data = JSON.parse(options.data);
      } else if (!process.stdin.isTTY) {
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
        data = await buildCurrentSessionSummary();
      }

      await sessionsSummaryCommand(data, { json: options.json });
    });
}
