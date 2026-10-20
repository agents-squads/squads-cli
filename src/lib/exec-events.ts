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

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { parseOpencodeLine } from './stream-json.js';
import { redactEvent, type Sensitivity } from './event-redact.js';
import { extractKimiSessionId, kimiContentText, kimiToolArgs, parseKimiLine, readKimiSessionReasoning, readKimiSessionUsage } from './kimi-code.js';

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
  /** `title`: one line naming the work (the task's first line, or the referenced issue's title);
   *  `task`: the full task, redacted like every event (both additive, #1275). */
  | { type: 'run_start'; squad: string; agent?: string; mode: string; model: string; role: string; startedAt: string; title?: string; task?: string }
  /** What the agent (or the person) said, whole in the file and the API copy (#1275, #1316). */
  | { type: 'message'; role: 'assistant' | 'user'; text: string }
  /** The model's reasoning, where the harness exposes it (#1316): opencode live; kimi at run end from
   *  its session wire log, with `step` = the session step (the step-th assistant turn). Claude Code
   *  returns thinking blocks with empty text, so claude runs have none. */
  | { type: 'reasoning'; text: string; step?: number }
  /** Running totals while a run goes. `token_usage` stays one terminal event per agent (readers sum it);
   *  this one is for live views, which take the latest per run (#1275). */
  | { type: 'usage_running'; input: number; output: number; cacheRead: number; cacheWrite: number; costEst: number; model: string }
  | { type: 'context_assembled'; layers: ContextLayerStat[]; totalTokensEst: number; budgetTokens: number }
  /** `inputSummary`: one kept value, for feeds; `args`: the whole arguments as JSON (#1318). */
  | { type: 'tool_call'; tool: string; inputSummary: string; args?: string }
  /** `summary`: a short excerpt for feeds (empty for file-reading tools); `text`: the whole result (#1318);
   *  `chars`/`sha256` describe the result before redaction. All text is redacted at write time. */
  | { type: 'tool_result'; tool: string; ok: boolean; summary: string; text?: string; chars?: number; sha256?: string }
  | { type: 'file_read'; path: string }
  | { type: 'file_write'; path: string; bytes: number }
  | { type: 'web_fetch'; url: string }
  | { type: 'subagent_spawn'; childRunId: string; squad: string; agent: string; task: string }
  | { type: 'subagent_done'; childRunId: string; agent: string; ok: boolean }
  | { type: 'token_usage'; input: number; output: number; cacheRead: number; cacheWrite: number; costEst: number; model: string }
  | { type: 'artifact'; kind: 'commit' | 'pr' | 'issue' | 'file'; ref: string }
  | { type: 'run_end'; ok: boolean; durationMs: number; totalUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; costEst: number }; outcomes?: { actions: number; files_edited: number; commits: number; prs_created: number; issues_created: number } }
  /** A provider failure, classified at the harness boundary (#1298). `errorType` is one of
   *  plan_expired · quota_exhausted · auth_invalid · rate_limited · overloaded · bad_request · network · unknown.
   *  `attempt` is set when a retryable class was backed off and re-tried. Additive. */
  | { type: 'error'; errorType: string; retryable: boolean; message: string; provider?: string; status?: number; providerCode?: string; attempt?: number }
  | { type: 'truncated'; droppedCount: number; reason: string };

/** Version of the event contract (docs/exec-events.md "Versioning", schemas/exec-event.v1.schema.json).
 *  Additive changes keep it; removing or renaming a field, or changing a type, bumps it with a changelog
 *  entry. Distinct from the envelope revision `v` below, which only says which optional fields to expect. */
export const EXEC_EVENT_SCHEMA_VERSION = 1;

/** Every `ExecEvent['type']`. The contract test checks the exported schema describes each one; the
 *  type below fails the build when this list and the union drift apart. */
export const EXEC_EVENT_TYPES = [
  'run_start', 'message', 'reasoning', 'usage_running', 'context_assembled', 'tool_call', 'tool_result',
  'file_read', 'file_write', 'web_fetch', 'subagent_spawn', 'subagent_done', 'token_usage', 'artifact',
  'run_end', 'error', 'truncated',
] as const;
type MissingFromEventTypes = Exclude<ExecEvent['type'], (typeof EXEC_EVENT_TYPES)[number]>;
const eventTypesCoverUnion: [MissingFromEventTypes] extends [never] ? true : never = true;
void eventTypesCoverUnion;

