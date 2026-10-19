/**
 * Kimi Code CLI harness — stdout parsing and session-wire usage (cli#1309).
 *
 * `kimi -p <prompt> --output-format stream-json` (kimi-code 2.2.0) prints
 * OpenAI-chat-shaped messages, one JSON object per line:
 *   {"role":"meta","type":"system.version","version":"2.2.0"}
 *   {"role":"assistant","tool_calls":[{"type":"function","id":…,"function":{"name":"Bash","arguments":"{…}"}}]}
 *   {"role":"tool","tool_call_id":…,"content":"…"}
 *   {"role":"assistant","content":"<final text>"}
 *   {"role":"meta","type":"session.resume_hint","session_id":"session_…",…}
 * Shapes captured from a live run (fixture: test/fixtures/kimi-code/tool-run.jsonl).
 *
 * USAGE IS NOT ON STDOUT. It is recorded per step in the session's wire log:
 * `~/.kimi-code/session_index.jsonl` maps `sessionId` → `sessionDir`, and
 * `<sessionDir>/agents/main/wire.jsonl` holds one `usage.record` per step. The
 * same usage is repeated inside `context.append_loop_event` step.end events —
 * count ONLY `usage.record` or every step is double-counted.
 *
 * Cost: the harness runs on the Kimi For Coding SUBSCRIPTION, so squads records
 * cost_usd 0 with `billing: subscription` and never a list-price estimate.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';
import {
  bashCommandKinds, emptyOutcomes, emptyUsage, resolveBashOutcome,
  type BashOutcomeKind, type StreamResult,
} from './stream-json.js';

export interface KimiToolCall {
  type?: string;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** One stdout line: an OpenAI-style chat message or a `meta` event. */
export interface KimiMessage {
  role: string;
  type?: string;
  content?: unknown;
  tool_calls?: KimiToolCall[];
  tool_call_id?: string;
  session_id?: string;
  /** OpenAI-style reasoning field; not seen on kimi-code 2.2.0 stdout, read when present. */
  reasoning_content?: unknown;
}

/** Parse one stdout line; null for blank lines and non-JSON noise (stderr in the same log). */
export function parseKimiLine(line: string): KimiMessage | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const msg = JSON.parse(trimmed) as KimiMessage;
    return msg && typeof msg.role === 'string' ? msg : null;
  } catch {
    return null;
  }
}

