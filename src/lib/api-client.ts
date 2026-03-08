/**
 * Thin API client for reporting executions to the Squads API.
 * All calls are fire-and-forget with timeouts — preserves offline-first behavior.
 */

import { loadSession } from './auth.js';
import { getApiUrl } from './env-config.js';

const API_TIMEOUT_MS = 5000;

function getApiConfig(): { apiUrl: string; token: string } | null {
  const session = loadSession();
  if (!session?.accessToken || session.status !== 'active') return null;

  const apiUrl = getApiUrl();
  return { apiUrl, token: session.accessToken };
}

async function apiRequest(
  path: string,
  method: 'POST' | 'PATCH',
  body: Record<string, unknown>,
): Promise<boolean> {
  const config = getApiConfig();
  if (!config) return false;

  try {
    const response = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false; // Silent failure — offline-first
  }
}

/**
 * Report execution start to the API.
 * Non-blocking: returns a promise that resolves to the API execution_id or null.
 */
export async function reportExecutionStart(
  squad: string,
  agent: string,
  executionId: string,
  metadata?: {
    trigger?: string;
    model?: string;
    brief?: string;
  },
): Promise<string | null> {
  const config = getApiConfig();
  if (!config) return null;

  try {
    const response = await fetch(`${config.apiUrl}/agent-executions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        squad,
        agent,
        executor: 'cli',
        brief: metadata?.brief,
        model: metadata?.model,
        metadata: {
          local_execution_id: executionId,
          trigger: metadata?.trigger || 'manual',
        },
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    const data = await response.json() as { execution_id: string };
    return data.execution_id;
  } catch {
    return null;
  }
}

/**
 * Report execution completion to the API.
 * Non-blocking: fire-and-forget.
 */
export async function reportExecutionComplete(
  executionId: string,
  status: 'completed' | 'failed',
  details?: {
    summary?: string;
    error?: string;
    durationMs?: number;
  },
): Promise<boolean> {
  return apiRequest(`/agent-executions/${executionId}`, 'PATCH', {
    status,
    ...(details?.summary ? { summary: details.summary } : {}),
    ...(details?.error ? { error: details.error } : {}),
  });
}

/**
 * Report conversation result to the API.
 * Extends execution with conversation-specific data in extra_data.
 * Non-blocking: fire-and-forget.
 */
export async function reportConversationResult(
  executionId: string,
  result: {
    turnCount: number;
    totalCost: number;
    converged: boolean;
    reason: string;
    agentsInvolved: string[];
  },
): Promise<boolean> {
  return apiRequest(`/agent-executions/${executionId}`, 'PATCH', {
    status: result.converged ? 'completed' : 'stopped',
    summary: `${result.converged ? 'Converged' : 'Stopped'}: ${result.reason}`,
    cost_usd: result.totalCost,
    extra_data: {
      conversation: {
        turn_count: result.turnCount,
        total_cost: result.totalCost,
        converged: result.converged,
        reason: result.reason,
        agents_involved: result.agentsInvolved,
      },
    },
  });
}

/**
 * Push a cognition signal to the API.
 * Fire-and-forget — returns true on success, false on failure.
 */
export async function pushCognitionSignal(signal: {
  source: string;
  signal_type: string;
  value?: number;
  unit?: string;
  data?: Record<string, unknown>;
  entity_type?: string;
  entity_id?: string;
  confidence?: number;
}): Promise<boolean> {
  return apiRequest('/cognition/signals', 'POST', signal);
}

/**
 * Ingest a memory file into the cognition engine.
 * Fire-and-forget — returns result or null on failure.
 */
export async function ingestMemorySignal(body: {
  squad: string;
  agent: string;
  file_type: 'state' | 'learnings' | 'executions' | 'events' | 'directives';
  content: string;
  content_hash: string;
}): Promise<{ status: string; signals_created?: number } | null> {
  const config = getApiConfig();
  if (!config) return null;

  try {
    const response = await fetch(`${config.apiUrl}/cognition/signals/ingest-memory`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json() as { status: string; signals_created?: number };
  } catch {
    return null; // Silent failure — offline-first
  }
}
