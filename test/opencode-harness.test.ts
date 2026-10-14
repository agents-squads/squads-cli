import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseOpencodeJson, parseOpencodeLine } from '../src/lib/stream-json.js';
import { parseOpencodeUsage } from '../src/lib/llm-clis.js';
import {
  createOpencodeStreamJsonAdapter,
  normalizeDetachedLog,
  execEventsFile,
  type ExecEvent,
  type PersistedExecEvent,
} from '../src/lib/exec-events.js';

// ── Fixture lines (real `opencode run --format json` v1.18.3 shapes,
//    captured live 2026-07-19 — see cli#1177) ─────────────────────────────

const oc = (type: string, part: Record<string, unknown>) =>
  JSON.stringify({ type, timestamp: 1784487629681, sessionID: 'ses_fixture', part });

const stepStart = () => oc('step_start', { id: 'prt_1', type: 'step-start' });

const toolUse = (tool: string, input: Record<string, unknown>, output = '(no output)', status = 'completed') =>
  oc('tool_use', {
    type: 'tool',
    tool,
    callID: `call_${tool}`,
    state: { status, input, output, title: 't', time: { start: 1, end: 2 } },
  });

const stepFinish = (reason: string, tokens: Record<string, unknown>, cost: number) =>
  oc('step_finish', { id: 'prt_f', reason, type: 'step-finish', tokens, cost });

const textLine = (text: string) => oc('text', { id: 'prt_t', type: 'text', text });

const errorLine = () =>
  JSON.stringify({ type: 'error', timestamp: 1, sessionID: 'ses_fixture', error: { name: 'APIError', data: { message: 'Invalid API key.' } } });

const FIXTURE = [
  stepStart(),
  toolUse('bash', { command: 'echo hello > probe.txt' }),
  stepFinish('tool-calls', { total: 13508, input: 13373, output: 104, reasoning: 31, cache: { write: 0, read: 0 } }, 0.00191002),
  stepStart(),
  toolUse('read', { filePath: '/w/probe.txt' }, '<content>hello</content>'),
  stepFinish('tool-calls', { total: 13634, input: 82, output: 102, reasoning: 10, cache: { write: 0, read: 13440 } }, 0.000080472),
  stepStart(),
  textLine('`probe.txt` contains: hello'),
  stepFinish('stop', { total: 13760, input: 167, output: 9, reasoning: 16, cache: { write: 0, read: 13568 } }, 0.0000683704),
].join('\n');

describe('parseOpencodeLine', () => {
  it('parses an event line and ignores non-JSON noise', () => {
    expect(parseOpencodeLine(stepStart())?.type).toBe('step_start');
    expect(parseOpencodeLine('some stderr warning')).toBeNull();
    expect(parseOpencodeLine('')).toBeNull();
  });
});

describe('parseOpencodeJson', () => {
  it('accumulates usage, cost, outcomes, and text with a terminal stop', () => {
    const r = parseOpencodeJson(FIXTURE);
    expect(r.sawResult).toBe(true);
    expect(r.isError).toBe(false);
    expect(r.text).toBe('`probe.txt` contains: hello');
    expect(r.outcomes.actions).toBe(2);
    expect(r.outcomes.files_edited).toBe(0);
    expect(r.usage.input_tokens).toBe(13373 + 82 + 167);
    // reasoning tokens fold into output
    expect(r.usage.output_tokens).toBe(104 + 31 + 102 + 10 + 9 + 16);
    expect(r.usage.cache_read_tokens).toBe(13440 + 13568);
    expect(r.usage.cost_usd).toBeCloseTo(0.00191002 + 0.000080472 + 0.0000683704, 10);
    expect(r.usage.num_turns).toBe(1);
    expect(r.openBackgroundSubagents).toBe(0);
  });

  it('a stream without a stop step is not a result; an error event marks isError', () => {
    const r = parseOpencodeJson([stepStart(), errorLine()].join('\n'));
    expect(r.sawResult).toBe(false);
    expect(r.isError).toBe(true);
  });

  it('counts verified artifacts from the tool result, never the command text (cli#1134)', () => {
    const verified = parseOpencodeJson(toolUse(
      'bash',
      { command: 'gh pr create -t x' },
      'https://github.com/o/r/pull/42',
    ));
    expect(verified.outcomes.prs_created).toBe(1);

    const mention = parseOpencodeJson(toolUse('bash', { command: 'echo gh pr create' }, 'gh pr create'));
    expect(mention.outcomes.prs_created).toBe(0);

    const failed = parseOpencodeJson(toolUse('bash', { command: 'gh pr create -t x' }, 'error: auth', 'error'));
    expect(failed.outcomes.prs_created).toBe(0);
  });

  it('counts write/edit as files_edited', () => {
    const r = parseOpencodeJson(toolUse('write', { filePath: '/w/a.ts', content: 'x' }));
    expect(r.outcomes.files_edited).toBe(1);
  });
});