/** Envelope stamped on every persisted line. */
export interface PersistedExecEvent {
  /** Contract version of the line (see EXEC_EVENT_SCHEMA_VERSION). Consumers check it first. */
  schema_version: number;
  /** v2 (#1158) adds the optional source/provider/session_id fields below;
   *  v1 lines remain valid — readers treat every v2 field as optional. */
  v: 1 | 2;
  runId: string;
  /** Root of the dispatch chain (#920) — present only when ≠ runId (nested run). */
  root?: string;
  seq: number;
  ts: string;
  /** Which agent in the run produced this event (fan-out attribution). */
  agent?: string;
  /** Emitting runtime (v2): squads-cli | claude-code | claude-code-headless | opencode. */
  source?: string;
  /** LLM provider serving the run (v2): anthropic | deepseek | glm | ... */
  provider?: string;
  /** Claude Code session uuid backing the run, when known (v2). */
  session_id?: string;
  /** How sensitive the event is (#1275): low = lifecycle/usage, moderate = text and
   *  excerpts, high = redaction fired. Additive: older readers ignore it. */
  sensitivity?: Sensitivity;
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
/** Adapters keep this much of a text; emit() redacts it, then cuts to SUMMARY_MAX —
 *  so a secret straddling the cut is masked whole, never left half-shown. */
const INPUT_SUMMARY_MAX = 8 * 1024;

/** Tools whose result is file content: no feed excerpt (the whole text is in `text`). */
const CONTENT_TOOLS = new Set(['read', 'grep', 'notebookread']);

/** Files whose content is never stored, only its size and hash (#1318): env files (not their
 *  .example/.sample/.template), keys and certificates, credential stores, anything under secrets/. */
const SECRET_FILE_RE = /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|jks|keystore)|id_(?:rsa|dsa|ecdsa|ed25519)|\.?netrc|\.npmrc|\.pypirc|\.git-credentials|credentials(?:\.[^/]*)?|secrets?\.(?:json|ya?ml|toml|env))$|(?:^|\/)\.?secrets\//i;

/** True when a read of `path` must not keep the file's text. */
export function isSecretFile(path: string | undefined): boolean {
  return !!path && SECRET_FILE_RE.test(path.replace(/\\/g, '/'));
}

/** A tool result as an event: the whole text (#1318, founder 10-19: "store the whole"), a feed
 *  excerpt, and the size and hash of the original. A read of a secret file keeps only size and hash. */
function toolResultEvent(tool: string, ok: boolean, text: string, readPath?: string): Extract<ExecEvent, { type: 'tool_result' }> {
  const withheld = isSecretFile(readPath);
  return {
    type: 'tool_result', tool, ok,
    summary: withheld || CONTENT_TOOLS.has(tool.toLowerCase()) ? '' : text.slice(0, INPUT_SUMMARY_MAX),
    ...(text && !withheld ? { text } : {}),
    chars: text.length,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}

/** The file a tool call names (claude file_path/notebook_path, opencode filePath, kimi path). */
function readPathOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const k of ['file_path', 'filePath', 'notebook_path', 'path']) if (typeof input[k] === 'string' && input[k]) return input[k] as string;
  return undefined;
}

/** A tool's whole arguments as JSON (#1318), or undefined when there are none. */
function toolArgs(input: Record<string, unknown> | undefined): string | undefined {
  if (!input || Object.keys(input).length === 0) return undefined;
  try { return JSON.stringify(input); } catch { return undefined; }
}

/** A tool_call event: the feed's kept value and, when there are any, the whole arguments. */
function toolCallEvent(tool: string, inputSummary: string, input: Record<string, unknown> | undefined): Extract<ExecEvent, { type: 'tool_call' }> {
  const args = toolArgs(input);
  return args ? { type: 'tool_call', tool, inputSummary, args } : { type: 'tool_call', tool, inputSummary };
}

/** Input fields whose values a tool_call keeps (redacted); for anything else only the field names. */
const KEPT_INPUT = ['command', 'file_path', 'filePath', 'notebook_path', 'pattern', 'query', 'url'];

/** The kept part of a tool's input: an allowlisted value, else `{field, …}`. */
function keptInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const k of KEPT_INPUT) if (typeof input[k] === 'string' && input[k]) return (input[k] as string).slice(0, INPUT_SUMMARY_MAX);
  const keys = Object.keys(input);
  return keys.length ? `{${keys.join(', ')}}` : '';
}

interface ClaudeContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function summarizeToolInput(_name: string, input: Record<string, unknown> | undefined): string {
  return keptInput(input);
}

/** Events derived from one `tool_use` block (call + specialization + artifacts). */
function eventsFromToolUse(block: ClaudeContentBlock): ExecEvent[] {
  const name = block.name || 'unknown';
  const input = block.input;
  const lower = name.toLowerCase();
  const events: ExecEvent[] = [toolCallEvent(name, summarizeToolInput(name, input), input)];

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

/** Full text of a tool_result content payload (untruncated — for extraction). */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === 'object' && (b as { type?: string }).type === 'text' && typeof (b as { text?: string }).text === 'string')
      .map((b) => b.text)
      .join(' ');
  }
  return '';
}

