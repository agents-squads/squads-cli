/**
 * Session lifecycle commands: start, stop, heartbeat
 * Used by Claude Code hooks for session tracking
 */

import {
  startSession,
  stopSession,
  updateHeartbeat,
  detectSquad,
  cleanupStaleSessions,
} from '../lib/sessions.js';
import {
  colors,
  RESET,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface SessionStartOptions {
  squad?: string;
  quiet?: boolean;
}

interface SessionStopOptions {
  quiet?: boolean;
}

interface SessionHeartbeatOptions {
  quiet?: boolean;
}

/**
 * Start a new session
 */
export async function sessionStartCommand(
  options: SessionStartOptions = {}
): Promise<void> {
  // Clean up stale sessions first
  cleanupStaleSessions();

  const session = startSession(options.squad);

  if (!options.quiet) {
    if (session) {
      writeLine(`${icons.active} Session started: ${colors.cyan}${session.sessionId}${RESET}`);
      if (session.squad) {
        writeLine(`  ${colors.dim}Squad: ${session.squad}${RESET}`);
      }
    } else {
      writeLine(`${colors.yellow}Could not start session (no .agents directory)${RESET}`);
    }
  }
}

/**
 * Stop current session
 */
export async function sessionStopCommand(
  options: SessionStopOptions = {}
): Promise<void> {
  const stopped = stopSession();

  if (!options.quiet) {
    if (stopped) {
      writeLine(`${icons.progress} Session stopped`);
    } else {
      writeLine(`${colors.dim}No active session to stop${RESET}`);
    }
  }
}

/**
 * Update heartbeat for current session
 */
export async function sessionHeartbeatCommand(
  options: SessionHeartbeatOptions = {}
): Promise<void> {
  const updated = updateHeartbeat();

  if (!options.quiet) {
    if (updated) {
      writeLine(`${icons.active} Heartbeat updated`);
    } else {
      writeLine(`${colors.dim}No session to update${RESET}`);
    }
  }
}

/**
 * Detect current squad based on cwd
 */
export async function detectSquadCommand(): Promise<void> {
  const squad = detectSquad();

  if (squad) {
    // Output just the squad name for use in shell scripts
    process.stdout.write(squad);
  }
}