/** A tool call's arguments object (arguments arrive as a JSON-encoded string). */
export function kimiToolArgs(call: KimiToolCall): Record<string, unknown> {
  const raw = call.function?.arguments;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Tools that write files (kimi names seen so far: Bash, Read, Write). */
export function isKimiWriteTool(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'write' || lower === 'edit' || lower === 'strreplace';
}

/** Tool result content as text (content is a string on the captured shapes). */
export function kimiContentText(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

/**
 * One-shot parser for a complete kimi stream-json log. Same `StreamResult`
 * contract as `parseStreamJson`, so the spool reconcile applies the same
 * honesty rules:
 *  - outcomes count verified artifacts from the paired tool result, never the
 *    command text (cli#1134);
 *  - `sawResult` means the terminal `session.resume_hint` was seen — a log
 *    without one is an interrupted run (#1131);
 *  - usage stays zero here: stdout carries none (see readKimiSessionUsage).
 */
export function parseKimiJson(jsonl: string, onText?: (t: string) => void): StreamResult {
  const outcomes = emptyOutcomes();
  const pending = new Map<string, BashOutcomeKind[]>();
  let text = '';
  let sawResult = false;

  for (const line of jsonl.split('\n')) {
    const msg = parseKimiLine(line);
    if (!msg) continue;
    if (msg.role === 'assistant') {
      for (const call of msg.tool_calls ?? []) {
        outcomes.actions += 1;
        const name = call.function?.name ?? '';
        if (isKimiWriteTool(name)) outcomes.files_edited += 1;
        if (name.toLowerCase() === 'bash' && call.id) {
          const kinds = bashCommandKinds(String(kimiToolArgs(call).command ?? ''));
          if (kinds.length > 0) pending.set(call.id, kinds);
        }
      }
      const content = kimiContentText(msg.content);
      if (content) {
        text += text ? '\n' + content : content;
        onText?.(content);
      }
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      const kinds = pending.get(msg.tool_call_id);
      if (kinds) {
        pending.delete(msg.tool_call_id);
        const inc = resolveBashOutcome(kimiContentText(msg.content), kinds);
        outcomes.commits += inc.commits;
        outcomes.prs_created += inc.prs_created;
        outcomes.issues_created += inc.issues_created;
      }
    } else if (msg.role === 'meta' && msg.type === 'session.resume_hint') {
      sawResult = true;
    }
  }

  return { text, usage: emptyUsage(), isError: false, sawResult, outcomes, openBackgroundSubagents: 0 };
}

const SESSION_ID_RE = /^session_[A-Za-z0-9-]+$/;

/** The kimi session id from a log (`session.resume_hint`), or undefined. */
export function extractKimiSessionId(output: string): string | undefined {
  let found: string | undefined;
  for (const line of output.split('\n')) {
    const msg = parseKimiLine(line);
    if (msg?.role === 'meta' && msg.type === 'session.resume_hint' && typeof msg.session_id === 'string'
        && SESSION_ID_RE.test(msg.session_id)) {
      found = msg.session_id;
    }
  }
  return found;
}

export interface KimiSessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  model: string;
  steps: number;
}

/** kimi's own state root. Overridable for tests. */
export function kimiHome(): string {
  return join(homedir(), '.kimi-code');
}

/** `sessionDir` for a session id, from kimi's session index (last entry wins). */
function resolveSessionDir(sessionId: string, home: string): string | undefined {
  const indexPath = join(home, 'session_index.jsonl');
  if (!existsSync(indexPath)) return undefined;
  let dir: string | undefined;
  for (const line of readFileSync(indexPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { sessionId?: string; sessionDir?: string };
      if (entry.sessionId === sessionId && typeof entry.sessionDir === 'string') dir = entry.sessionDir;
    } catch { /* torn trailing line while kimi is still writing */ }
  }
  if (!dir) return undefined;
  return isAbsolute(dir) ? dir : join(home, dir);
}

/** The main agent's wire log for a session, or undefined when the id, index entry or file is missing. */
function sessionWirePath(sessionId: string, home: string): string | undefined {
  if (!SESSION_ID_RE.test(sessionId)) return undefined;
  const sessionDir = resolveSessionDir(sessionId, home);
  if (!sessionDir) return undefined;
  const wire = join(sessionDir, 'agents', 'main', 'wire.jsonl');
  return existsSync(wire) ? wire : undefined;
}

/**
 * The model's reasoning for a kimi session, in step order, from its wire log (#1316). Reads the
 * `context.append_loop_event` records whose event is a `content.part` with a `think` part — one per
 * step that reasoned. The same text repeats inside `agent.message.appended`; reading only the loop
 * events counts it once. Empty when the wire log is missing or unreadable.
 */
export function readKimiSessionReasoning(sessionId: string, home: string = kimiHome()): { step?: number; text: string }[] {
  const out: { step?: number; text: string }[] = [];
  try {
    const wire = sessionWirePath(sessionId, home);
    if (!wire) return out;
    for (const line of readFileSync(wire, 'utf-8').split('\n')) {
      if (!line.includes('"think"') || !line.includes('"context.append_loop_event"')) continue;
      let rec: { type?: string; event?: { type?: string; step?: unknown; part?: { type?: string; think?: unknown } } };
      try { rec = JSON.parse(line); } catch { continue; }
      const ev = rec.event;
      if (rec.type !== 'context.append_loop_event' || ev?.type !== 'content.part' || ev.part?.type !== 'think') continue;
      const text = ev.part.think;
      if (typeof text !== 'string' || !text.trim()) continue;
      out.push(typeof ev.step === 'number' ? { step: ev.step, text } : { text });
    }
  } catch { /* unreadable wire: no reasoning, never a run failure */ }
  return out;
}

/**
 * Token usage for a kimi session from its wire log. Counts ONLY `usage.record`
 * records (one per step). Returns null when the index entry, the wire log or any
 * usage record is missing — callers record usage as null, never a fabricated 0.
 *
 * Mapping: input = inputOther + inputCacheRead + inputCacheCreation;
 * cache_read = inputCacheRead; cache_write = inputCacheCreation; output = output.
 */
export function readKimiSessionUsage(sessionId: string, home: string = kimiHome()): KimiSessionUsage | null {
  try {
    const wire = sessionWirePath(sessionId, home);
    if (!wire) return null;
    const total: KimiSessionUsage = {
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, model: '', steps: 0,
    };
    for (const line of readFileSync(wire, 'utf-8').split('\n')) {
      if (!line.includes('"usage.record"')) continue;
      let rec: { type?: string; usage?: Record<string, unknown>; model?: unknown };
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== 'usage.record' || !rec.usage) continue;
      const n = (k: string) => (typeof rec.usage?.[k] === 'number' ? rec.usage[k] as number : 0);
      total.input_tokens += n('inputOther') + n('inputCacheRead') + n('inputCacheCreation');
      total.cache_read_tokens += n('inputCacheRead');
      total.cache_write_tokens += n('inputCacheCreation');
      total.output_tokens += n('output');
      if (typeof rec.model === 'string' && rec.model) total.model = rec.model;
      total.steps += 1;
    }
    return total.steps > 0 ? total : null;
  } catch {
    return null;
  }
}

/** CLIConfig.parseUsage for kimi: tokens from the session wire, cost 0 (subscription). */
export function parseKimiUsage(output: string): { input_tokens: number; output_tokens: number; cost_usd: number } | null {
  const sessionId = extractKimiSessionId(output);
  const usage = sessionId ? readKimiSessionUsage(sessionId) : null;
  return usage ? { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cost_usd: 0 } : null;
}

const KIMI_AUTH_RE = /not (?:logged|signed) in|log ?in required|please (?:log ?in|sign ?in)|unauthori[sz]ed|authentication (?:failed|required)|invalid[_ ]token|\b401\b/i;

/**
 * Detect a not-logged-in kimi from its output. A run that reached
 * `session.resume_hint` ran fine and is never an auth failure. The match
 * phrases are heuristic (the not-logged-in output was not captured); the
 * run still fails loud via the missing-terminal-event path when they miss.
 */
export function detectKimiAuthError(output: string): string | null {
  if (extractKimiSessionId(output)) return null;
  if (!KIMI_AUTH_RE.test(output)) return null;
  return 'kimi is not logged in — run `kimi` and log in with your Kimi For Coding subscription (squads never falls back to a metered key)';
}
