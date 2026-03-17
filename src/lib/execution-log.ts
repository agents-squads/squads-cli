/**
 * Execution logging, cooldown tracking, and bridge/API communication.
 * Extracted from src/commands/run.ts to reduce its size.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { findMemoryDir } from './memory.js';
import { getApiUrl, getBridgeUrl } from './env-config.js';
import { colors, RESET, writeLine } from './terminal.js';
import { type ExecutionContext } from './run-types.js';

// ── Constants ────────────────────────────────────────────────────────
export const DEFAULT_LEARNINGS_LIMIT = 5;
export const EXECUTION_EVENT_TIMEOUT_MS = 5000;
export const DEFAULT_SCHEDULED_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Interfaces ───────────────────────────────────────────────────────

export interface PreflightResult {
  allowed: boolean;
  gates: {
    quota?: { ok: boolean; used: number; limit: number; remaining: number; period: string };
    cooldown?: { ok: boolean; elapsed_sec: number | null; min_gap_sec: number };
  };
  error?: string;
}

export interface Learning {
  content: string;
  importance: string;
  created_at: string;
}

export interface ExecutionRecord {
  squadName: string;
  agentName: string;
  executionId: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed';
  trigger?: 'manual' | 'scheduled' | 'event' | 'smart';
  taskType?: 'evaluation' | 'execution' | 'research' | 'lead';
  outcome?: string;
  error?: string;
}

// ── Bridge/API helpers ───────────────────────────────────────────────

/**
 * Register execution context with the API for telemetry
 * This allows the API to tag incoming OTel data with correct squad/agent info
 */