describe('parseOpencodeUsage', () => {
  it('trusts opencode real provider-priced cost', () => {
    const u = parseOpencodeUsage(FIXTURE);
    expect(u).not.toBeNull();
    expect(u!.input_tokens).toBe(13373 + 82 + 167);
    expect(u!.cost_usd).toBeGreaterThan(0);
  });

  it('returns null for a non-opencode log', () => {
    expect(parseOpencodeUsage('plain text log')).toBeNull();
  });
});

describe('createOpencodeStreamJsonAdapter', () => {
  const collect = (lines: string[]): ExecEvent[] => {
    const adapter = createOpencodeStreamJsonAdapter();
    return lines.flatMap((l) => adapter.parseLine(l));
  };

  it('emits tool_call + tool_result from one resolved tool_use event', () => {
    const events = collect([toolUse('read', { filePath: '/w/probe.txt' }, 'hello')]);
    expect(events.map((e) => e.type)).toEqual(['tool_call', 'file_read', 'tool_result']);
    const call = events[0] as Extract<ExecEvent, { type: 'tool_call' }>;
    expect(call.tool).toBe('read');
    expect(call.inputSummary).toBe('/w/probe.txt');
    const result = events[2] as Extract<ExecEvent, { type: 'tool_result' }>;
    expect(result.ok).toBe(true);
  });

  it('mines pr artifact URLs from the resolved bash output', () => {
    const events = collect([toolUse('bash', { command: 'gh pr create -t x' }, 'https://github.com/o/r/pull/7')]);
    const artifact = events.find((e) => e.type === 'artifact') as Extract<ExecEvent, { type: 'artifact' }>;
    expect(artifact).toBeDefined();
    expect(artifact.kind).toBe('pr');
    expect(artifact.ref).toBe('https://github.com/o/r/pull/7');
  });

  it('emits one cumulative token_usage at the terminal stop', () => {
    const events = collect(FIXTURE.split('\n'));
    const usage = events.filter((e) => e.type === 'token_usage') as Extract<ExecEvent, { type: 'token_usage' }>[];
    expect(usage).toHaveLength(1);
    expect(usage[0].input).toBe(13373 + 82 + 167);
    expect(usage[0].costEst).toBeCloseTo(0.00205886, 6);
  });

  it('flags an errored tool state on tool_result', () => {
    const events = collect([toolUse('bash', { command: 'false' }, 'boom', 'error')]);
    const result = events.find((e) => e.type === 'tool_result') as Extract<ExecEvent, { type: 'tool_result' }>;
    expect(result.ok).toBe(false);
  });
});

describe('normalizeDetachedLog with harness=opencode', () => {
  it('normalizes an opencode log through the opencode adapter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-norm-'));
    try {
      const written = normalizeDetachedLog(FIXTURE, dir, 'exec-oc-1', 'agent-x', undefined, 'deepseek', 'opencode');
      expect(written).toBeGreaterThan(0);
      const lines = readFileSync(execEventsFile(dir, 'exec-oc-1'), 'utf8')
        .split('\n').filter(Boolean)
        .map((l) => JSON.parse(l) as PersistedExecEvent);
      expect(lines.some((l) => l.event.type === 'tool_call')).toBe(true);
      expect(lines.some((l) => l.event.type === 'token_usage')).toBe(true);
      expect(lines.every((l) => l.provider === 'deepseek')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('yields zero events for an opencode log run through the claude adapter (why harness matters)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-norm-'));
    try {
      const written = normalizeDetachedLog(FIXTURE, dir, 'exec-oc-2', 'agent-x', undefined, 'deepseek');
      expect(written).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
