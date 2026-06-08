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
}

export function emptyUsage(): StreamUsage {
  return {
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    num_turns: 0,
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
  };
}

/** What a single parsed line yields, if anything actionable. */
export interface ParsedLine {
  /** Assistant text emitted by this line (to stream live + accumulate). */
  text?: string;
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
}

/**
 * Parse a single JSONL line from the stream. Returns the assistant text on
 * `assistant` events and the canonical result (text + usage) on the `result`
 * event. Malformed / non-JSON / uninteresting lines return an empty object.
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
    const message = ev.message as { content?: AssistantContentBlock[] } | undefined;
    const blocks = message?.content;
    if (Array.isArray(blocks)) {
      const text = blocks
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('');
      if (text) return { text };
    }
    return {};
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
  private resultText: string | null = null;
  private isError = false;
  private sawResult = false;

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
    return { text, usage: this.usage, isError: this.isError, sawResult: this.sawResult };
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