/**
 * Extract the created artifact's canonical URL from a `gh pr create` /
 * `gh issue create` result — gh prints the new artifact's URL on success.
 * This is what turns "the agent RAN a create command" (activity) into "the
 * agent CREATED this artifact" (a resolvable ref) — the basis of outcome
 * capture (#817): a URL ref can later be checked for merged/closed state.
 */
function extractArtifactUrl(text: string, kind: 'pr' | 'issue'): string | undefined {
  const path = kind === 'pr' ? 'pull' : 'issues';
  const match = text.match(new RegExp(`https://github\\.com/[\\w.-]+/[\\w.-]+/${path}/\\d+`));
  return match?.[0];
}

/**
 * The Claude adapter: normalizes `claude --print --output-format stream-json
 * --verbose` JSONL lines into ExecEvents. Stateful per run: correlates
 * `tool_result` blocks (which arrive on `user` events carrying only a
 * tool_use_id) back to the tool name, and Agent/Task spawns to subagent_done.
 */
export function createClaudeStreamJsonAdapter(): ProviderEventAdapter {
  /**
   * tool_use id → tool name (so results can be labeled) + the artifact kind
   * when the call was a `gh pr/issue create` (so the RESULT can be mined for
   * the created artifact's URL — the resolvable ref outcome capture needs).
   */
  const pendingTools = new Map<string, { name: string; artifact?: 'pr' | 'issue'; path?: string }>();
  /** Usage per API message id: stream-json repeats a message once per content block,
   *  so the running total is the sum of each message's latest usage. */
  const usageById = new Map<string, Record<string, number>>();

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

      const message = ev.message as { id?: string; content?: ClaudeContentBlock[]; usage?: Record<string, number>; model?: string } | undefined;

      if (ev.type === 'assistant' && Array.isArray(message?.content)) {
        const events: ExecEvent[] = [];
        // Thinking blocks arrive with empty text from claude -p today; keep any that carry some.
        for (const b of message.content) {
          if (b && b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
            events.push({ type: 'reasoning', text: b.thinking });
          }
        }
        const text = message.content
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
          .trim();
        if (text) events.push({ type: 'message', role: 'assistant', text });
        for (const block of message.content) {
          if (!block || block.type !== 'tool_use') continue;
          if (block.id && block.name) {
            if (pendingTools.size >= PENDING_TOOL_MAP_MAX) pendingTools.clear();
            let artifact: 'pr' | 'issue' | undefined;
            if (block.name.toLowerCase() === 'bash') {
              const cmd = String((block.input as { command?: unknown } | undefined)?.command ?? '');
              if (/\bgh\b/.test(cmd) && /\bpr\s+create\b/.test(cmd)) artifact = 'pr';
              else if (/\bgh\b/.test(cmd) && /\bissue\s+create\b/.test(cmd)) artifact = 'issue';
            }
            pendingTools.set(block.id, { name: block.name, artifact, path: readPathOf(block.input) });
          }
          events.push(...eventsFromToolUse(block));
        }
        // Without a message id the repeats of one message can't be told apart: no running usage
        // then (the terminal token_usage still lands). At the map cap, updates stop — never reset.
        if (message.id && message.usage && typeof message.usage === 'object' && (usageById.has(message.id) || usageById.size < PENDING_TOOL_MAP_MAX)) {
          const key = message.id;
          const before = JSON.stringify(usageById.get(key));
          usageById.set(key, message.usage);
          if (JSON.stringify(message.usage) !== before) {
            const sum = (k: string) => [...usageById.values()].reduce((n, u) => n + (typeof u[k] === 'number' ? u[k]! : 0), 0);
            events.push({
              type: 'usage_running',
              input: sum('input_tokens'), output: sum('output_tokens'),
              cacheRead: sum('cache_read_input_tokens'), cacheWrite: sum('cache_creation_input_tokens'),
              costEst: 0, model: message.model || '',
            });
          }
        }
        return events;
      }

      if (ev.type === 'user' && Array.isArray(message?.content)) {
        const events: ExecEvent[] = [];
        for (const block of message.content) {
          if (!block || block.type !== 'tool_result' || !block.tool_use_id) continue;
          const pending = pendingTools.get(block.tool_use_id);
          const tool = pending?.name || 'unknown';
          pendingTools.delete(block.tool_use_id);
          const ok = block.is_error !== true;
          const fullText = toolResultText(block.content);
          events.push(toolResultEvent(tool, ok, fullText, pending?.path));
          if (tool.toLowerCase() === 'agent' || tool.toLowerCase() === 'task') {
            events.push({ type: 'subagent_done', childRunId: block.tool_use_id, agent: tool, ok });
          }
          // Artifact-creating command succeeded → mine the result for the
          // created artifact's canonical URL (the resolvable ref, #817).
          if (pending?.artifact && ok) {
            const url = extractArtifactUrl(fullText, pending.artifact);
            if (url) events.push({ type: 'artifact', kind: pending.artifact, ref: url });
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

// ── opencode adapter (#1177) ──────────────────────────────────────────

/** Input summary for an opencode tool call (opencode uses camelCase keys). */
function summarizeOpencodeInput(_tool: string, input: Record<string, unknown> | undefined): string {
  return keptInput(input);
}

/**
 * The opencode adapter: normalizes `opencode run --format json` JSONL lines
 * into ExecEvents (#1177 — the fallback harness gets the same observable-
 * execution treatment as claude-harness lanes, cli#1175/#1176).
 *
 * Two structural differences from Claude stream-json:
 *  - tool calls arrive RESOLVED: one `tool_use` event carries input AND the
 *    terminal state, so call + result + artifact mining happen in one line
 *    (no pending-tool correlation map needed);
 *  - usage arrives incrementally on `step_finish` events; the adapter
 *    accumulates and emits ONE cumulative `token_usage` at the terminal
 *    `step_finish{reason:'stop'}` — same one-usage-event contract as the
 *    Claude adapter's terminal `result`.
 */
export function createOpencodeStreamJsonAdapter(): ProviderEventAdapter {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;

  return {
    parseLine(raw: string): ExecEvent[] {
      const ev = parseOpencodeLine(raw);
      if (!ev) return [];
      const part = ev.part;

      if (ev.type === 'tool_use' && part) {
        const tool = part.tool || 'unknown';
        const lower = tool.toLowerCase();
        const state = part.state ?? {};
        const toolInput = (state.input ?? undefined) as Record<string, unknown> | undefined;
        const ok = state.status !== 'error';
        const outputText = typeof state.output === 'string' ? state.output : '';
        const str = (k: string) => (toolInput && typeof toolInput[k] === 'string' ? (toolInput[k] as string) : '');

        const events: ExecEvent[] = [toolCallEvent(tool, summarizeOpencodeInput(lower, toolInput), toolInput)];
        if (lower === 'read') {
          if (str('filePath')) events.push({ type: 'file_read', path: str('filePath') });
        } else if (lower === 'write' || lower === 'edit' || lower === 'patch') {
          const bytes = (str('content') || str('newString')).length;
          if (str('filePath')) events.push({ type: 'file_write', path: str('filePath'), bytes });
        } else if (lower === 'webfetch' || lower === 'websearch') {
          const target = str('url') || str('query');
          if (target) events.push({ type: 'web_fetch', url: target });
        } else if (lower === 'task') {
          events.push({
            type: 'subagent_spawn',
            childRunId: part.callID || '',
            squad: '',
            agent: str('subagent_type') || tool,
            task: (str('description') || str('prompt')).slice(0, INPUT_SUMMARY_MAX),
          });
        } else if (lower === 'bash') {
          const cmd = str('command');
          if (/\bgit\b/.test(cmd) && /\bcommit\b/.test(cmd)) events.push({ type: 'artifact', kind: 'commit', ref: cmd.slice(0, INPUT_SUMMARY_MAX) });
          // Artifact-creating command resolved in this same event — mine its
          // output for the created artifact's canonical URL (#817 parity).
          if (ok && /\bgh\b/.test(cmd) && /\bpr\s+create\b/.test(cmd)) {
            const url = extractArtifactUrl(outputText, 'pr');
            if (url) events.push({ type: 'artifact', kind: 'pr', ref: url });
          }
          if (ok && /\bgh\b/.test(cmd) && /\bissue\s+create\b/.test(cmd)) {
            const url = extractArtifactUrl(outputText, 'issue');
            if (url) events.push({ type: 'artifact', kind: 'issue', ref: url });
          }
        }
        events.push(toolResultEvent(tool, ok, outputText, readPathOf(toolInput)));
        if (lower === 'task') {
          events.push({ type: 'subagent_done', childRunId: part.callID || '', agent: tool, ok });
        }
        return events;
      }

      if (ev.type === 'text' && typeof part?.text === 'string' && part.text.trim()) {
        return [{ type: 'message', role: 'assistant', text: part.text }];
      }

      // Emitted only under `--thinking` (llm-clis passes it, #1316).
      if (ev.type === 'reasoning' && typeof part?.text === 'string' && part.text.trim()) {
        return [{ type: 'reasoning', text: part.text }];
      }

      if (ev.type === 'step_finish' && part) {
        const t = part.tokens || {};
        input += t.input || 0;
        output += (t.output || 0) + (t.reasoning || 0); // reasoning bills as output
        cacheRead += t.cache?.read || 0;
        cacheWrite += t.cache?.write || 0;
        cost += typeof part.cost === 'number' ? part.cost : 0;
        const running: ExecEvent = { type: 'usage_running', input, output, cacheRead, cacheWrite, costEst: cost, model: '' };
        if (part.reason === 'stop') {
          return [running, { type: 'token_usage', input, output, cacheRead, cacheWrite, costEst: cost, model: '' }];
        }
        return [running];
      }

      return [];
    },
  };
}

// ── kimi-code adapter (#1309) ─────────────────────────────────────────

/**
 * The kimi-code adapter: normalizes `kimi -p --output-format stream-json`
 * lines (OpenAI-chat-shaped messages) into ExecEvents. Like Claude stream-json,
 * a tool call and its result are separate messages, correlated by id.
 *
 * kimi prints NO usage on stdout. At the terminal `session.resume_hint` the
 * adapter reads the session wire log (readKimiSessionUsage) and emits the one
 * cumulative `token_usage` — or none when the wire is unreadable (null, not a
 * fabricated 0). Cost is the subscription's: costEst 0.
 */
export function createKimiStreamJsonAdapter(): ProviderEventAdapter {
  const pending = new Map<string, { tool: string; kind?: 'pr' | 'issue'; path?: string }>();
  // Reasoning seen on stdout: then the wire log's copy is not read at the end (no duplicates).
  let liveReasoning = false;

  return {
    parseLine(raw: string): ExecEvent[] {
      const msg = parseKimiLine(raw);
      if (!msg) return [];

      if (msg.role === 'assistant') {
        const events: ExecEvent[] = [];
        if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim()) {
          liveReasoning = true;
          events.push({ type: 'reasoning', text: msg.reasoning_content });
        }
        // Assistant text → `message` (#1275 part 2), same as the claude and
        // opencode adapters; kimi puts it in `content`, with or without tool calls.
        const text = kimiContentText(msg.content);
        if (text) events.push({ type: 'message', role: 'assistant', text });
        for (const call of msg.tool_calls ?? []) {
          const tool = call.function?.name || 'unknown';
          const lower = tool.toLowerCase();
          const args = kimiToolArgs(call);
          const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
          let summary = lower === 'bash' ? str('command') : str('path');
          if (!summary) {
            try { summary = JSON.stringify(args); } catch { summary = ''; }
          }
          events.push(toolCallEvent(tool, summary.slice(0, INPUT_SUMMARY_MAX), args));
          let kind: 'pr' | 'issue' | undefined;
          if (lower === 'read') {
            if (str('path')) events.push({ type: 'file_read', path: str('path') });
          } else if (lower === 'write' || lower === 'edit') {
            if (str('path')) events.push({ type: 'file_write', path: str('path'), bytes: str('content').length });
          } else if (lower === 'bash') {
            const cmd = str('command');
            if (/\bgit\b/.test(cmd) && /\bcommit\b/.test(cmd)) events.push({ type: 'artifact', kind: 'commit', ref: cmd.slice(0, INPUT_SUMMARY_MAX) });
            if (/\bgh\b/.test(cmd) && /\bpr\s+create\b/.test(cmd)) kind = 'pr';
            else if (/\bgh\b/.test(cmd) && /\bissue\s+create\b/.test(cmd)) kind = 'issue';
          }
          if (call.id) pending.set(call.id, { tool, kind, path: readPathOf(args) });
        }
        return events;
      }

      if (msg.role === 'tool' && msg.tool_call_id) {
        const entry = pending.get(msg.tool_call_id);
        if (!entry) return [];
        pending.delete(msg.tool_call_id);
        const text = kimiContentText(msg.content);
        const events: ExecEvent[] = [toolResultEvent(entry.tool, true, text, entry.path)];
        if (entry.kind) {
          const url = extractArtifactUrl(text, entry.kind);
          if (url) events.push({ type: 'artifact', kind: entry.kind, ref: url });
        }
        return events;
      }

      if (msg.role === 'meta' && msg.type === 'session.resume_hint') {
        const sessionId = extractKimiSessionId(raw);
        const events: ExecEvent[] = [];
        // The captured stdout carried no reasoning (kimi-code 2.2.0); the wire log has every step's (#1316).
        if (sessionId && !liveReasoning) {
          for (const r of readKimiSessionReasoning(sessionId)) events.push({ type: 'reasoning', text: r.text, step: r.step });
        }
        const usage = sessionId ? readKimiSessionUsage(sessionId) : null;
        if (usage) {
          events.push({
            type: 'token_usage',
            input: usage.input_tokens, output: usage.output_tokens,
            cacheRead: usage.cache_read_tokens, cacheWrite: usage.cache_write_tokens,
            costEst: 0, model: usage.model,
          });
        }
        return events;
      }

      return [];
    },
  };
}

// ── Persistence ───────────────────────────────────────────────────────

/** Default cap: ~5k events / ~32MB per run, then sample down to terminals. */
const DEFAULT_MAX_EVENTS = 5000;
/** Whole tool output and arguments make runs bigger (#1318): a long run stays well under this. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** Terminal/aggregate events are never dropped by the cap. */
const UNCAPPED_TYPES = new Set<ExecEvent['type']>(['run_start', 'run_end', 'token_usage', 'truncated', 'context_assembled']);

/** Canonical events file for a run, under the dispatch root's observability dir. */
export function execEventsFile(obsRoot: string, executionId: string): string {
  const safeId = executionId.replace(/[^A-Za-z0-9_-]/g, '');
  return join(obsRoot, '.agents', 'observability', 'events', `${safeId}.jsonl`);
}

/**
 * Root of the dispatch chain as seen from a process env (#920, #1181).
 *
 * Precedence: explicit SQUADS_ROOT_RUN_ID (a nested lane inherited it from
 * buildAgentEnv) → the interactive Claude Code session this CLI is running
 * inside (sess_<id>, the id the session-events pipeline records the session
 * under) → undefined. ONE derivation for every stamping site — the #1182 fix
 * covered only the child env, while the dispatching process's own writer
 * (envelope `root`) and reporter (record `root_run_id`) read their OWN env
 * and kept recording nothing.
 */
export function deriveRootRunId(env: Record<string, string | undefined> = process.env): string | undefined {
  if (env.SQUADS_ROOT_RUN_ID) return env.SQUADS_ROOT_RUN_ID;
  if (env.CLAUDE_CODE_SESSION_ID) return `sess_${env.CLAUDE_CODE_SESSION_ID}`;
  return undefined;
}

// ── API flusher (#1158) ───────────────────────────────────────────────

const FLUSH_BATCH_SIZE = 25;
const FLUSH_INTERVAL_MS = 2000;

/** usage_running is written at most this often per run. */
const USAGE_RUNNING_MS = 2_000;

/** A batch is sent once its events reach this many bytes, whatever the count: free text goes to the
 *  API whole now (#1316), each string already bounded by the redaction input cap. */
const FLUSH_BATCH_BYTES = 256 * 1024;

/** A run's title: the task's first line, one line, at most 100 characters. */
export function runTitle(task: string | undefined): string | undefined {
  const first = (task ?? '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!first) return undefined;
  // eslint-disable-next-line no-control-regex
  const t = first.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/^#+\s*/, '').replace(/\s+/g, ' ');
  return t.length > 100 ? `${t.slice(0, 99)}…` : t;
}

/** `owner/repo#n` when the task is nothing but a reference to an issue ("Work owner/repo#12"). */
export function taskIssueRef(task: string | undefined): { repo: string; n: number } | undefined {
  // The repo can never look like an option: it starts with a letter or digit.
  const m = /^\s*(?:work|solve|fix|do)?\s*(?:on\s+)?([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*)#(\d+)\s*$/i.exec(task ?? '');
  return m ? { repo: m[1]!, n: Number(m[2]) } : undefined;
}

/** run_start's title and task fields from the dispatch task. A bare issue reference is titled
 *  with the issue's title when `gh` answers within 4 s; otherwise with the task's first line. */
export function runStartFields(task: string | undefined, lookup: (repo: string, n: number) => string | undefined = ghIssueTitle): { title?: string; task?: string } {
  if (!task?.trim()) return {};
  const ref = taskIssueRef(task);
  let title: string | undefined;
  if (ref) {
    try {
      title = lookup(ref.repo, ref.n)?.trim() || undefined;
    } catch {
      // no gh, no network: the task's own words
    }
  }
  title = title ? runTitle(`${title} (${ref!.repo}#${ref!.n})`) : runTitle(task);
  return { ...(title ? { title } : {}), task };
}

function ghIssueTitle(repo: string, n: number): string | undefined {
  const out = execFileSync('gh', ['issue', 'view', String(n), '-R', repo, '--json', 'title', '-q', '.title'], {
    encoding: 'utf8', timeout: 4_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\n')[0];
}

/**
 * Best-effort batched POST of persisted events to the connected API
 * (`POST /agent-executions/{id}/events`). The jsonl file stays authoritative:
 * a failed batch is retried once, then dropped — the server reconciles from
 * the file later, so losing a live batch costs latency, never data. The
 * timer is unref'd and every failure is swallowed: the flusher must never
 * hold the process open or throw into the run path.
 */
export class ExecEventFlusher {
  private buf: PersistedExecEvent[] = [];
  private bufBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly runId: string,
    private readonly batchSize = FLUSH_BATCH_SIZE,
    private readonly intervalMs = FLUSH_INTERVAL_MS,
    private readonly batchBytes = FLUSH_BATCH_BYTES,
  ) {}

  push(line: PersistedExecEvent): void {
    // The API copy is the file's line, text whole (#1316: the store keeps full history).
    this.buf.push(line);
    this.bufBytes += JSON.stringify(line).length;
    if (this.buf.length >= this.batchSize || this.bufBytes >= this.batchBytes) {
      void this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  /** Send everything buffered. Batches stay ordered via an internal chain. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buf.length === 0) return this.chain;
    const batch = this.buf;
    this.buf = [];
    this.bufBytes = 0;
    this.chain = this.chain.then(async () => {
      // Lazy import: no network machinery loaded unless a flush actually runs.
      const { reportExecutionEvents } = await import('./api-client.js');
      const ok = await reportExecutionEvents(this.runId, batch);
      if (!ok) await reportExecutionEvents(this.runId, batch); // once more, then let the file replay cover it
    }).catch(() => {});
    return this.chain;
  }

  /** Final flush at run end. Awaitable, but safe to fire-and-forget. */
  close(): Promise<void> {
    return this.flush();
  }
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
 * - Optionally mirrors every persisted line to an `ExecEventFlusher` (#1158)
 *   — always after the file append, so the projection never leads the source.
 */
export class ExecEventWriter {
  private seq = 0;
  private bytes = 0;
  private lastRunning = -Infinity;
  private dropped = 0;
  private dead = false;
  private closed = false;
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  private readonly source?: string;
  private readonly provider?: string;
  private readonly sessionId?: string;
  private readonly flusher?: ExecEventFlusher;

  constructor(
    private readonly file: string,
    private readonly runId: string,
    opts: {
      maxEvents?: number; maxBytes?: number;
      source?: string; provider?: string; sessionId?: string;
      flusher?: ExecEventFlusher;
    } = {},
  ) {
    const envMax = Number(process.env.SQUADS_EVENTS_MAX);
    const envBytes = Number(process.env.SQUADS_EVENTS_MAX_BYTES);
    this.maxEvents = opts.maxEvents ?? (Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX_EVENTS);
    this.maxBytes = opts.maxBytes ?? (Number.isFinite(envBytes) && envBytes > 0 ? envBytes : DEFAULT_MAX_BYTES);
    this.source = opts.source;
    this.provider = opts.provider;
    this.sessionId = opts.sessionId;
    this.flusher = opts.flusher;
    try {
      const dir = dirname(file);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Resume seq after any events already persisted for this run (#1159):
      // spawn-time run_start + reconcile-time tool events share one file, and
      // the Postgres projection's (run_id, seq) identity silently drops
      // colliding seqs — a restarted counter would eat real events.
      if (existsSync(file)) {
        const existing = readFileSync(file, 'utf8');
        for (let i = 0; i < existing.length; i++) {
          if (existing.charCodeAt(i) === 10) this.seq++;
        }
        this.bytes = existing.length;
      }
    } catch {
      this.dead = true;
    }
  }

  emit(event: ExecEvent, agent?: string): void {
    if (this.dead || this.closed) return;
    // Running usage is for live views: at most one every USAGE_RUNNING_MS, so it can't crowd
    // tool events out of the cap (the terminal token_usage always lands).
    if (event.type === 'usage_running') {
      const now = Date.now();
      if (now - this.lastRunning < USAGE_RUNNING_MS) return;
      this.lastRunning = now;
    }
    const capped = this.seq >= this.maxEvents || this.bytes >= this.maxBytes;
    if (capped && !UNCAPPED_TYPES.has(event.type)) {
      this.dropped++;
      return;
    }
    // Audit chain (#920): a nested run stamps its root so a cascade's events
    // are queryable by one id. Read per-emit (cheap) — inherited from
    // buildAgentEnv, or derived from the interactive session this CLI runs
    // inside (#1181).
    const root = deriveRootRunId();
    const v2 = Boolean(this.source || this.provider || this.sessionId);
    // Redaction at write time (#1275): the one place every event passes, so
    // the file and the API flush below carry the same redacted line.
    // It never throws into the run: an event that can't be redacted is dropped, never written raw.
    let safe: ExecEvent;
    let sensitivity: Sensitivity;
    try {
      ({ event: safe, sensitivity } = redactEvent(event));
    } catch {
      safe = { type: 'truncated', droppedCount: 1, reason: `a ${String(event.type)} event could not be redacted and was dropped` };
      sensitivity = 'high';
    }
    const line: PersistedExecEvent = {
      schema_version: EXEC_EVENT_SCHEMA_VERSION,
      v: v2 ? 2 : 1,
      runId: this.runId,
      ...(root && root !== this.runId ? { root } : {}),
      seq: this.seq,
      ts: new Date().toISOString(),
      ...(agent ? { agent } : {}),
      ...(this.source ? { source: this.source } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
      sensitivity,
      event: safe,
    };
    try {
      const serialized = JSON.stringify(line) + '\n';
      appendFileSync(this.file, serialized);
      this.seq++;
      this.bytes += serialized.length;
    } catch {
      this.dead = true; // fs is broken — stop trying, never throw into the run
      return;
    }
    // After the append — the file is the source of truth, the API a projection.
    this.flusher?.push(line);
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
    // Fire-and-forget: the engine keeps the process alive past close() (auto
    // commit, terminal reports); anything the flush loses, file replay covers.
    void this.flusher?.close();
  }

  /** Awaitable final flush for callers that can wait (reconcile paths). */
  async drain(): Promise<void> {
    await this.flusher?.close();
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
  provider?: string,
  harness?: string,
  errorEvent?: Extract<ExecEvent, { type: 'error' }>,
): number {
  // Adapter selection by HARNESS, not provider (#1177): the same provider can
  // run through either harness (e.g. deepseek via `claude --model` OR via
  // `opencode run`), and each harness has its own stream shape.
  const adapter = harness === 'opencode'
    ? createOpencodeStreamJsonAdapter()
    : harness === 'kimi-code'
      ? createKimiStreamJsonAdapter()
      : createClaudeStreamJsonAdapter();
  const file = execEventsFile(obsRoot, executionId);
  // provider attribution on every event (cli#1175): the run's model provider
  // (glm/deepseek/anthropic/…) travels with the normalized events so the app
  // can badge them per-provider — same as live-flushed events carry it.
  const writer = new ExecEventWriter(file, executionId, { source: 'squads-cli', provider });
  for (const line of rawLog.split('\n')) {
    writer.ingestProviderLine(adapter, line, agent);
  }
  // Only close a stream that actually opened: a legacy plain-text log yields
  // zero events, and a run_end there would fabricate an event file.
  if (errorEvent && writer.writtenCount > 0) writer.emit(errorEvent, agent);
  if (runEnd && writer.writtenCount > 0) writer.emit(runEnd, agent);
  writer.close();
  // Reconcile doubles as API replay (#1158/#1159): the run's live flushes
  // never happened (spawning CLI long gone), so POST the WHOLE file — spawn-
  // time run_start included. Idempotent server-side; best-effort as always.
  if (writer.writtenCount > 0) void replayEventsFile(file, executionId);
  return writer.writtenCount;
}

/** Best-effort replay of a run's full events file to the connected API. */
export async function replayEventsFile(file: string, executionId: string): Promise<void> {
  try {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as PersistedExecEvent; } catch { return null; } })
      .filter((e): e is PersistedExecEvent => e !== null)
      // Lines written before versioning are the v1 shape: stamp them so the API never sees an unversioned one.
      .map((e) => (e.schema_version === undefined ? { ...e, schema_version: EXEC_EVENT_SCHEMA_VERSION } : e));
    if (!lines.length) return;
    const { reportExecutionEvents } = await import('./api-client.js');
    for (let i = 0; i < lines.length; i += 500) {
      if (!await reportExecutionEvents(executionId, lines.slice(i, i + 500))) return;
    }
  } catch { /* offline-first: the file remains the source of truth */ }
}

// ── Run lifecycle timings (#1355) ─────────────────────────────────────
//
// A run's lifecycle does not end at `run_end`: its commit is gated, a PR
// opened, and a reviewer verdict returned (cli#1354). The ledger row carries
// the whole timeline. `dispatchedAt`/`firstCommitAt`/`endedAt` come from
// events the runtime already writes; `gatedAt`/`prOpenedAt`/`verdictAt` fill
// once the gate/review event types (cli#1354) land. Everything is best-effort:
// an unreadable or missing events file yields an empty timeline, never a throw.

export interface RunLifecycleTimings {
  dispatchedAt?: string;
  firstCommitAt?: string;
  endedAt?: string;
  gatedAt?: string;
  prOpenedAt?: string;
  verdictAt?: string;
}

/** First-seen timestamps for each lifecycle milestone, in event order. */
export function deriveLifecycleTimings(events: PersistedExecEvent[]): RunLifecycleTimings {
  const t: RunLifecycleTimings = {};
  for (const e of events) {
    // `gate_result` / `review_verdict` are added by cli#1354; read the raw type
    // string so this stays forward-compatible before those types exist.
    const type: string = e.event.type;
    if (type === 'run_start') {
      if (!t.dispatchedAt) t.dispatchedAt = e.ts;
    } else if (type === 'run_end') {
      if (!t.endedAt) t.endedAt = e.ts;
    } else if (type === 'artifact') {
      const kind = (e.event as { kind?: string }).kind;
      if (kind === 'commit' && !t.firstCommitAt) t.firstCommitAt = e.ts;
      else if (kind === 'pr' && !t.prOpenedAt) t.prOpenedAt = e.ts;
    } else if (type === 'gate_result') {
      if (!t.gatedAt) t.gatedAt = e.ts;
    } else if (type === 'review_verdict') {
      if (!t.verdictAt) t.verdictAt = e.ts;
    }
  }
  return t;
}

/** Read + parse a run's persisted events file; [] on any read/parse failure. */
export function readRunEventsFile(file: string): PersistedExecEvent[] {
  try {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l) as PersistedExecEvent; } catch { return null; } })
      .filter((e): e is PersistedExecEvent => e !== null);
  } catch {
    return [];
  }
}

/** Lifecycle timings for a run, straight from its events file. */
export function deriveLifecycleTimingsForRun(file: string): RunLifecycleTimings {
  return deriveLifecycleTimings(readRunEventsFile(file));
}
