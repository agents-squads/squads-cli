/**
 * exec-events.ts — the observable-execution substrate (#902, RFC #898).
 *
 * Every run emits a typed, inspectable stream of execution events. Two
 * consumers are built on top of this substrate (as separate child issues):
 * live run visibility (#903) and per-run context economy (#904). #817
 * (post-hoc outcomes) and #662 (org TUI) aggregate the same events — there
 * is no second event path.
 *
 * Design constraints (from the RFC):
 * - Provider-agnostic from line one: runner code consumes `ExecEvent[]` only.
 *   Provider stream shapes (Claude stream-json today; deepseek/gemini as those
 *   executors land) are normalized by a `ProviderEventAdapter` at the bottom.
 * - `context_assembled` is the one event no provider can emit — only our own
 *   context assembly (run-context.ts) knows the L0–L10 layers. It is the
 *   per-layer source for the context-economy consumer.
 * - Persistence is best-effort and NEVER throws into the run path: a broken
 *   disk must not kill an agent. Size-capped with an explicit `truncated`
 *   event — never a silent cap.
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

// ── Event schema ──────────────────────────────────────────────────────

/** Per-layer accounting from context assembly (see run-context.ts). */
export interface ContextLayerStat {
  /** Layer id in the Squad Context System (1=company … 9/10=founder). */
  layer: number;
  name: string;
  /** Chars actually injected (post-truncation); 0 when evicted. */
  chars: number;
  tokensEst: number;
  /** True when the layer had content but the budget refused it entirely. */
  evicted: boolean;
}

export type ExecEvent =
  | { type: 'run_start'; squad: string; agent?: string; mode: string; model: string; role: string; startedAt: string }
  | { type: 'context_assembled'; layers: ContextLayerStat[]; totalTokensEst: number; budgetTokens: number }
  | { type: 'tool_call'; tool: string; inputSummary: string }
  | { type: 'tool_result'; tool: string; ok: boolean; summary: string }
  | { type: 'file_read'; path: string }
  | { type: 'file_write'; path: string; bytes: number }
  | { type: 'web_fetch'; url: string }
  | { type: 'subagent_spawn'; childRunId: string; squad: string; agent: string; task: string }
  | { type: 'subagent_done'; childRunId: string; agent: string; ok: boolean }
  | { type: 'token_usage'; input: number; output: number; cacheRead: number; cacheWrite: number; costEst: number; model: string }
  | { type: 'artifact'; kind: 'commit' | 'pr' | 'issue' | 'file'; ref: string }
  | { type: 'run_end'; ok: boolean; durationMs: number; totalUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; costEst: number }; outcomes: { actions: number; files_edited: number; commits: number; prs_created: number; issues_created: number } }
  | { type: 'truncated'; droppedCount: number; reason: string };

/** Envelope stamped on every persisted line. */
export interface PersistedExecEvent {
  v: 1;
  runId: string;
  seq: number;
  ts: string;
  /** Which agent in the run produced this event (fan-out attribution). */
  agent?: string;
  event: ExecEvent;
}

// ── Provider normalization ────────────────────────────────────────────

/**
 * Normalizes one provider's raw stream into ExecEvents. Instances may hold
 * per-run state (e.g. mapping tool_use ids to tool names so results can be
 * labeled). Create one adapter per run; never share across runs.
 */
export interface ProviderEventAdapter {
  parseLine(raw: string): ExecEvent[];
}

/** Cap on the tool-id → name correlation map (defensive; ~2 entries/turn). */
const PENDING_TOOL_MAP_MAX = 10_000;
const INPUT_SUMMARY_MAX = 200;

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function summarizeToolInput(name: string, input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  const lower = name.toLowerCase();
  let summary = '';
  if (lower === 'bash') summary = pick('command');
  else if (lower === 'read' || lower === 'write' || lower === 'edit' || lower === 'notebookedit') summary = pick('file_path');
  else if (lower === 'webfetch') summary = pick('url');
  else if (lower === 'websearch') summary = pick('query');
  else if (lower === 'agent' || lower === 'task') summary = pick('description') || pick('prompt');
  else if (lower === 'glob' || lower === 'grep') summary = pick('pattern');
  if (!summary) {
    try { summary = JSON.stringify(input); } catch { summary = ''; }
  }
  return summary.slice(0, INPUT_SUMMARY_MAX);
}

