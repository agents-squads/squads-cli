/**
 * Session tracking for active Claude Code sessions
 * Provides heartbeat-based session state management
 *
 * Storage:
 * - Active sessions: .agents/sessions/active/{id}.json (quick lookup)
 * - Event history: .agents/sessions/history.jsonl (analytics)
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, appendFileSync, createReadStream } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';
import { createInterface } from 'readline';
import { execSync } from 'child_process';

export interface SessionState {
  sessionId: string;
  squad: string | null;
  startedAt: string;
  lastHeartbeat: string;
  cwd: string;
  pid: number;
}

export interface SessionSummary {
  totalSessions: number;
  bySquad: Record<string, number>;
  squadCount: number;
  byTool?: Record<string, number>; // Optional: breakdown by AI tool
}

// Event types for JSONL history
export type SessionEventType = 'start' | 'heartbeat' | 'stop' | 'stale_cleanup';

export interface SessionEvent {
  type: SessionEventType;
  sessionId: string;
  squad: string | null;
  ts: string;
  cwd?: string;
  pid?: number;
  durationMs?: number; // For stop events
}

export interface SessionHistoryStats {
  totalSessions: number;
  totalDurationMs: number;
  avgDurationMs: number;
  bySquad: Record<string, { count: number; durationMs: number }>;
  byDate: Record<string, number>; // YYYY-MM-DD -> count
  peakConcurrent: number;
}

// Live AI coding assistant process info
export interface AIProcess {
  pid: number;
  tty: string;
  cwd: string;
  squad: string | null;
  tool: string; // 'claude', 'cursor', 'aider', 'gemini', etc.
}

// Supported AI coding tools (process names to detect)
const AI_TOOL_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /^claude$/, name: 'claude' },
  { pattern: /^cursor$/i, name: 'cursor' },
  { pattern: /^aider$/, name: 'aider' },
  { pattern: /^gemini$/i, name: 'gemini' },
  { pattern: /^copilot$/i, name: 'copilot' },
  { pattern: /^cody$/i, name: 'cody' },
  { pattern: /^continue$/i, name: 'continue' },
];

// Session is stale after 5 minutes without heartbeat
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// History file name
const HISTORY_FILE = 'history.jsonl';

// Active sessions subdirectory
const ACTIVE_DIR = 'active';

// Directory mapping for squad detection
const SQUAD_DIR_MAP: Record<string, string> = {
  'hq': 'company',
  'agents-squads-web': 'website',
  'company': 'company',
  'product': 'product',
  'engineering': 'engineering',
  'research': 'research',
  'intelligence': 'intelligence',
  'customer': 'customer',
  'finance': 'finance',
  'marketing': 'marketing',
};

/**
 * Find the .agents directory (sessions live at .agents/sessions/)
 */
