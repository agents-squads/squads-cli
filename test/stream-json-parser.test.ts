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
  extractPrNumbers,
  extractIssueNumbers,
  extractCommitShas,
  toolResultText,
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

  it('counts INVOCATIONS (actions/files) from tool_use blocks, but NOT artifacts (cli#1134)', () => {
    // The command text alone creates nothing — commits/PRs/issues stay 0 until
    // a verified tool_result arrives. The Bash create commands are flagged as
    // candidates instead, to be resolved against their paired result.
    const parsed = parseStreamJsonLine(
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: "git commit -m 'x'" } },
        { type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'gh pr create --base develop' } },
        { type: 'tool_use', id: 'toolu_i', name: 'Bash', input: { command: 'gh issue create --title y' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: '/a' } },
        { type: 'text', text: 'done' },
      ] } })
    );
    expect(parsed.outcomes).toEqual({ actions: 4, files_edited: 1, commits: 0, prs_created: 0, issues_created: 0 });
    expect(parsed.bashCandidates).toEqual([
      { id: 'toolu_c', kinds: ['commit'] },
      { id: 'toolu_p', kinds: ['pr'] },
      { id: 'toolu_i', kinds: ['issue'] },
    ]);
    expect(parsed.text).toBe('done');
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

describe('open background subagents (#1130)', () => {
  it('flags an Agent tool_use with no matching tool_result by stream end', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'explore', run_in_background: true } },
      ] } }),
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'text', text: "I'll pause here until it completes." },
      ] } }),
      JSON.stringify({ type: 'result', result: "I'll pause here until it completes.", is_error: false, total_cost_usd: 0.01, usage: {} }),
    ].join('\n');
    const out = parseStreamJson(jsonl);
    expect(out.sawResult).toBe(true);
    expect(out.isError).toBe(false);
    expect(out.openBackgroundSubagents).toBe(1);
  });

  it('does NOT flag a subagent whose tool_result arrived before the stream ended', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Agent', input: { description: 'explore' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'exploration done' },
      ] } }),
      JSON.stringify({ type: 'result', result: 'done', is_error: false, total_cost_usd: 0.01, usage: {} }),
    ].join('\n');
    const out = parseStreamJson(jsonl);
    expect(out.openBackgroundSubagents).toBe(0);
  });

  it('ignores non-subagent tools (e.g. Bash) when counting open subagents', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
      ] } }),
      JSON.stringify({ type: 'result', result: 'done', is_error: false, total_cost_usd: 0.01, usage: {} }),
    ].join('\n');
    const out = parseStreamJson(jsonl);
    expect(out.openBackgroundSubagents).toBe(0);
  });

  it('is 0 by default (no tool_use blocks at all)', () => {
    const out = parseStreamJson(JSON.stringify({ type: 'result', result: 'ok', is_error: false, total_cost_usd: 0, usage: {} }));
    expect(out.openBackgroundSubagents).toBe(0);
  });
});