/** Events derived from one `tool_use` block (call + specialization + artifacts). */
function eventsFromToolUse(block: ClaudeContentBlock): ExecEvent[] {
  const name = block.name || 'unknown';
  const input = block.input;
  const lower = name.toLowerCase();
  const events: ExecEvent[] = [{ type: 'tool_call', tool: name, inputSummary: summarizeToolInput(name, input) }];

  const str = (k: string) => (input && typeof input[k] === 'string' ? (input[k] as string) : '');
  if (lower === 'read') {
    if (str('file_path')) events.push({ type: 'file_read', path: str('file_path') });
  } else if (lower === 'write' || lower === 'edit' || lower === 'notebookedit') {
    const bytes = input && typeof input.content === 'string' ? (input.content as string).length : 0;
    if (str('file_path')) events.push({ type: 'file_write', path: str('file_path'), bytes });
  } else if (lower === 'webfetch' || lower === 'websearch') {
    const target = str('url') || str('query');
    if (target) events.push({ type: 'web_fetch', url: target });
  } else if (lower === 'agent' || lower === 'task') {
    events.push({
      type: 'subagent_spawn',
      childRunId: block.id || '',
      squad: '',
      agent: str('subagent_type') || name,
      task: (str('description') || str('prompt')).slice(0, INPUT_SUMMARY_MAX),
    });
  } else if (lower === 'bash') {
    const cmd = str('command');
    if (/\bgit\b/.test(cmd) && /\bcommit\b/.test(cmd)) events.push({ type: 'artifact', kind: 'commit', ref: cmd.slice(0, INPUT_SUMMARY_MAX) });
    if (/\bgh\b/.test(cmd) && /\bpr\s+create\b/.test(cmd)) events.push({ type: 'artifact', kind: 'pr', ref: cmd.slice(0, INPUT_SUMMARY_MAX) });
    if (/\bgh\b/.test(cmd) && /\bissue\s+create\b/.test(cmd)) events.push({ type: 'artifact', kind: 'issue', ref: cmd.slice(0, INPUT_SUMMARY_MAX) });
  }
  return events;
}

/** Short human summary of a tool_result content payload. */
function summarizeToolResult(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, INPUT_SUMMARY_MAX);
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string')
      .map((b) => b.text)
      .join(' ');
    return text.slice(0, INPUT_SUMMARY_MAX);
  }
  return '';
}

/**
 * The Claude adapter: normalizes `claude --print --output-format stream-json
 * --verbose` JSONL lines into ExecEvents. Stateful per run: correlates
 * `tool_result` blocks (which arrive on `user` events carrying only a
 * tool_use_id) back to the tool name, and Agent/Task spawns to subagent_done.
 */
export function createClaudeStreamJsonAdapter(): ProviderEventAdapter {
  /** tool_use id → tool name, so results can be labeled. */
  const pendingTools = new Map<string, string>();

  return {
    parseLine(raw: string): ExecEvent[] {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return []; // stray non-JSON line (warning etc.) — not an event
      }

      const message = ev.message as { content?: ClaudeContentBlock[]; usage?: Record<string, number>; model?: string } | undefined;

      if (ev.type === 'assistant' && Array.isArray(message?.content)) {
        const events: ExecEvent[] = [];
        for (const block of message.content) {
          if (!block || block.type !== 'tool_use') continue;
          if (block.id && block.name) {
            if (pendingTools.size >= PENDING_TOOL_MAP_MAX) pendingTools.clear();
            pendingTools.set(block.id, block.name);
          }
          events.push(...eventsFromToolUse(block));
        }
        return events;
      }

      if (ev.type === 'user' && Array.isArray(message?.content)) {
        const events: ExecEvent[] = [];
        for (const block of message.content) {
          if (!block || block.type !== 'tool_result' || !block.tool_use_id) continue;
          const tool = pendingTools.get(block.tool_use_id) || 'unknown';
          pendingTools.delete(block.tool_use_id);
          const ok = block.is_error !== true;
          events.push({ type: 'tool_result', tool, ok, summary: summarizeToolResult(block.content) });
          if (tool.toLowerCase() === 'agent' || tool.toLowerCase() === 'task') {
            events.push({ type: 'subagent_done', childRunId: block.tool_use_id, agent: tool, ok });
          }
        }
        return events;
      }

      if (ev.type === 'result') {
        const u = (ev.usage as Record<string, number>) || {};
        return [{
          type: 'token_usage',
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          costEst: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0,
          model: typeof ev.model === 'string' ? ev.model : '',
        }];
      }

      return [];
    },
  };
}

// ── Persistence ───────────────────────────────────────────────────────

/** Default cap: ~5k events / ~2MB per run, then sample down to terminals. */
const DEFAULT_MAX_EVENTS = 5000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Terminal/aggregate events are never dropped by the cap. */
const UNCAPPED_TYPES = new Set<ExecEvent['type']>(['run_start', 'run_end', 'token_usage', 'truncated', 'context_assembled']);