export function findAgentsDir(): string | null {
  let dir = process.cwd();

  for (let i = 0; i < 5; i++) {
    const agentsPath = join(dir, '.agents');
    if (existsSync(agentsPath)) {
      return agentsPath;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

/**
 * Get the sessions base directory
 */
export function getSessionsBaseDir(): string | null {
  const agentsDir = findAgentsDir();
  if (!agentsDir) return null;

  const sessionsDir = join(agentsDir, 'sessions');
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }
  return sessionsDir;
}

/**
 * Get the active sessions directory, creating it if needed
 */
export function getSessionsDir(): string | null {
  const baseDir = getSessionsBaseDir();
  if (!baseDir) return null;

  const activeDir = join(baseDir, ACTIVE_DIR);
  if (!existsSync(activeDir)) {
    mkdirSync(activeDir, { recursive: true });
  }
  return activeDir;
}

/**
 * Get the history file path
 */
export function getHistoryFilePath(): string | null {
  const baseDir = getSessionsBaseDir();
  if (!baseDir) return null;
  return join(baseDir, HISTORY_FILE);
}

/**
 * Append an event to the history JSONL file
 */
function appendEvent(event: SessionEvent): void {
  const historyPath = getHistoryFilePath();
  if (!historyPath) return;

  try {
    const line = JSON.stringify(event) + '\n';
    appendFileSync(historyPath, line);
  } catch {
    // Silently fail - history is optional
  }
}

/**
 * Detect which squad based on current working directory
 */
export function detectSquad(cwd: string = process.cwd()): string | null {
  // Pattern: .../agents-squads/{domain}/...
  const match = cwd.match(/agents-squads\/([^/]+)/);
  if (match) {
    const dir = match[1];
    return SQUAD_DIR_MAP[dir] || dir;
  }
  return null;
}

/**
 * Detect running AI coding assistant processes (fast version - no lsof)
 * Returns processes immediately without cwd/squad info
 * Supports: Claude, Cursor, Aider, Gemini, Copilot, Cody, Continue
 */
export function detectAIProcessesFast(): AIProcess[] {
  const processes: AIProcess[] = [];

  try {
    // Get all processes - we'll filter for AI tools
    // Short timeout for responsiveness - this is called during dashboard render
    const psOutput = execSync('ps -eo pid,tty,comm 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 2000, // Reduced from 5s for faster CLI response
    }).trim();

    if (!psOutput) return [];

    const lines = psOutput.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;

      const pid = parseInt(parts[0], 10);
      const tty = parts[1];
      const comm = parts.slice(2).join(' '); // Process name (may have spaces)

      if (isNaN(pid)) continue;

      // Check if this is an AI coding tool
      let toolName: string | null = null;
      for (const { pattern, name } of AI_TOOL_PATTERNS) {
        if (pattern.test(comm)) {
          toolName = name;
          break;
        }
      }

      if (!toolName) continue;

      processes.push({
        pid,
        tty,
        cwd: '', // No cwd in fast mode
        squad: null, // No squad detection in fast mode
        tool: toolName,
      });
    }
  } catch {
    // Process detection failed (command not found, timeout, etc.)
    // Return empty array - graceful degradation
  }

  return processes;
}

/**
 * Get cwd for a single process using lsof (async)
 */
