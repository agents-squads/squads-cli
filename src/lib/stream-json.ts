/**
 * stream-json parser — turns the JSONL event stream emitted by
 * `claude --print --output-format stream-json --verbose` into (a) the agent's
 * text response and (b) real usage/cost numbers.
 *
 * The stream is one JSON object per line:
 *   {"type":"system","subtype":"init",...}                                 — session init
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}} — 1+ chunks
 *   {"type":"result","subtype":"success","result":"…",
 *     "total_cost_usd":0.12,"usage":{input_tokens,output_tokens,
 *     cache_read_input_tokens,cache_creation_input_tokens},
 *     "num_turns":3,"is_error":false}                                      — final
 *
 * NOTE: stream-json REQUIRES the `--verbose` flag on the claude invocation to
 * emit events. That is separate from our user-facing `config.verbose`, which
 * only controls whether we DISPLAY the assistant text live.
 *
 * No external dependencies. Pure functions so the parser is unit-testable
 * against a fixture of JSONL events (see test/stream-json-parser.test.ts).
 */

/** Canonical usage/cost captured from the terminal `result` event. */
export interface StreamUsage {
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  num_turns: number;
  /**
   * Model id seen on the stream (assistant/result events). Carried so callers
   * can derive cost from tokens × pricing when cost_usd is 0 (cut-off runs).
   * Empty string when unknown.
   */
  model?: string;
}

export function emptyUsage(): StreamUsage {
  return {
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    num_turns: 0,
    model: '',
  };
}

/** Add two usage records (used to total a multi-agent conversation). */
export function addUsage(a: StreamUsage, b: StreamUsage): StreamUsage {
  return {
    cost_usd: a.cost_usd + b.cost_usd,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    num_turns: a.num_turns + b.num_turns,
    // Keep the first known model id (agents in one run share a model).
    model: a.model || b.model || '',
  };
}

/**
 * What an agent actually DID during a run — derived from the `tool_use` blocks
 * in the stream, so observability records real output (not just cost). These
 * are accurate counts of the agent's own actions, not fuzzy correlations.
 */
export interface RunOutcomes {
  actions: number;        // total tool_use calls — activity proxy (0 ≈ noise)
  files_edited: number;   // Edit / Write / NotebookEdit calls
  commits: number;        // `git … commit` Bash calls
  prs_created: number;    // `gh pr create` Bash calls
  issues_created: number; // `gh issue create` Bash calls
}

export function emptyOutcomes(): RunOutcomes {
  return { actions: 0, files_edited: 0, commits: 0, prs_created: 0, issues_created: 0 };
}

export function addOutcomes(a: RunOutcomes, b: RunOutcomes): RunOutcomes {
  return {
    actions: a.actions + b.actions,
    files_edited: a.files_edited + b.files_edited,
    commits: a.commits + b.commits,
    prs_created: a.prs_created + b.prs_created,
    issues_created: a.issues_created + b.issues_created,
  };
}

/** What a single parsed line yields, if anything actionable. */
export interface ParsedLine {
  /** Assistant text emitted by this line (to stream live + accumulate). */
  text?: string;
  /** Outcomes from this event's `tool_use` blocks (accumulated across the run). */
  outcomes?: RunOutcomes;
  /**
   * Per-message usage from an `assistant` event (`message.usage`). Accumulated
   * across the stream so a cut-off run (no terminal `result` event) still has
   * real token counts. `cost_usd`/`num_turns` are not present on assistant
   * events, so this carries only token fields + the model id.
   */
  assistantUsage?: StreamUsage;
  /** Set on the terminal `result` event. */
  result?: {
    /** Canonical full response text. */
    text: string;
    usage: StreamUsage;
    isError: boolean;
  };
}

interface AssistantContentBlock {
  type?: string;
  text?: string;
  name?: string;                     // tool name on `tool_use` blocks
  input?: Record<string, unknown>;   // tool input (e.g. Bash `command`)
}

/** Count what the agent did from a message's `tool_use` blocks. */
function parseOutcomes(blocks: AssistantContentBlock[]): RunOutcomes {
  const o = emptyOutcomes();
  for (const b of blocks) {
    if (!b || b.type !== 'tool_use') continue;
    o.actions += 1;
    const name = (b.name || '').toLowerCase();
    if (name === 'edit' || name === 'write' || name === 'notebookedit') o.files_edited += 1;
    if (name === 'bash') {
      const cmd = String((b.input as { command?: unknown } | undefined)?.command ?? '');
      if (/\bgit\b/.test(cmd) && /\bcommit\b/.test(cmd)) o.commits += 1;
      if (/\bgh\b/.test(cmd) && /\bpr\s+create\b/.test(cmd)) o.prs_created += 1;
      if (/\bgh\b/.test(cmd) && /\bissue\s+create\b/.test(cmd)) o.issues_created += 1;
    }
  }
  return o;
}

/** Tokens + model from a single `assistant` event's `message.usage`. */
function parseAssistantUsage(message: Record<string, unknown> | undefined): StreamUsage | undefined {
  if (!message) return undefined;
  const u = (message.usage as Record<string, number>) || {};
  const input = u.input_tokens || 0;
  const output = u.output_tokens || 0;
  const cacheRead = u.cache_read_input_tokens || 0;
  const cacheWrite = u.cache_creation_input_tokens || 0;
  // No usage numbers on this event → nothing to accumulate.
  if (!input && !output && !cacheRead && !cacheWrite) return undefined;
  return {
    cost_usd: 0, // assistant events don't carry cost — derived later from tokens
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    num_turns: 0,
    model: typeof message.model === 'string' ? message.model : '',
  };
}