/** Canonical events file for a run, under the dispatch root's observability dir. */
export function execEventsFile(obsRoot: string, executionId: string): string {
  const safeId = executionId.replace(/[^A-Za-z0-9_-]/g, '');
  return join(obsRoot, '.agents', 'observability', 'events', `${safeId}.jsonl`);
}

/**
 * Append-only JSONL writer for a run's event stream.
 *
 * - Best-effort: any fs error disables the writer silently — persistence must
 *   never take down the run it observes.
 * - Capped (events + bytes, env-tunable via SQUADS_EVENTS_MAX /
 *   SQUADS_EVENTS_MAX_BYTES): past the cap, detail events are counted and
 *   dropped; terminal events still land; `close()` records an explicit
 *   `truncated{droppedCount}` so a capped stream is never mistaken for a
 *   complete one.
 */
export class ExecEventWriter {
  private seq = 0;
  private bytes = 0;
  private dropped = 0;
  private dead = false;
  private closed = false;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(
    private readonly file: string,
    private readonly runId: string,
    opts: { maxEvents?: number; maxBytes?: number } = {},
  ) {
    const envMax = Number(process.env.SQUADS_EVENTS_MAX);
    const envBytes = Number(process.env.SQUADS_EVENTS_MAX_BYTES);
    this.maxEvents = opts.maxEvents ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_EVENTS);
    this.maxBytes = opts.maxBytes ?? (Number.isFinite(envBytes) && envBytes > 0 ? envBytes : DEFAULT_MAX_BYTES);
    try {
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      this.dead = true;
    }
  }

  emit(event: ExecEvent, agent?: string): void {
    if (this.dead || this.closed) return;
    const capped = this.seq >= this.maxEvents || this.bytes >= this.maxBytes;
    if (capped && !UNCAPPED_TYPES.has(event.type)) {
      this.dropped++;
      return;
    }
    const line: PersistedExecEvent = {
      v: 1,
      runId: this.runId,
      seq: this.seq,
      ts: new Date().toISOString(),
      ...(agent ? { agent } : {}),
      event,
    };
    try {
      const serialized = JSON.stringify(line) + '\n';
      appendFileSync(this.file, serialized);
      this.seq++;
      this.bytes += serialized.length;
    } catch {
      this.dead = true; // fs is broken — stop trying, never throw into the run
    }
  }

  /** Run every event an adapter extracts from one raw provider line through emit. */
  ingestProviderLine(adapter: ProviderEventAdapter, raw: string, agent?: string): void {
    if (this.dead || this.closed) return;
    let events: ExecEvent[];
    try {
      events = adapter.parseLine(raw);
    } catch {
      return; // a malformed provider line must never break the run
    }
    for (const event of events) this.emit(event, agent);
  }

  /** Flush the truncation marker (if any) and stop accepting events. */
  close(): void {
    if (this.dead || this.closed) return;
    if (this.dropped > 0) {
      this.emit({ type: 'truncated', droppedCount: this.dropped, reason: `event cap reached (${this.maxEvents} events / ${this.maxBytes} bytes)` });
    }
    this.closed = true;
  }

  /** Events dropped by the cap so far (visible for tests/diagnostics). */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Events successfully persisted so far. */
  get writtenCount(): number {
    return this.seq;
  }
}

// ── Detached-run normalization ────────────────────────────────────────

/**
 * Normalize a detached run's raw stream-json log into the run's events file.
 * Called at reconcile time (the CLI that spawned the run is long gone). The
 * raw log is the provider-shaped source; this writes the normalized events
 * so consumers never touch provider lines. Appends after the run_start /
 * context_assembled events written at spawn time; optionally closes the
 * stream with a `run_end` synthesized from the spool's completion facts.
 *
 * Returns the number of events written (0 = not a stream-json log — legacy
 * plain-text logs normalize to nothing, gracefully).
 */
export function normalizeDetachedLog(
  rawLog: string,
  obsRoot: string,
  executionId: string,
  agent?: string,
  runEnd?: Extract<ExecEvent, { type: 'run_end' }>,
): number {
  const adapter = createClaudeStreamJsonAdapter();
  const writer = new ExecEventWriter(execEventsFile(obsRoot, executionId), executionId);
  for (const line of rawLog.split('\n')) {
    writer.ingestProviderLine(adapter, line, agent);
  }
  // Only close a stream that actually opened: a legacy plain-text log yields
  // zero events, and a run_end there would fabricate an event file.
  if (runEnd && writer.writtenCount > 0) writer.emit(runEnd, agent);
  writer.close();
  return writer.writtenCount;
}
