/**
 * event-render.ts — human-legible rendering of the exec-event stream (#903).
 *
 * Child A of the observable-execution RFC (#898): turn the typed events the
 * #902 substrate persists into the activity feed a human can watch —
 * "reading X… searched web for Y… spawned profiler… wrote Z." Used by both
 * the live `--watch` follower (raw provider lines → adapter → render) and
 * `squads runs --replay <execId>` (persisted events file → render).
 *
 * Rendering rules:
 * - Specialized events (file_read/file_write/web_fetch/subagent_*) replace
 *   their generic tool_call line — the adapter emits both, we render one.
 * - tool_result is noise when ok; only failures render.
 * - Multi-agent runs (conversation cycles) prefix each line with the agent
 *   lane, and subagent_spawn/done mark the fan-out tree.
 */

import { colors, RESET } from './terminal.js';
import type { ExecEvent, PersistedExecEvent } from './exec-events.js';

/** Tools whose specialized event carries the line — skip their generic tool_call. */
const SPECIALIZED_TOOLS = new Set([
  'read', 'write', 'edit', 'notebookedit', 'webfetch', 'websearch', 'agent', 'task',
]);

function fmtBytes(n: number): string {
  if (n <= 0) return '';
  if (n < 1024) return ` (${n}b)`;
  return ` (${(n / 1024).toFixed(1)}kb)`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

/**
 * Render one event as a single feed line, or null when the event is noise
 * (ok tool_results, tool_calls covered by a specialization).
 */
export function renderEvent(event: ExecEvent): string | null {
  switch (event.type) {
    case 'run_start':
      return `${colors.cyan}▶${RESET} ${event.squad}${event.agent ? `/${event.agent}` : ''} ${colors.dim}(${event.mode}${event.model ? `, ${event.model}` : ''}${event.role ? `, ${event.role}` : ''})${RESET}`;
    case 'context_assembled': {
      const evicted = event.layers.filter((l) => l.evicted).length;
      return `${colors.dim}⧉ context: ${event.layers.length - evicted} layers, ~${fmtTokens(event.totalTokensEst)} tokens (budget ${fmtTokens(event.budgetTokens)})${evicted ? ` · ${evicted} evicted` : ''}${RESET}`;
    }
    case 'tool_call':
      if (SPECIALIZED_TOOLS.has(event.tool.toLowerCase())) return null;
      return `${colors.dim}⋯${RESET} ${event.tool}${event.inputSummary ? ` ${colors.dim}${event.inputSummary}${RESET}` : ''}`;
    case 'tool_result':
      if (event.ok) return null;
      return `${colors.red}✗ ${event.tool} failed${RESET}${event.summary ? ` ${colors.dim}${event.summary}${RESET}` : ''}`;
    case 'file_read':
      return `${colors.dim}read ${event.path}${RESET}`;
    case 'file_write':
      return `${colors.green}wrote${RESET} ${event.path}${colors.dim}${fmtBytes(event.bytes)}${RESET}`;
    case 'web_fetch':
      return `${colors.cyan}web${RESET} ${colors.dim}${event.url}${RESET}`;
    case 'subagent_spawn':
      return `${colors.purple}⇒ spawned ${event.agent}${RESET}${event.task ? ` ${colors.dim}— ${event.task}${RESET}` : ''}`;
    case 'subagent_done':
      return `${colors.purple}⇐ ${event.agent}${RESET} ${event.ok ? `${colors.green}done${RESET}` : `${colors.red}failed${RESET}`}`;
    case 'artifact':
      return `${colors.green}✚ ${event.kind}${RESET} ${colors.dim}${event.ref}${RESET}`;
    case 'token_usage':
      return `${colors.dim}Σ ${fmtTokens(event.input)} in / ${fmtTokens(event.output)} out · cache ${fmtTokens(event.cacheRead)}r/${fmtTokens(event.cacheWrite)}w${event.costEst ? ` · $${event.costEst.toFixed(4)}` : ''}${RESET}`;
    case 'run_end': {
      const o = event.outcomes;
      const made: string[] = [];
      if (o?.commits) made.push(`${o.commits} commit${o.commits > 1 ? 's' : ''}`);
      if (o?.prs_created) made.push(`${o.prs_created} PR${o.prs_created > 1 ? 's' : ''}`);
      if (o?.issues_created) made.push(`${o.issues_created} issue${o.issues_created > 1 ? 's' : ''}`);
      if (o?.files_edited) made.push(`${o.files_edited} file${o.files_edited > 1 ? 's' : ''} edited`);
      const status = event.ok ? `${colors.green}completed${RESET}` : `${colors.red}failed${RESET}`;
      return `${colors.cyan}■${RESET} ${status} ${colors.dim}in ${fmtDuration(event.durationMs)}${event.totalUsage.costEst ? ` · $${event.totalUsage.costEst.toFixed(4)}` : ''}${made.length ? ` · ${made.join(', ')}` : ''}${RESET}`;
    }
    case 'truncated':
      return `${colors.yellow}… ${event.droppedCount} events dropped${RESET} ${colors.dim}(${event.reason})${RESET}`;
    default:
      return null;
  }
}

/**
 * Render a persisted (enveloped) event with agent-lane prefix and a relative
 * timestamp — the replay view. `t0` is the run's first event timestamp.
 */
export function renderPersistedEvent(line: PersistedExecEvent, t0: number): string | null {
  const body = renderEvent(line.event);
  if (body === null) return null;
  const dtMs = Date.parse(line.ts) - t0;
  const stamp = Number.isFinite(dtMs) && dtMs >= 0 ? `+${(dtMs / 1000).toFixed(1)}s` : '      ';
  const lane = line.agent ? `${colors.dim}${line.agent} │${RESET} ` : '';
  return `  ${colors.dim}${stamp.padStart(8)}${RESET}  ${lane}${body}`;
}

/** Parse a raw events-file JSONL line; null when malformed. */
export function parsePersistedLine(raw: string): PersistedExecEvent | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as PersistedExecEvent;
    if (!obj || obj.v !== 1 || !obj.event || typeof obj.event.type !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}
