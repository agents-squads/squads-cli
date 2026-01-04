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
  SessionEvent,
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
