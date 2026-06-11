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

  it('ignores non-text content blocks (tool_use) for TEXT', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })
    );
    expect(parsed.text).toBeUndefined();
  });

  it('counts outcomes from tool_use blocks (commits, PRs, issues, files, actions)', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: "git commit -m 'x'" } },
        { type: 'tool_use', name: 'Bash', input: { command: 'gh pr create --base develop' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'gh issue create --title y' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/a' } },
        { type: 'text', text: 'done' },
      ] } })
    );
    expect(parsed.outcomes).toEqual({ actions: 4, files_edited: 1, commits: 1, prs_created: 1, issues_created: 1 });
    expect(parsed.text).toBe('done');
  });

  it('accumulates outcomes across a full stream via parseStreamJson', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git commit -m a' } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr create' } }] } }),
      JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.1, usage: {}, is_error: false }),
    ].join('\n');
    const res = parseStreamJson(jsonl);
    expect(res.outcomes.commits).toBe(1);
    expect(res.outcomes.prs_created).toBe(1);
    expect(res.outcomes.actions).toBe(2);
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
      model: '', // no `model` on this result event
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

describe('assistant-event usage (cut-off fallback)', () => {
  it('parses message.usage + model off an assistant event', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-opus-4-8',
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 2000, cache_creation_input_tokens: 30 },
          content: [{ type: 'text', text: 'thinking…' }],
        },
      })
    );
    expect(parsed.text).toBe('thinking…');
    expect(parsed.assistantUsage).toBeDefined();
    expect(parsed.assistantUsage!.input_tokens).toBe(100);
    expect(parsed.assistantUsage!.output_tokens).toBe(50);
    expect(parsed.assistantUsage!.cache_read_tokens).toBe(2000);
    expect(parsed.assistantUsage!.cache_write_tokens).toBe(30);
    expect(parsed.assistantUsage!.cost_usd).toBe(0); // assistant events carry no cost
    expect(parsed.assistantUsage!.model).toBe('claude-opus-4-8');
  });

  it('returns no assistantUsage when an assistant event has no usage numbers', () => {
    const parsed = parseStreamJsonLine(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } })
    );
    expect(parsed.assistantUsage).toBeUndefined();
  });

  it('CUT-OFF: assistant events but NO result event → summed tokens (non-zero), no cost', () => {
    // Simulates an agent killed mid-tool-call (timeout / turn limit): assistant
    // events stream usage, but the terminal `result` event never arrives.
    const cutOff = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'z' }),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 }, content: [{ type: 'text', text: 'step 1' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1200, output_tokens: 350, cache_read_input_tokens: 6000, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', name: 'Bash' }] },
      }),
      // …process killed here. No result event.
    ].join('\n');

    const out = parseStreamJson(cutOff);
    expect(out.sawResult).toBe(false);
    // Summed across both assistant events.
    expect(out.usage.input_tokens).toBe(2200);
    expect(out.usage.output_tokens).toBe(550);
    expect(out.usage.cache_read_tokens).toBe(11000);
    expect(out.usage.cache_write_tokens).toBe(100);
    expect(out.usage.cost_usd).toBe(0); // cost is derived downstream from tokens
    expect(out.usage.model).toBe('claude-opus-4-8');
    // The point of the fix: tokens are non-zero so the record is not a 0.
    const totalTokens = out.usage.input_tokens + out.usage.output_tokens + out.usage.cache_read_tokens + out.usage.cache_write_tokens;
    expect(totalTokens).toBeGreaterThan(0);
  });

  it('result event WINS over summed assistant tokens when present (canonical aggregate)', () => {
    const withResult = [
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 200 }, content: [{ type: 'text', text: 'x' }] } }),
      JSON.stringify({ type: 'result', result: 'done', total_cost_usd: 0.9, usage: { input_tokens: 1500, output_tokens: 320, cache_read_input_tokens: 8000, cache_creation_input_tokens: 200 }, num_turns: 4, is_error: false }),
    ].join('\n');
    const out = parseStreamJson(withResult);
    expect(out.sawResult).toBe(true);
    // Uses the result event's aggregate (1500/320), NOT the assistant sum (1000/200).
    expect(out.usage.input_tokens).toBe(1500);
    expect(out.usage.output_tokens).toBe(320);
    expect(out.usage.cost_usd).toBeCloseTo(0.9, 4);
  });
});

describe('usage helpers', () => {
  it('emptyUsage is all zeros', () => {
    expect(emptyUsage()).toEqual({
      cost_usd: 0, input_tokens: 0, output_tokens: 0,
      cache_read_tokens: 0, cache_write_tokens: 0, num_turns: 0, model: '',
    });
  });

  it('addUsage sums field-by-field (for multi-agent conversation totals)', () => {
    const a = { cost_usd: 0.1, input_tokens: 10, output_tokens: 5, cache_read_tokens: 1, cache_write_tokens: 2, num_turns: 1, model: 'claude-opus-4-8' };
    const b = { cost_usd: 0.2, input_tokens: 20, output_tokens: 6, cache_read_tokens: 3, cache_write_tokens: 4, num_turns: 2, model: '' };
    expect(addUsage(a, b)).toEqual({
      cost_usd: 0.30000000000000004, // float, but the fields are summed correctly
      input_tokens: 30, output_tokens: 11, cache_read_tokens: 4, cache_write_tokens: 6, num_turns: 3,
      model: 'claude-opus-4-8', // first known model id is kept
    });
  });
});