describe('result-derived outcomes — cli#1134', () => {
  // A PR-creating turn: assistant runs `gh pr create`, the next `user` event
  // carries the tool_result with the new PR URL. Only that verified URL counts.
  const prTurn = (resultContent: unknown, isError = false) => [
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'gh pr create --base develop' } },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_p', is_error: isError, content: resultContent },
    ] } }),
    JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.1, usage: {}, is_error: false }),
  ].join('\n');

  it('counts a PR from a verified /pull/N URL in the tool_result', () => {
    const out = parseStreamJson(prTurn('https://github.com/agents-squads/squads-cli/pull/1134'));
    expect(out.outcomes.prs_created).toBe(1);
    expect(out.outcomes.commits).toBe(0);
    expect(out.outcomes.issues_created).toBe(0);
  });

  it('counts an issue from a verified /issues/N URL in the tool_result', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_i', name: 'Bash', input: { command: 'gh issue create --title x' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_i', content: 'https://github.com/o/r/issues/42' },
      ] } }),
      JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.1, usage: {}, is_error: false }),
    ].join('\n');
    expect(parseStreamJson(jsonl).outcomes.issues_created).toBe(1);
  });

  it('counts a commit from a `[branch sha]` line in the tool_result', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'git commit -m fix' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_c', content: '[main abc1234] fix\n 1 file changed' },
      ] } }),
      JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.1, usage: {}, is_error: false }),
    ].join('\n');
    expect(parseStreamJson(jsonl).outcomes.commits).toBe(1);
  });

  it('counts a mention with no verified URL as ZERO (the cli#1134 bug)', () => {
    // The agent grepped for the literal "gh pr create" string. Old code counted
    // the command; the result has no /pull/N URL, so it must count 0.
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_g', name: 'Bash', input: { command: 'grep -rn "gh pr create" src/' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_g', content: 'src/x.ts:  if (/gh pr create/.test(cmd))' },
      ] } }),
      JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.1, usage: {}, is_error: false }),
    ].join('\n');
    expect(parseStreamJson(jsonl).outcomes.prs_created).toBe(0);
  });

  it('counts ZERO when the create command FAILED (is_error result)', () => {
    // gh pr create errored (e.g. no changes to push). The result carries an
    // error and no URL — nothing was created.
    const out = parseStreamJson(prTurn('Warning: no commits resolved; exiting', true));
    expect(out.outcomes.prs_created).toBe(0);
  });

  it('counts ZERO when the candidate never got a tool_result (stream ended)', () => {
    // Command ran but we never saw its result — don't claim a creation.
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'gh pr create' } },
      ] } }),
      JSON.stringify({ type: 'result', result: 'cut off', total_cost_usd: 0.1, usage: {}, is_error: false }),
    ].join('\n');
    expect(parseStreamJson(jsonl).outcomes.prs_created).toBe(0);
  });

  it('counts every artifact when one Bash call creates several (a loop)', () => {
    // A loop creating 2 PRs in one tool_result → findall counts both.
    const out = parseStreamJson(prTurn(
      'https://github.com/o/r/pull/11\nhttps://github.com/o/r/pull/12',
    ));
    expect(out.outcomes.prs_created).toBe(2);
  });

  it('still counts actions/files from tool_use while artifacts come from results', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_e', name: 'Edit', input: { file_path: '/a' } },
        { type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'gh pr create' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_e', content: 'ok' },
        { type: 'tool_result', tool_use_id: 'toolu_p', content: 'https://github.com/o/r/pull/9' },
      ] } }),
      JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.1, usage: {}, is_error: false }),
    ].join('\n');
    const o = parseStreamJson(jsonl).outcomes;
    expect(o.actions).toBe(2);       // both tool_use calls
    expect(o.files_edited).toBe(1);  // the Edit
    expect(o.prs_created).toBe(1);   // verified from result
  });

  it('parses tool_result content that is a list of text blocks', () => {
    // Claude Code sometimes sends content as [{type:'text', text:'…'}, …].
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'gh pr create' } },
      ] } }),
      JSON.stringify({ type: 'user', message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_p', content: [
          { type: 'text', text: 'Creating PR…' },
          { type: 'text', text: 'https://github.com/o/r/pull/77' },
        ] },
      ] } }),
      JSON.stringify({ type: 'result', result: 'ok', total_cost_usd: 0.1, usage: {}, is_error: false }),
    ].join('\n');
    expect(parseStreamJson(jsonl).outcomes.prs_created).toBe(1);
  });
});

describe('result-extraction helpers (cli#1134)', () => {
  it('extractPrNumbers pulls every /pull/N', () => {
    expect(extractPrNumbers('see https://x/y/pull/1 and /pull/22 ok')).toEqual([1, 22]);
    expect(extractPrNumbers('no match here')).toEqual([]);
  });

  it('extractIssueNumbers pulls every /issues/N', () => {
    expect(extractIssueNumbers('https://x/y/issues/5 done')).toEqual([5]);
  });

  it('extractCommitShas pulls the sha out of `[branch sha]`', () => {
    expect(extractCommitShas('[main abc1234] msg')).toEqual(['abc1234']);
    expect(extractCommitShas('[feature/x 0123456789abcdef0123456789abcdef01234567] m')).toEqual(['0123456789abcdef0123456789abcdef01234567']);
    expect(extractCommitShas('no bracket line')).toEqual([]);
  });

  it('toolResultText normalizes string and block-list content', () => {
    expect(toolResultText('plain string')).toBe('plain string');
    expect(toolResultText([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ])).toBe('a\nb');
    expect(toolResultText(undefined)).toBe('');
    expect(toolResultText([{ type: 'image', src: 'x' }])).toBe('');
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

describe('model backfill for non-Claude harness runs (cli#1175)', () => {
  it('backfills model from assistant events when the result event omits it', () => {
    // glm/deepseek via `claude --model glm-4.7`: the terminal result reports
    // model only via modelUsage (no top-level `model`), so the result usage's
    // model is empty — it must come from the assistant events' message.model.
    const log = [
      JSON.stringify({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'a1', name: 'Read', input: { file_path: '/x' } },
      ], model: 'glm-4.7', usage: { input_tokens: 100, output_tokens: 20 } } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
        total_cost_usd: 0.42, usage: { input_tokens: 100, output_tokens: 20 },
        modelUsage: { 'glm-4.7': { costUSD: 0.42 } } }),
    ].join('\n');
    const r = parseStreamJson(log);
    expect(r.sawResult).toBe(true);
    expect(r.usage.model).toBe('glm-4.7');      // backfilled (was '')
    expect(r.usage.cost_usd).toBe(0.42);
  });

  it('does not override a model the result event already carries (Claude)', () => {
    const log = [
      JSON.stringify({ type: 'assistant', message: { content: [], model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 2 } } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, model: 'claude-sonnet-5', total_cost_usd: 0.1, usage: { input_tokens: 10, output_tokens: 2 } }),
    ].join('\n');
    expect(parseStreamJson(log).usage.model).toBe('claude-sonnet-5');
  });
});
