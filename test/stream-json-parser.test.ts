/**
 * Tests for src/lib/stream-json.ts — the JSONL stream-json parser that extracts
 * the agent's response text + real cost/usage from
 * `claude --print --output-format stream-json --verbose`.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  parseStreamJsonLine,
  parseStreamJson,
  StreamJsonAccumulator,
  emptyUsage,
  addUsage,
} from '../src/lib/stream-json.js';

// A realistic JSONL event stream: system init → two assistant chunks → result.
const FIXTURE = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', tools: ['Read'] }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on the task.' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '## STATUS: DONE' }] } }),
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Working on the task.\n## STATUS: DONE',
    total_cost_usd: 0.1234,
    usage: {
      input_tokens: 1500,
      output_tokens: 320,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 200,
    },
    num_turns: 4,
    session_id: 'abc',
    is_error: false,
  }),
].join('\n') + '\n';

describe('parseStreamJsonLine', () => {
  it('extracts assistant text from a text content block', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })
    );
    expect(parsed.text).toBe('hello');
    expect(parsed.result).toBeUndefined();
  });

  it('concatenates multiple text blocks in one assistant message', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } })
    );
    expect(parsed.text).toBe('ab');
  });

  it('ignores non-text content blocks (tool_use)', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })
    );
    expect(parsed.text).toBeUndefined();
  });

  it('captures result text + usage + cost from the result event', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        result: 'final answer',
        total_cost_usd: 0.5,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
        num_turns: 3,
        is_error: false,
      })
    );
    expect(parsed.result).toBeDefined();
    expect(parsed.result!.text).toBe('final answer');
    expect(parsed.result!.isError).toBe(false);
    expect(parsed.result!.usage).toEqual({
      cost_usd: 0.5,
      input_tokens: 10,
      output_tokens: 20,
      cache_read_tokens: 30,
      cache_write_tokens: 40,
      num_turns: 3,
    });
  });

  it('flags is_error from the result event', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({ type: 'result', result: 'boom', is_error: true, total_cost_usd: 0.01, usage: {} })
    );
    expect(parsed.result!.isError).toBe(true);
    expect(parsed.result!.text).toBe('boom');
  });

  it('ignores system events and blank/non-JSON lines', () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual({});
    expect(parseStreamJsonLine('')).toEqual({});
    expect(parseStreamJsonLine('  ')).toEqual({});
    expect(parseStreamJsonLine('not json at all')).toEqual({});
    expect(parseStreamJsonLine('{ broken json')).toEqual({});
  });

  it('defaults missing usage fields to 0', () => {
    const parsed = parseStreamJsonLine(JSON.stringify({ type: 'result', result: 'x' }));
    expect(parsed.result!.usage).toEqual(emptyUsage());
  });
});

describe('parseStreamJson (full fixture)', () => {
  it('returns the canonical result text and real cost/usage', () => {
    const out = parseStreamJson(FIXTURE);
    expect(out.sawResult).toBe(true);
    expect(out.isError).toBe(false);
    expect(out.text).toBe('Working on the task.\n## STATUS: DONE');
    expect(out.usage.cost_usd).toBeCloseTo(0.1234, 4);
    expect(out.usage.input_tokens).toBe(1500);
    expect(out.usage.output_tokens).toBe(320);
    expect(out.usage.cache_read_tokens).toBe(8000);
    expect(out.usage.cache_write_tokens).toBe(200);
    expect(out.usage.num_turns).toBe(4);
  });

  it('streams each assistant text chunk to the onText sink', () => {
    const seen: string[] = [];
    parseStreamJson(FIXTURE, (t) => seen.push(t));
    expect(seen).toEqual(['Working on the task.', '## STATUS: DONE']);
  });

  it('falls back to accumulated assistant text when no result text is present', () => {
    const noResultText = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial output' }] } }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.02, usage: { input_tokens: 5, output_tokens: 5 } }),
    ].join('\n');
    const out = parseStreamJson(noResultText);
    expect(out.text).toBe('partial output');
    expect(out.usage.cost_usd).toBeCloseTo(0.02, 4);
  });

  it('reports sawResult=false and empty usage when the stream has no result event', () => {
    const onlyAssistant = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    const out = parseStreamJson(onlyAssistant);
    expect(out.sawResult).toBe(false);
    expect(out.text).toBe('hi');
    expect(out.usage).toEqual(emptyUsage());
  });
});

describe('StreamJsonAccumulator (chunk boundaries)', () => {
  it('handles JSON events split across multiple stdout chunks', () => {
    const acc = new StreamJsonAccumulator();
    // Split the fixture at an arbitrary byte boundary mid-line.
    const mid = Math.floor(FIXTURE.length / 2);
    acc.push(FIXTURE.slice(0, mid));
    acc.push(FIXTURE.slice(mid));
    acc.flush();
    const out = acc.getResult();
    expect(out.text).toBe('Working on the task.\n## STATUS: DONE');
    expect(out.usage.cost_usd).toBeCloseTo(0.1234, 4);
  });

  it('drains a trailing partial (no final newline) on flush', () => {
    const acc = new StreamJsonAccumulator();
    // No trailing newline — the result line stays buffered until flush().
    acc.push(JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.03, usage: { output_tokens: 7 } }));
    expect(acc.getResult().text).toBe(''); // not yet consumed
    acc.flush();
    const out = acc.getResult();
    expect(out.text).toBe('done');
    expect(out.usage.output_tokens).toBe(7);
  });
});

describe('usage helpers', () => {
  it('emptyUsage is all zeros', () => {
    expect(emptyUsage()).toEqual({
      cost_usd: 0, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, num_turns: 0,
    });
  });

  it('addUsage sums field-by-field (for multi-agent conversation totals)', () => {
    const a = { cost_usd: 0.1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 1, cache_write_tokens: 2, num_turns: 1 };
    const b = { cost_usd: 0.2, input_tokens: 20, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 4, num_turns: 2 };
    expect(addUsage(a, b)).toEqual({
      cost_usd: 0.30000000000000004, // float, but the fields are summed correctly
      input_tokens: 30, output_tokens: 11, cache_read_tokens: 4, cache_write_tokens: 6, num_turns: 3,
    });
  });
});
