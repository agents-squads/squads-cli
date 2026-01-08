/**
 * Execution log parsing and querying
 *
 * Parses execution logs from .agents/memory/<squad>/<agent>/executions.md
 * and provides query functions for the `squads exec` command.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { findMemoryDir } from './memory.js';

export interface Execution {
  id: string;
  squad: string;
  agent: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed';
  trigger: 'manual' | 'scheduled' | 'event' | 'smart';
  taskType: 'evaluation' | 'execution' | 'research' | 'lead';
  outcome?: string;
  error?: string;
}

export interface ExecutionListOptions {
  squad?: string;
  agent?: string;
  status?: Execution['status'];
  limit?: number;
  since?: Date;
}

/**
 * Parse a single execution entry from markdown
 */
function parseExecutionEntry(
  content: string,
  squad: string,
  agent: string
): Execution | null {
  // Extract execution ID from comment marker
  const idMatch = content.match(/<!-- exec:(\S+) -->/);
  if (!idMatch) return null;

  const id = idMatch[1];

  // Extract timestamp and status from header
  const headerMatch = content.match(/\*\*([^*]+)\*\* \| Status: (\w+)/);
  if (!headerMatch) return null;

  const startTime = headerMatch[1].trim();
  const status = headerMatch[2] as Execution['status'];

  // Parse structured fields
  const triggerMatch = content.match(/- Trigger: (\w+)/);
  const taskTypeMatch = content.match(/- Task Type: (\w+)/);
  const completedMatch = content.match(/- Completed: ([^\n]+)/);
  const durationMatch = content.match(/- Duration: ([^\n]+)/);
  const outcomeMatch = content.match(/- Outcome: ([^\n]+)/);
  const errorMatch = content.match(/- Error: ([^\n]+)/);

  // Parse duration string to ms
  let durationMs: number | undefined;
  if (durationMatch) {
    const durationStr = durationMatch[1].trim();
    const secMatch = durationStr.match(/^([\d.]+)s$/);
    if (secMatch) {
      durationMs = parseFloat(secMatch[1]) * 1000;
    }
  }

  return {
    id,
    squad,
    agent,
    startTime,
    endTime: completedMatch?.[1]?.trim(),
    durationMs,
    status,
    trigger: (triggerMatch?.[1] || 'manual') as Execution['trigger'],
    taskType: (taskTypeMatch?.[1] || 'execution') as Execution['taskType'],
    outcome: outcomeMatch?.[1]?.trim(),
    error: errorMatch?.[1]?.trim(),
  };
}

/**
 * Parse all executions from an agent's execution log
 */
function parseExecutionLog(filePath: string, squad: string, agent: string): Execution[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf-8');
  const executions: Execution[] = [];

  // Split by entry separator
  const entries = content.split(/\n---\n/);

  for (const entry of entries) {
    if (!entry.includes('<!-- exec:')) continue;

    const execution = parseExecutionEntry(entry, squad, agent);
    if (execution) {
      executions.push(execution);
    }
  }

  // Also try to parse legacy format entries (without exec: marker)
  // These will have limited data but we can still extract basic info
  for (const entry of entries) {
    if (entry.includes('<!-- exec:')) continue; // Already parsed

    const headerMatch = entry.match(/\*\*([^*]+)\*\* \| Status: (\w+)/);
    if (!headerMatch) continue;

    const startTime = headerMatch[1].trim();
    const status = headerMatch[2] as Execution['status'];

    // Generate a deterministic ID from timestamp for legacy entries
    const legacyId = `legacy_${startTime.replace(/[^a-z0-9]/gi, '')}`;

    // Skip if we already have this (by timestamp proximity)
    if (executions.some(e => e.startTime === startTime)) continue;

    executions.push({
      id: legacyId,
      squad,
      agent,
      startTime,
      status,
      trigger: 'manual',
      taskType: 'execution',
    });
  }

  return executions;
}

/**
 * List all executions across all squads
 */
export function listExecutions(options: ExecutionListOptions = {}): Execution[] {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return [];

  const executions: Execution[] = [];
  const { squad: filterSquad, agent: filterAgent, status: filterStatus, limit, since } = options;

  // Find all squad directories
  const squads = readdirSync(memoryDir, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name);

  for (const squad of squads) {
    if (filterSquad && squad !== filterSquad) continue;

    const squadPath = join(memoryDir, squad);
    const agents = readdirSync(squadPath, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const agent of agents) {
      if (filterAgent && agent !== filterAgent) continue;

      const logPath = join(squadPath, agent, 'executions.md');
      const agentExecutions = parseExecutionLog(logPath, squad, agent);
      executions.push(...agentExecutions);
    }
  }

  // Filter by status
  let filtered = filterStatus
    ? executions.filter(e => e.status === filterStatus)
    : executions;

  // Filter by date
  if (since) {
    const sinceMs = since.getTime();
    filtered = filtered.filter(e => {
      const execDate = new Date(e.startTime).getTime();
      return !isNaN(execDate) && execDate >= sinceMs;
    });
  }

  // Sort by start time (most recent first)
  filtered.sort((a, b) => {
    const aTime = new Date(a.startTime).getTime();
    const bTime = new Date(b.startTime).getTime();
    if (isNaN(aTime) || isNaN(bTime)) return 0;
    return bTime - aTime;
  });

  // Apply limit
  if (limit && limit > 0) {
    filtered = filtered.slice(0, limit);
  }

  return filtered;
}

/**
 * Get a specific execution by ID
 */
export function getExecution(executionId: string): Execution | null {
  const executions = listExecutions();
  return executions.find(e => e.id === executionId) || null;
}

/**
 * Get execution statistics
 */
export function getExecutionStats(options: ExecutionListOptions = {}): {
  total: number;
  running: number;
  completed: number;
  failed: number;
  avgDurationMs: number | null;
  bySquad: Record<string, number>;
  byAgent: Record<string, number>;
} {
  const executions = listExecutions(options);

  const running = executions.filter(e => e.status === 'running').length;
  const completed = executions.filter(e => e.status === 'completed').length;
  const failed = executions.filter(e => e.status === 'failed').length;

  // Calculate average duration from completed executions
  const durations = executions
    .filter(e => e.status === 'completed' && e.durationMs)
    .map(e => e.durationMs!);
  const avgDurationMs = durations.length > 0
    ? durations.reduce((a, b) => a + b, 0) / durations.length
    : null;

  // Count by squad
  const bySquad: Record<string, number> = {};
  for (const e of executions) {
    bySquad[e.squad] = (bySquad[e.squad] || 0) + 1;
  }

  // Count by agent
  const byAgent: Record<string, number> = {};
  for (const e of executions) {
    const key = `${e.squad}/${e.agent}`;
    byAgent[key] = (byAgent[key] || 0) + 1;
  }

  return {
    total: executions.length,
    running,
    completed,
    failed,
    avgDurationMs,
    bySquad,
    byAgent,
  };
}

/**
 * Format duration for display
 */
export function formatDuration(ms: number | undefined): string {
  if (!ms) return '—';

  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  if (ms < 3600000) {
    const mins = Math.floor(ms / 60000);
    const secs = Math.round((ms % 60000) / 1000);
    return `${mins}m ${secs}s`;
  }

  const hours = Math.floor(ms / 3600000);
  const mins = Math.round((ms % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

/**
 * Format relative time for display
 */
export function formatRelativeTime(isoTime: string): string {
  const date = new Date(isoTime);
  if (isNaN(date.getTime())) return isoTime;

  const now = Date.now();
  const diff = now - date.getTime();

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return date.toLocaleDateString();
}
