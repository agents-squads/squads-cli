/**
 * squads history - Show recent agent execution history
 *
 * Sources:
 * 1. PostgreSQL traces table (via API)
 * 2. Local session history (.agents/sessions/history.jsonl)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  colors,
  bold,
  RESET,
  gradient,
  padEnd,
  truncate,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { getEnv } from '../lib/env-config.js';

const BRIDGE_URL = getEnv().bridge_url;
const FETCH_TIMEOUT_MS = 3000;

interface Execution {
  id: string;
  squad: string;
  agent: string;
  startedAt: Date;
  endedAt?: Date;
  durationMs?: number;
  status: 'success' | 'error' | 'running';
  cost?: number;
  tokens?: number;
  error?: string;
}

interface HistoryOptions {
  days?: number;
  squad?: string;
  verbose?: boolean;
  json?: boolean;
}

/**
 * Fetch with timeout to prevent hanging
 */
async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch {
    clearTimeout(timeoutId);
    throw new Error('Request timed out');
  }
}

/**
 * Fetch executions from bridge/postgres
 */
async function fetchFromBridge(days: number, squad?: string): Promise<Execution[]> {
  try {
    const params = new URLSearchParams({
      days: String(days),
      ...(squad && { squad }),
    });

    const response = await fetchWithTimeout(`${BRIDGE_URL}/api/executions?${params}`);

    if (!response.ok) {
      return [];
    }

    interface BridgeExecution {
      id?: string;
      squad?: string;
      agent?: string;
      started_at?: string;
      ended_at?: string;
      duration_ms?: number;
      status?: string;
      cost_usd?: number;
      total_tokens?: number;
      error?: string;
    }

    const data = await response.json() as { executions?: BridgeExecution[] };
    return (data.executions || []).map((e: BridgeExecution) => ({
      id: e.id || '',
      squad: e.squad || 'unknown',
      agent: e.agent || 'unknown',
      startedAt: new Date(e.started_at || Date.now()),
      endedAt: e.ended_at ? new Date(e.ended_at) : undefined,
      durationMs: e.duration_ms,
      status: (e.status as Execution['status']) || 'success',
      cost: e.cost_usd,
      tokens: e.total_tokens,
      error: e.error,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch executions from local session history
 */
function fetchFromLocal(days: number, squad?: string): Execution[] {
  const executions: Execution[] = [];

  // Try multiple possible locations
  const historyPaths = [
    join(process.cwd(), '.agents/sessions/history.jsonl'),
    join(process.env.HOME || '', '.squads-cli/history.jsonl'),
  ];

  let historyPath: string | undefined;
  for (const path of historyPaths) {
    if (existsSync(path)) {
      historyPath = path;
      break;
    }
  }

  if (!historyPath) {
    return [];
  }

  try {
    const content = readFileSync(historyPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    interface SessionEvent {
      type?: string;
      timestamp?: string;
      squad?: string;
      agent?: string;
      sessionId?: string;
      duration?: number;
      status?: string;
      cost?: number;
      tokens?: number;
    }

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as SessionEvent;
        const timestamp = new Date(event.timestamp || 0);

        if (timestamp.getTime() < cutoff) continue;
        if (squad && event.squad !== squad) continue;

        // Convert session events to executions
        if (event.type === 'session_end' || event.type === 'agent_complete') {
          executions.push({
            id: event.sessionId || `local-${Date.now()}`,
            squad: event.squad || 'unknown',
            agent: event.agent || 'unknown',
            startedAt: timestamp,
            durationMs: event.duration,
            status: event.status === 'error' ? 'error' : 'success',
            cost: event.cost,
            tokens: event.tokens,
          });
        }
      } catch {
        // Skip invalid lines
      }
    }
  } catch {
    // File read error
  }

  return executions;
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms?: number): string {
  if (!ms) return '—';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Group executions by date
 */
function groupByDate(executions: Execution[]): Map<string, Execution[]> {
  const groups = new Map<string, Execution[]>();

  for (const exec of executions) {
    const dateKey = exec.startedAt.toISOString().split('T')[0];
    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
    }
    groups.get(dateKey)!.push(exec);
  }

  return groups;
}

/**
 * Format date for display
 */
function formatDateHeader(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (dateStr === today.toISOString().split('T')[0]) {
    return `Today (${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;
  }
  if (dateStr === yesterday.toISOString().split('T')[0]) {
    return `Yesterday (${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })})`;
  }
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export async function historyCommand(options: HistoryOptions = {}): Promise<void> {
  const days = options.days || 7;
  const squad = options.squad;
  const verbose = options.verbose || false;
  const jsonOutput = options.json || false;

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}history${RESET}`);
  writeLine();

  // Fetch from both sources
  const [bridgeExecs, localExecs] = await Promise.all([
    fetchFromBridge(days, squad),
    Promise.resolve(fetchFromLocal(days, squad)),
  ]);

  // Merge and deduplicate (prefer bridge data)
  const seenIds = new Set<string>();
  const allExecutions: Execution[] = [];

  for (const exec of bridgeExecs) {
    seenIds.add(exec.id);
    allExecutions.push(exec);
  }

  for (const exec of localExecs) {
    if (!seenIds.has(exec.id)) {
      allExecutions.push(exec);
    }
  }

  // Sort by start time descending
  allExecutions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  if (jsonOutput) {
    console.log(JSON.stringify(allExecutions, null, 2));
    return;
  }

  if (allExecutions.length === 0) {
    writeLine(`  ${colors.dim}No executions found in the last ${days} day(s)${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Tip: Run agents with 'squads run <squad>' to see history${RESET}`);
    writeLine();
    return;
  }

  // Group by date
  const grouped = groupByDate(allExecutions);

  // Display
  const source = bridgeExecs.length > 0 ? 'postgres' : 'local';
  writeLine(`  ${colors.dim}${allExecutions.length} executions (last ${days}d, source: ${source})${RESET}`);
  writeLine();

  for (const [dateStr, execs] of grouped) {
    writeLine(`  ${bold}${formatDateHeader(dateStr)}${RESET}`);

    // Table header
    writeLine(`  ${colors.purple}┌${'─'.repeat(60)}┐${RESET}`);
    writeLine(`  ${colors.purple}│${RESET} ${padEnd('TIME', 7)}${padEnd('SQUAD', 13)}${padEnd('AGENT', 16)}${padEnd('DURATION', 10)}${padEnd('STATUS', 8)}${colors.purple}│${RESET}`);
    writeLine(`  ${colors.purple}├${'─'.repeat(60)}┤${RESET}`);

    for (const exec of execs) {
      const time = exec.startedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const squadName = truncate(exec.squad, 11);
      const agentName = truncate(exec.agent, 14);
      const duration = formatDuration(exec.durationMs);

      let statusIcon: string;
      let statusColor: string;
      switch (exec.status) {
        case 'success':
          statusIcon = icons.success;
          statusColor = colors.green;
          break;
        case 'error':
          statusIcon = icons.error;
          statusColor = colors.red;
          break;
        case 'running':
          statusIcon = icons.progress;
          statusColor = colors.cyan;
          break;
        default:
          statusIcon = icons.empty;
          statusColor = colors.dim;
      }

      writeLine(`  ${colors.purple}│${RESET} ${colors.dim}${time}${RESET}  ${colors.cyan}${padEnd(squadName, 12)}${RESET}${padEnd(agentName, 16)}${padEnd(duration, 10)}${statusColor}${statusIcon}${RESET}       ${colors.purple}│${RESET}`);

      // Verbose: show cost and tokens
      if (verbose && (exec.cost || exec.tokens)) {
        const costStr = exec.cost ? `$${exec.cost.toFixed(2)}` : '';
        const tokenStr = exec.tokens ? `${exec.tokens.toLocaleString()} tokens` : '';
        const details = [costStr, tokenStr].filter(Boolean).join('  │  ');
        writeLine(`  ${colors.purple}│${RESET}         ${colors.dim}└ ${details}${RESET}${' '.repeat(Math.max(0, 45 - details.length))}${colors.purple}│${RESET}`);
      }

      // Show error if present
      if (exec.error) {
        writeLine(`  ${colors.purple}│${RESET}         ${colors.red}└ ${truncate(exec.error, 45)}${RESET}${' '.repeat(Math.max(0, 45 - exec.error.length))}${colors.purple}│${RESET}`);
      }
    }

    writeLine(`  ${colors.purple}└${'─'.repeat(60)}┘${RESET}`);
    writeLine();
  }

  // Summary
  const successCount = allExecutions.filter(e => e.status === 'success').length;
  const errorCount = allExecutions.filter(e => e.status === 'error').length;
  const totalCost = allExecutions.reduce((sum, e) => sum + (e.cost || 0), 0);

  writeLine(`  ${colors.dim}Summary:${RESET} ${colors.green}${successCount} success${RESET}  ${errorCount > 0 ? `${colors.red}${errorCount} errors${RESET}  ` : ''}${totalCost > 0 ? `${colors.cyan}$${totalCost.toFixed(2)} total${RESET}` : ''}`);
  writeLine();
}