async function getProcessCwd(pid: number): Promise<string> {
  return new Promise((resolve) => {
    try {
      const { exec } = require('child_process');
      exec(`lsof -p ${pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, {
        encoding: 'utf-8',
        timeout: 3000,
      }, (error: Error | null, stdout: string) => {
        resolve(error ? '' : stdout.trim());
      });
    } catch {
      resolve('');
    }
  });
}

/**
 * Enrich processes with cwd and squad info (async, parallel lsof)
 * Call this after detectAIProcessesFast() when you need squad info
 */
export async function enrichProcessesWithSquad(processes: AIProcess[]): Promise<AIProcess[]> {
  if (processes.length === 0) return processes;

  // Run lsof for all processes in parallel
  const cwdPromises = processes.map(p => getProcessCwd(p.pid));
  const cwds = await Promise.all(cwdPromises);

  // Enrich each process with cwd and squad
  return processes.map((proc, i) => ({
    ...proc,
    cwd: cwds[i],
    squad: detectSquad(cwds[i]),
  }));
}

/**
 * Detect running AI coding assistant processes (full version with squad info)
 * Synchronous wrapper for backwards compatibility - calls lsof sequentially
 * For better performance, use detectAIProcessesFast() + enrichProcessesWithSquad()
 */
export function detectAIProcesses(): AIProcess[] {
  const processes = detectAIProcessesFast();

  // Synchronously enrich with cwd/squad (backwards compatible behavior)
  for (const proc of processes) {
    try {
      const lsofOutput = execSync(`lsof -p ${proc.pid} 2>/dev/null | grep cwd | awk '{print $NF}'`, {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      proc.cwd = lsofOutput || '';
      proc.squad = detectSquad(proc.cwd);
    } catch {
      // Keep empty cwd and null squad
    }
  }

  return processes;
}

// Backwards compatibility alias
export const detectClaudeProcesses = detectAIProcesses;

/**
 * Get live session summary using real process detection (fast version)
 * Returns count immediately, squad breakdown shows 'unknown' until enriched
 */
export function getLiveSessionSummaryFast(): SessionSummary {
  const processes = detectAIProcessesFast();
  const bySquad: Record<string, number> = {};
  const byTool: Record<string, number> = {};

  for (const proc of processes) {
    const squad = proc.squad || 'unknown';
    bySquad[squad] = (bySquad[squad] || 0) + 1;
    byTool[proc.tool] = (byTool[proc.tool] || 0) + 1;
  }

  return {
    totalSessions: processes.length,
    bySquad,
    squadCount: Object.keys(bySquad).length,
    byTool,
  };
}

/**
 * Get live session summary with full squad detection (async, parallel lsof)
 * Use this when you need accurate squad breakdown
 */
export async function getLiveSessionSummaryAsync(projectRoot?: string): Promise<SessionSummary> {
  const processes = detectAIProcessesFast();
  const enrichedProcesses = await enrichProcessesWithSquad(processes);

  // Filter to only sessions within the current project root
  const root = projectRoot ?? process.cwd();
  const projectProcesses = enrichedProcesses.filter(p => p.cwd && p.cwd.startsWith(root));

  const bySquad: Record<string, number> = {};
  const byTool: Record<string, number> = {};

  for (const proc of projectProcesses) {
    const squad = proc.squad || 'unknown';
    bySquad[squad] = (bySquad[squad] || 0) + 1;
    byTool[proc.tool] = (byTool[proc.tool] || 0) + 1;
  }

  return {
    totalSessions: projectProcesses.length,
    bySquad,
    squadCount: Object.keys(bySquad).length,
    byTool,
  };
}

/**
 * Get live session summary using real process detection (synchronous, backwards compatible)
 * For better performance, use getLiveSessionSummaryFast() or getLiveSessionSummaryAsync()
 */
export function getLiveSessionSummary(): SessionSummary {
  const processes = detectAIProcesses();
  const bySquad: Record<string, number> = {};
  const byTool: Record<string, number> = {};

  for (const proc of processes) {
    const squad = proc.squad || 'unknown';
    bySquad[squad] = (bySquad[squad] || 0) + 1;
    byTool[proc.tool] = (byTool[proc.tool] || 0) + 1;
  }

  return {
    totalSessions: processes.length,
    bySquad,
    squadCount: Object.keys(bySquad).length,
    byTool,
  };
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return randomBytes(8).toString('hex');
}

/**
 * Get current session ID from environment or generate new one
 */
let currentSessionId: string | null = null;

export function getSessionId(): string {
  if (currentSessionId) return currentSessionId;

  // Check if we have a session file for this PID
  const sessionsDir = getSessionsDir();
  if (sessionsDir) {
    const pid = process.pid;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const content = readFileSync(join(sessionsDir, file), 'utf-8');
        const session = JSON.parse(content) as SessionState;
        if (session.pid === pid) {
          currentSessionId = session.sessionId;
          return currentSessionId;
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  // Generate new session ID
  currentSessionId = generateSessionId();
  return currentSessionId;
}

/**
 * Start a new session (write initial state file and log event)
 */
export function startSession(squad?: string): SessionState | null {
  const sessionsDir = getSessionsDir();
  if (!sessionsDir) return null;

  const sessionId = getSessionId();
  const now = new Date().toISOString();
  const cwd = process.cwd();
  const detectedSquad = squad || detectSquad(cwd);

  const session: SessionState = {
    sessionId,
    squad: detectedSquad,
    startedAt: now,
    lastHeartbeat: now,
    cwd,
    pid: process.pid,
  };

  const sessionPath = join(sessionsDir, `${sessionId}.json`);
  writeFileSync(sessionPath, JSON.stringify(session, null, 2));

  // Log start event to history
  appendEvent({
    type: 'start',
    sessionId,
    squad: detectedSquad,
    ts: now,
    cwd,
    pid: process.pid,
  });

  return session;
}

/**
 * Update heartbeat for current session
 */
export function updateHeartbeat(): boolean {
  const sessionsDir = getSessionsDir();
  if (!sessionsDir) return false;

  const sessionId = getSessionId();
  const sessionPath = join(sessionsDir, `${sessionId}.json`);

  if (!existsSync(sessionPath)) {
    // Session doesn't exist, start a new one
    startSession();
    return true;
  }

  try {
    const content = readFileSync(sessionPath, 'utf-8');
    const session = JSON.parse(content) as SessionState;
    session.lastHeartbeat = new Date().toISOString();
    writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop current session (remove state file and log event)
 */
export function stopSession(): boolean {
  const sessionsDir = getSessionsDir();
  if (!sessionsDir) return false;

  const sessionId = getSessionId();
  const sessionPath = join(sessionsDir, `${sessionId}.json`);

  if (existsSync(sessionPath)) {
    // Read session to get start time and squad for duration calculation
    let squad: string | null = null;
    let durationMs: number | undefined;

    try {
      const content = readFileSync(sessionPath, 'utf-8');
      const session = JSON.parse(content) as SessionState;
      squad = session.squad;
      durationMs = Date.now() - new Date(session.startedAt).getTime();
    } catch {
      // Ignore parse errors
    }

    unlinkSync(sessionPath);
    currentSessionId = null;

    // Log stop event to history
    appendEvent({
      type: 'stop',
      sessionId,
      squad,
      ts: new Date().toISOString(),
      durationMs,
    });

    return true;
  }

  return false;
}

/**
 * Get all active sessions (non-stale)
 */
export function getActiveSessions(): SessionState[] {
  const sessionsDir = getSessionsDir();
  if (!sessionsDir) return [];

  const now = Date.now();
  const sessions: SessionState[] = [];

  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = join(sessionsDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const session = JSON.parse(content) as SessionState;

        // Check if session is stale
        const lastHeartbeat = new Date(session.lastHeartbeat).getTime();
        if (now - lastHeartbeat < STALE_THRESHOLD_MS) {
          sessions.push(session);
        }
      } catch {
        // Ignore parse errors
      }
    }
  } catch {
    // Directory read error
  }

  return sessions;
}

/**
 * Get session summary for dashboard
 */
export function getSessionSummary(): SessionSummary {
  const sessions = getActiveSessions();
  const bySquad: Record<string, number> = {};

  for (const session of sessions) {
    const squad = session.squad || 'unknown';
    bySquad[squad] = (bySquad[squad] || 0) + 1;
  }

  return {
    totalSessions: sessions.length,
    bySquad,
    squadCount: Object.keys(bySquad).length,
  };
}

/**
 * Clean up stale sessions (older than threshold) and log events
 */
export function cleanupStaleSessions(): number {
  const sessionsDir = getSessionsDir();
  if (!sessionsDir) return 0;

  const now = Date.now();
  const nowIso = new Date().toISOString();
  let cleaned = 0;

  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'));

    for (const file of files) {
      try {
        const filePath = join(sessionsDir, file);
        const content = readFileSync(filePath, 'utf-8');
        const session = JSON.parse(content) as SessionState;

        const lastHeartbeat = new Date(session.lastHeartbeat).getTime();
        if (now - lastHeartbeat >= STALE_THRESHOLD_MS) {
          const durationMs = now - new Date(session.startedAt).getTime();

          unlinkSync(filePath);
          cleaned++;

          // Log stale cleanup event
          appendEvent({
            type: 'stale_cleanup',
            sessionId: session.sessionId,
            squad: session.squad,
            ts: nowIso,
            durationMs,
          });
        }
      } catch {
        // If we can't parse, remove the file
        try {
          unlinkSync(join(sessionsDir, file));
          cleaned++;
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Directory read error
  }

  return cleaned;
}

/**
 * Read all events from history file
 */
export async function readSessionHistory(options: {
  since?: Date;
  until?: Date;
  squad?: string;
  type?: SessionEventType;
  limit?: number;
} = {}): Promise<SessionEvent[]> {
  const historyPath = getHistoryFilePath();
  if (!historyPath || !existsSync(historyPath)) return [];

  const events: SessionEvent[] = [];
  const sinceMs = options.since?.getTime() || 0;
  const untilMs = options.until?.getTime() || Date.now();

  return new Promise((resolve) => {
    const rl = createInterface({
      input: createReadStream(historyPath),
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line) as SessionEvent;
        const eventMs = new Date(event.ts).getTime();

        // Apply filters
        if (eventMs < sinceMs || eventMs > untilMs) return;
        if (options.squad && event.squad !== options.squad) return;
        if (options.type && event.type !== options.type) return;

        events.push(event);
      } catch {
        // Ignore parse errors
      }
    });

    rl.on('close', () => {
      // Apply limit (from end, most recent first)
      if (options.limit && events.length > options.limit) {
        resolve(events.slice(-options.limit));
      } else {
        resolve(events);
      }
    });

    rl.on('error', () => {
      resolve([]);
    });
  });
}

/**
 * Get session history statistics
 */
export async function getSessionHistoryStats(options: {
  since?: Date;
  until?: Date;
  squad?: string;
} = {}): Promise<SessionHistoryStats> {
  const events = await readSessionHistory(options);

  const stats: SessionHistoryStats = {
    totalSessions: 0,
    totalDurationMs: 0,
    avgDurationMs: 0,
    bySquad: {},
    byDate: {},
    peakConcurrent: 0,
  };

  // Track active sessions for peak concurrent calculation
  const activeSessions = new Map<string, { squad: string | null; startTs: number }>();
  let currentConcurrent = 0;

  for (const event of events) {
    const squad = event.squad || 'unknown';
    const date = event.ts.split('T')[0]; // YYYY-MM-DD

    if (event.type === 'start') {
      stats.totalSessions++;
      stats.byDate[date] = (stats.byDate[date] || 0) + 1;

      if (!stats.bySquad[squad]) {
        stats.bySquad[squad] = { count: 0, durationMs: 0 };
      }
      stats.bySquad[squad].count++;

      // Track for concurrent calculation
      activeSessions.set(event.sessionId, {
        squad: event.squad,
        startTs: new Date(event.ts).getTime(),
      });
      currentConcurrent++;
      stats.peakConcurrent = Math.max(stats.peakConcurrent, currentConcurrent);
    }

    if (event.type === 'stop' || event.type === 'stale_cleanup') {
      const duration = event.durationMs || 0;
      stats.totalDurationMs += duration;

      if (stats.bySquad[squad]) {
        stats.bySquad[squad].durationMs += duration;
      }

      // Remove from concurrent tracking
      if (activeSessions.has(event.sessionId)) {
        activeSessions.delete(event.sessionId);
        currentConcurrent = Math.max(0, currentConcurrent - 1);
      }
    }
  }

  // Calculate average duration
  const completedSessions = events.filter(e => e.type === 'stop' || e.type === 'stale_cleanup').length;
  if (completedSessions > 0) {
    stats.avgDurationMs = Math.round(stats.totalDurationMs / completedSessions);
  }

  return stats;
}

/**
 * Get recent session events (for display)
 */
export async function getRecentSessions(limit: number = 20): Promise<SessionEvent[]> {
  const events = await readSessionHistory({ limit: limit * 3 }); // Get more to filter

  // Group by session and get start/stop pairs
  const sessionEvents = new Map<string, SessionEvent[]>();
  for (const event of events) {
    if (!sessionEvents.has(event.sessionId)) {
      sessionEvents.set(event.sessionId, []);
    }
    sessionEvents.get(event.sessionId)!.push(event);
  }

  // Get the most recent start events
  const startEvents = events
    .filter(e => e.type === 'start')
    .slice(-limit);

  return startEvents.reverse(); // Most recent first
}