/**
 * Parse a single JSONL line from the stream. Returns the assistant text + per-
 * message usage on `assistant` events, and the canonical result (text + usage)
 * on the `result` event. Malformed / non-JSON / uninteresting lines return an
 * empty object.
 */
export function parseStreamJsonLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return {};

  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return {}; // not JSON (e.g. a stray warning line) — ignore
  }

  if (ev.type === 'assistant') {
    const message = ev.message as ({ content?: AssistantContentBlock[] } & Record<string, unknown>) | undefined;
    const out: ParsedLine = {};
    const blocks = message?.content;
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      if (text) out.text = text;
      const outcomes = parseOutcomes(blocks);
      if (outcomes.actions > 0) out.outcomes = outcomes;
    }
    const assistantUsage = parseAssistantUsage(message);
    if (assistantUsage) out.assistantUsage = assistantUsage;
    return out;
  }

  if (ev.type === 'result') {
    const u = (ev.usage as Record<string, number>) || {};
    return {
      result: {
        text: typeof ev.result === 'string' ? ev.result : '',
        isError: ev.is_error === true,
        usage: {
          cost_usd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0,
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cache_read_tokens: u.cache_read_input_tokens || 0,
          cache_write_tokens: u.cache_creation_input_tokens || 0,
          num_turns: typeof ev.num_turns === 'number' ? ev.num_turns : 0,
          model: typeof ev.model === 'string' ? ev.model : '',
        },
      },
    };
  }

  return {};
}

/** Final outcome of consuming a complete stream. */
export interface StreamResult {
  /** Canonical response text: the `result` event's text, or accumulated assistant text as fallback. */
  text: string;
  usage: StreamUsage;
  /** True when the terminal result event reported `is_error: true`. */
  isError: boolean;
  /** True when a terminal `result` event was actually seen. */
  sawResult: boolean;
  /** What the agent did: tool actions / commits / PRs / issues / file edits. */
  outcomes: RunOutcomes;
}

/**
 * Stateful, line-buffered accumulator over the JSONL stream. Feed it raw stdout
 * chunks (already decoded to strings); it tracks assistant text, invokes the
 * optional `onText` sink for live display, and captures the terminal result.
 *
 * Call `flush()` once the process closes to drain any partial trailing line.
 */
export class StreamJsonAccumulator {
  private buf = '';
  private assistantText = '';
  private usage: StreamUsage = emptyUsage();
  /**
   * Running token sum across `assistant` events. Used as the cut-off fallback:
   * if the run is killed (timeout / turn limit) before the terminal `result`
   * event, this still holds real per-message token counts so observability gets
   * non-zero usage. Each assistant event reports the cumulative tokens for that
   * turn; we sum them across the stream (matches the existing session-file
   * parser in observability.ts, which sums message.usage the same way).
   */
  private assistantUsage: StreamUsage = emptyUsage();
  private resultText: string | null = null;
  private isError = false;
  private sawResult = false;
  /** Running sum of what the agent did across the whole stream. */
  private outcomes: RunOutcomes = emptyOutcomes();

  /** @param onText optional sink for live display of assistant text chunks. */
  constructor(private readonly onText?: (text: string) => void) {}

  /** Feed a decoded stdout chunk; processes all complete lines within it. */
  push(chunk: string): void {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    for (const line of lines) this.consume(line);
  }

  /** Drain the final partial line (call on process close). */
  flush(): void {
    if (this.buf) {
      this.consume(this.buf);
      this.buf = '';
    }
  }

  private consume(line: string): void {
    const parsed = parseStreamJsonLine(line);
    if (parsed.text) {
      this.assistantText += this.assistantText ? '\n' + parsed.text : parsed.text;
      this.onText?.(parsed.text);
    }
    if (parsed.assistantUsage) {
      this.assistantUsage = addUsage(this.assistantUsage, parsed.assistantUsage);
    }
    if (parsed.outcomes) {
      this.outcomes = addOutcomes(this.outcomes, parsed.outcomes);
    }
    if (parsed.result) {
      this.sawResult = true;
      this.resultText = parsed.result.text;
      this.isError = parsed.result.isError;
      this.usage = parsed.result.usage;
    }
  }

  /** The canonical result after the stream is fully consumed. */
  getResult(): StreamResult {
    // Prefer the result event's text (canonical full response); fall back to
    // accumulated assistant chunks when no result text was emitted.
    const text = this.resultText && this.resultText.length > 0
      ? this.resultText
      : this.assistantText;
    // Usage: the terminal `result` event is canonical (a single aggregate over
    // the whole run, incl. cost). When it's absent (cut off mid-response), fall
    // back to the summed assistant-event tokens so the record still carries real
    // quota numbers — cost_usd may be 0 here (assistant events don't report it),
    // which is fine: the caller derives cost from tokens × pricing.
    const usage = this.sawResult ? this.usage : this.assistantUsage;
    return { text, usage, isError: this.isError, sawResult: this.sawResult, outcomes: this.outcomes };
  }
}

/**
 * One-shot helper: parse a complete JSONL string. Convenience for tests and
 * non-streaming callers.
 */
export function parseStreamJson(jsonl: string, onText?: (t: string) => void): StreamResult {
  const acc = new StreamJsonAccumulator(onText);
  acc.push(jsonl);
  acc.flush();
  return acc.getResult();
}