export async function registerContextWithBridge(ctx: ExecutionContext): Promise<boolean> {
  const bridgeUrl = getBridgeUrl();

  try {
    const response = await fetch(`${bridgeUrl}/api/context/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        execution_id: ctx.executionId,
        squad: ctx.squad,
        agent: ctx.agent,
        task_type: ctx.taskType,
        trigger: ctx.trigger,
      }),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      // Non-fatal - continue even if bridge is unavailable
      return false;
    }
    return true;
  } catch (e) {
    writeLine(`  ${colors.dim}warn: bridge registration failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    return false;
  }
}

/**
 * Pre-execution gate check via bridge API.
 * Checks quota (monthly spend) and cooldown before running an agent.
 * Fails open (allows execution) if bridge is unavailable.
 */
export async function checkPreflightGates(squad: string, agent: string): Promise<PreflightResult> {
  const bridgeUrl = getBridgeUrl();

  try {
    const response = await fetch(`${bridgeUrl}/api/execution/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ squad, agent }),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      // Fail open if bridge returns error
      return { allowed: true, gates: {} };
    }

    return await response.json() as PreflightResult;
  } catch (e) {
    writeLine(`  ${colors.dim}warn: preflight gate check failed (allowing execution): ${e instanceof Error ? e.message : String(e)}${RESET}`);
    return { allowed: true, gates: {} };
  }
}

/**
 * Fetch relevant learnings from bridge for prompt injection.
 * Returns empty array if bridge is unavailable.
 */
export async function fetchLearnings(squad: string, limit = DEFAULT_LEARNINGS_LIMIT): Promise<Learning[]> {
  const bridgeUrl = getBridgeUrl();

  try {
    const response = await fetch(
      `${bridgeUrl}/api/learnings/relevant?squad=${encodeURIComponent(squad)}&limit=${limit}`,
      { signal: AbortSignal.timeout(3000) }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as { learnings: Learning[] };
    return data.learnings || [];
  } catch (e) {
    writeLine(`  ${colors.dim}warn: learnings fetch failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    return [];
  }
}

// ── Execution logging ────────────────────────────────────────────────

export function getExecutionLogPath(squadName: string, agentName: string): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;
  return join(memoryDir, squadName, agentName, 'executions.md');
}

export function logExecution(record: ExecutionRecord): void {
  const logPath = getExecutionLogPath(record.squadName, record.agentName);
  if (!logPath) return;

  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let content = '';
  if (existsSync(logPath)) {
    content = readFileSync(logPath, 'utf-8').trimEnd();
  } else {
    content = `# ${record.squadName}/${record.agentName} - Execution Log`;
  }

  // Structured entry format for parsing
  const entry = `

---
<!-- exec:${record.executionId} -->
**${record.startTime}** | Status: ${record.status}
- ID: \`${record.executionId}\`
- Trigger: ${record.trigger || 'manual'}
- Task Type: ${record.taskType || 'execution'}
`;

  writeFileSync(logPath, content + entry);
}

export function updateExecutionStatus(
  squadName: string,
  agentName: string,
  executionId: string,
  status: 'completed' | 'failed',
  details?: {
    outcome?: string;
    error?: string;
    durationMs?: number;
  }
): void {
  const logPath = getExecutionLogPath(squadName, agentName);
  if (!logPath || !existsSync(logPath)) return;

  let content = readFileSync(logPath, 'utf-8');
  const endTime = new Date().toISOString();

  // Find and update the specific execution by ID
  const execMarker = `<!-- exec:${executionId} -->`;
  const markerIndex = content.indexOf(execMarker);

  if (markerIndex === -1) return;

  // Find the next entry marker or end of file
  const nextEntryIndex = content.indexOf('\n---\n', markerIndex + 1);
  const entryEnd = nextEntryIndex === -1 ? content.length : nextEntryIndex;

  // Extract and update the entry
  const entryStart = content.lastIndexOf('\n---\n', markerIndex);
  const currentEntry = content.slice(entryStart, entryEnd);

  // Build completion details
  const durationStr = details?.durationMs
    ? `${(details.durationMs / 1000).toFixed(1)}s`
    : 'unknown';

  let updatedEntry = currentEntry
    .replace(/Status: running/, `Status: ${status}`)
    + `- Completed: ${endTime}
- Duration: ${durationStr}`;

  if (details?.outcome) {
    updatedEntry += `\n- Outcome: ${details.outcome}`;
  }
  if (details?.error) {
    updatedEntry += `\n- Error: ${details.error}`;
  }

  // Replace the entry in content
  content = content.slice(0, entryStart) + updatedEntry + content.slice(entryEnd);
  writeFileSync(logPath, content);
}

// ── Cooldown tracking ────────────────────────────────────────────────

/**
 * Get the timestamp of the last execution from executions.md
 */
export function getLastExecutionTime(squadName: string, agentName: string): Date | null {
  const logPath = getExecutionLogPath(squadName, agentName);
  if (!logPath || !existsSync(logPath)) return null;

  const content = readFileSync(logPath, 'utf-8');

  // Find all timestamps in the format **2026-01-21T14:00:02.358Z**
  const timestamps = content.match(/\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\*\*/g);
  if (!timestamps || timestamps.length === 0) return null;

  // Get the last (most recent) timestamp
  const lastTimestamp = timestamps[timestamps.length - 1].replace(/\*\*/g, '');
  return new Date(lastTimestamp);
}

/**
 * Local cooldown check - works without bridge
 * Returns { ok: true } if allowed, { ok: false, ... } if blocked
 */
export function checkLocalCooldown(
  squadName: string,
  agentName: string,
  cooldownMs: number
): { ok: boolean; elapsedMs?: number; cooldownMs: number } {
  const lastExec = getLastExecutionTime(squadName, agentName);
  if (!lastExec) return { ok: true, cooldownMs };

  const elapsedMs = Date.now() - lastExec.getTime();
  if (elapsedMs < cooldownMs) {
    return { ok: false, elapsedMs, cooldownMs };
  }

  return { ok: true, elapsedMs, cooldownMs };
}

// ── Execution events ─────────────────────────────────────────────────

/**
 * Emit an execution event to the API for tracking and routing.
 * Non-blocking and fail-safe — falls back to file if API unavailable.
 */
export async function emitExecutionEvent(
  eventType: 'agent.completed' | 'agent.failed',
  data: { squad: string; agent: string; executionId: string; error?: string }
): Promise<void> {
  const apiUrl = getApiUrl();

  if (apiUrl) {
    try {
      await fetch(`${apiUrl}/events/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'scheduler',
          event_type: eventType,
          data: {
            squad: data.squad,
            agent: data.agent,
            execution_id: data.executionId,
            ...(data.error ? { error: data.error } : {}),
          },
        }),
        signal: AbortSignal.timeout(EXECUTION_EVENT_TIMEOUT_MS),
      });
      return;
    } catch {
      // API unavailable — fall through to file-based event recording
    }
  }

  // Fallback: write event to memory file
  try {
    const memDir = findMemoryDir();
    if (!memDir) return;

    const eventsDir = join(memDir, data.squad, data.agent);
    if (!existsSync(eventsDir)) {
      mkdirSync(eventsDir, { recursive: true });
    }

    const eventsPath = join(eventsDir, 'events.md');
    const timestamp = new Date().toISOString();
    const entry = `\n## ${timestamp}: ${eventType}\n- execution_id: ${data.executionId}\n${data.error ? `- error: ${data.error}\n` : ''}`;

    let existing = '';
    if (existsSync(eventsPath)) {
      existing = readFileSync(eventsPath, 'utf-8');
    }
    writeFileSync(eventsPath, existing + entry);
  } catch {
    // Truly fail-safe — never block execution
  }
}
