import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createClaudeStreamJsonAdapter,
  createOpencodeStreamJsonAdapter,
  ExecEventWriter,
  runStartFields,
  runTitle,
  taskIssueRef,
  execEventsFile,
  normalizeDetachedLog,
  type ExecEvent,
  type PersistedExecEvent,
} from '../src/lib/exec-events.js';
import { renderEvent } from '../src/lib/event-render.js';
import { parseOpencodeJson } from '../src/lib/stream-json.js';

// ── Fixture lines (real claude --output-format stream-json shapes) ─────────

const assistantLine = (blocks: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { content: blocks, model: 'claude-sonnet-5' } });

const toolUse = (id: string, name: string, input: Record<string, unknown>) =>
  ({ type: 'tool_use', id, name, input });

const userToolResult = (toolUseId: string, content: unknown, isError = false) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] } });

const resultLine = JSON.stringify({
  type: 'result', subtype: 'success', result: 'done', is_error: false,
  total_cost_usd: 0.42, num_turns: 3, model: 'claude-sonnet-5',
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 },
});

function readEvents(file: string): PersistedExecEvent[] {
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PersistedExecEvent);
}

// ── claudeStreamJsonAdapter ────────────────────────────────────────────────

describe('claudeStreamJsonAdapter', () => {
  it('normalizes tool_use blocks into tool_call + specializations', () => {
    const adapter = createClaudeStreamJsonAdapter();
    const events = adapter.parseLine(assistantLine([
      toolUse('t1', 'Read', { file_path: '/repo/src/a.ts' }),
      toolUse('t2', 'Write', { file_path: '/repo/src/b.ts', content: 'xyz' }),
      toolUse('t3', 'WebSearch', { query: 'duckdb upsert' }),
    ]));

    expect(events.map((e) => e.type)).toEqual([
      'tool_call', 'file_read',
      'tool_call', 'file_write',
      'tool_call', 'web_fetch',
    ]);
    expect(events[1]).toMatchObject({ type: 'file_read', path: '/repo/src/a.ts' });
    expect(events[3]).toMatchObject({ type: 'file_write', path: '/repo/src/b.ts', bytes: 3 });
    expect(events[5]).toMatchObject({ type: 'web_fetch', url: 'duckdb upsert' });
    expect(events[0]).toMatchObject({ type: 'tool_call', tool: 'Read', inputSummary: '/repo/src/a.ts' });
  });

  it('derives artifact events from git/gh Bash commands', () => {
    const adapter = createClaudeStreamJsonAdapter();
    const events = adapter.parseLine(assistantLine([
      toolUse('t1', 'Bash', { command: 'git add -A && git commit -m "feat: x"' }),
      toolUse('t2', 'Bash', { command: 'gh pr create --base develop' }),
      toolUse('t3', 'Bash', { command: 'gh issue create --title bug' }),
      toolUse('t4', 'Bash', { command: 'ls -la' }),
    ]));

    const artifacts = events.filter((e): e is Extract<ExecEvent, { type: 'artifact' }> => e.type === 'artifact');
    expect(artifacts.map((a) => a.kind)).toEqual(['commit', 'pr', 'issue']);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(4);
  });

  it('correlates tool_result back to the tool name and detects failures', () => {
    const adapter = createClaudeStreamJsonAdapter();
    adapter.parseLine(assistantLine([toolUse('t9', 'Bash', { command: 'npm test' })]));
    const events = adapter.parseLine(userToolResult('t9', 'FAIL: 1 test failed', true));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'tool_result', tool: 'Bash', ok: false });
    expect((events[0] as Extract<ExecEvent, { type: 'tool_result' }>).summary).toContain('FAIL');
  });

  it('maps Agent tool_use to subagent_spawn and its result to subagent_done', () => {
    const adapter = createClaudeStreamJsonAdapter();
    const spawn = adapter.parseLine(assistantLine([
      toolUse('a1', 'Agent', { description: 'research the schema', prompt: 'long prompt…' }),
    ]));
    expect(spawn.map((e) => e.type)).toEqual(['tool_call', 'subagent_spawn']);
    expect(spawn[1]).toMatchObject({ type: 'subagent_spawn', childRunId: 'a1', task: 'research the schema' });

    const done = adapter.parseLine(userToolResult('a1', [{ type: 'text', text: 'findings…' }]));
    expect(done.map((e) => e.type)).toEqual(['tool_result', 'subagent_done']);
    expect(done[1]).toMatchObject({ type: 'subagent_done', childRunId: 'a1', ok: true });
  });

  it('turns the terminal result event into token_usage', () => {
    const adapter = createClaudeStreamJsonAdapter();
    const events = adapter.parseLine(resultLine);
    expect(events).toEqual([{
      type: 'token_usage', input: 100, output: 50, cacheRead: 1000, cacheWrite: 200,
      costEst: 0.42, model: 'claude-sonnet-5',
    }]);
  });

  it('ignores non-JSON, empty, and uninteresting lines', () => {
    const adapter = createClaudeStreamJsonAdapter();
    expect(adapter.parseLine('')).toEqual([]);
    expect(adapter.parseLine('warning: something')).toEqual([]);
    expect(adapter.parseLine(JSON.stringify({ type: 'system', subtype: 'init' }))).toEqual([]);
    // assistant text is a `message` event (#1275)
    expect(adapter.parseLine(assistantLine([{ type: 'text', text: 'thinking…' }]))).toEqual([{ type: 'message', role: 'assistant', text: 'thinking…' }]);
  });
});

describe('#1275 part 2 — message, running usage, run titles', () => {
  const line = (id: string, content: object[], usage?: object) =>
    JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', content, ...(usage ? { usage } : {}) } });

  it('claude: text → message; usage → usage_running summed per API message, repeats not double-counted; token_usage stays terminal', () => {
    const a = createClaudeStreamJsonAdapter();
    const u1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };
    expect(a.parseLine(line('m1', [{ type: 'text', text: 'Looking at it.' }], u1))).toEqual([
      { type: 'message', role: 'assistant', text: 'Looking at it.' },
      { type: 'usage_running', input: 10, output: 5, cacheRead: 100, cacheWrite: 0, costEst: 0, model: 'claude-opus-5-5' },
    ]);
    // the same message again (one line per content block): no new usage event
    expect(a.parseLine(line('m1', [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }], u1)).map((e) => e.type)).toEqual(['tool_call']);
    const r = a.parseLine(line('m2', [{ type: 'text', text: 'Done.' }], { input_tokens: 20, output_tokens: 7 }));
    expect(r.at(-1)).toMatchObject({ type: 'usage_running', input: 30, output: 12, cacheRead: 100 });
    expect(a.parseLine(JSON.stringify({ type: 'result', usage: { input_tokens: 30, output_tokens: 12 } }))).toEqual([
      expect.objectContaining({ type: 'token_usage', input: 30, output: 12 }),
    ]);
  });

  it('review fixes: no message id → no running usage; option-like repos refused; titles and renders carry no escapes; writer throttles running usage', () => {
    const a = createClaudeStreamJsonAdapter();
    const noId = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10 } } });
    expect(a.parseLine(noId).map((e) => e.type)).toEqual(['message']);
    expect(a.parseLine(noId).map((e) => e.type)).toEqual(['message']);
    expect(taskIssueRef('Work -x/--y#1')).toBeUndefined();
    expect(taskIssueRef('Work ../b#2')).toBeUndefined();
    expect(runTitle('evil \x1b]52;c;ZXZpbA==\x07 title')).not.toMatch(/\x1b|\x07/);
    expect(renderEvent({ type: 'message', role: 'assistant', text: 'hi \x1b[2J\x1b]0;pwn\x07 there' })).not.toMatch(/\x1b\[2J|\x1b\]0/);
    const file = join(mkdtempSync(join(tmpdir(), 'thr-')), 'e.jsonl');
    const w = new ExecEventWriter(file, 'run_t');
    for (let i = 0; i < 5; i++) w.emit({ type: 'usage_running', input: i, output: 0, cacheRead: 0, cacheWrite: 0, costEst: 0, model: '' });
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('opencode: text parts → message; each step → usage_running, the last also token_usage', () => {
    const a = createOpencodeStreamJsonAdapter();
    expect(a.parseLine(JSON.stringify({ type: 'text', part: { text: 'Fixing the test.' } }))).toEqual([{ type: 'message', role: 'assistant', text: 'Fixing the test.' }]);
    expect(a.parseLine(JSON.stringify({ type: 'step_finish', part: { reason: 'tool-calls', tokens: { input: 5, output: 2 } } })).map((e) => e.type)).toEqual(['usage_running']);
    expect(a.parseLine(JSON.stringify({ type: 'step_finish', part: { reason: 'stop', tokens: { input: 5, output: 2 } } })).map((e) => e.type)).toEqual(['usage_running', 'token_usage']);
  });

  it('run_start title: the task\'s first line, or the referenced issue\'s title; lookup failures fall back', () => {
    expect(runTitle('## Fix the flaky test\nmore detail')).toBe('Fix the flaky test');
    expect(runTitle('x'.repeat(150))).toHaveLength(100);
    expect(runTitle('   \n  ')).toBeUndefined();
    expect(taskIssueRef('Work agents-squads/squads-cli#1300')).toEqual({ repo: 'agents-squads/squads-cli', n: 1300 });
    expect(taskIssueRef('Work agents-squads/squads-cli#1300 and also #1')).toBeUndefined();
    expect(runStartFields('Work a/b#7', () => 'domains: --since window')).toEqual({ title: 'domains: --since window (a/b#7)', task: 'Work a/b#7' });
    expect(runStartFields('Work a/b#7', () => { throw new Error('no gh'); })).toEqual({ title: 'Work a/b#7', task: 'Work a/b#7' });
    expect(runStartFields(undefined)).toEqual({});
  });

  it('the file and the API copy keep message, reasoning and task text whole (#1316)', () => {
    // A real flusher holding its batch (big batch, long interval): what it would send is in its buffer.
    const flusher = new ExecEventFlusher('run_m', 1000, 60_000);
    const pushed = () => (flusher as unknown as { buf: PersistedExecEvent[] }).buf;
    const file = join(mkdtempSync(join(tmpdir(), 'msg-')), 'e.jsonl');
    const w = new ExecEventWriter(file, 'run_m', { flusher });
    const long = 'word '.repeat(1000);
    w.emit({ type: 'run_start', squad: 's', mode: 'foreground', model: 'm', role: '', startedAt: 'now', task: long });
    w.emit({ type: 'message', role: 'assistant', text: long });
    w.emit({ type: 'reasoning', text: long, step: 2 });
    const written = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PersistedExecEvent);
    expect(written.map((l) => l.sensitivity)).toEqual(['moderate', 'moderate', 'moderate']);
    expect(pushed()).toEqual(written);
    expect((pushed()[0]!.event as { task: string }).task).toBe(long);
    expect((pushed()[1]!.event as { text: string }).text).toBe(long);
    expect(pushed()[2]!.event).toEqual({ type: 'reasoning', text: long, step: 2 });
  });

  it('a credential inside reasoning is redacted at write time and marks the event high', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'rsn-')), 'e.jsonl');
    const w = new ExecEventWriter(file, 'run_r');
    const token = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    w.emit({ type: 'reasoning', text: `The env has GH_TOKEN=${token}, use it to push.` });
    const line = readFileSync(file, 'utf8');
    expect(line).not.toContain(token);
    expect(JSON.parse(line).sensitivity).toBe('high');
  });

  it('opencode --thinking: reasoning parts → reasoning; the run output stays the text only', () => {
    const log = readFileSync(join(__dirname, 'fixtures', 'opencode', 'thinking-run.jsonl'), 'utf8');
    const a = createOpencodeStreamJsonAdapter();
    const events = log.split('\n').flatMap((l) => a.parseLine(l));
    expect(events.map((e) => e.type)).toEqual(['reasoning', 'message', 'usage_running', 'token_usage']);
    expect((events[0] as { text: string }).text).toMatch(/391/);
    expect(parseOpencodeJson(log).text).toBe((events[1] as { text: string }).text);
  });

  it('claude: a thinking block with text → reasoning; the empty ones claude -p sends today → nothing', () => {
    const a = createClaudeStreamJsonAdapter();
    expect(a.parseLine(assistantLine([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: '40' }])))
      .toEqual([{ type: 'message', role: 'assistant', text: '40' }]);
    expect(a.parseLine(assistantLine([{ type: 'thinking', thinking: 'n=40 gives 41*41.' }])))
      .toEqual([{ type: 'reasoning', text: 'n=40 gives 41*41.' }]);
    expect(renderEvent({ type: 'reasoning', text: 'first line\nsecond' })).toContain('∴ first line');
  });
});

// ── ExecEventWriter ────────────────────────────────────────────────────────

describe('ExecEventWriter', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'squads-events-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const runStart: ExecEvent = { type: 'run_start', squad: 'eng', agent: 'builder', mode: 'conversation', model: 'sonnet', role: 'worker', startedAt: '2026-07-01T00:00:00Z' };

  it('persists enveloped JSONL lines with runId, seq, and agent attribution', () => {
    const file = execEventsFile(root, 'exec_abc123');
    const writer = new ExecEventWriter(file, 'exec_abc123');
    writer.emit(runStart);
    writer.emit({ type: 'tool_call', tool: 'Read', inputSummary: 'a.ts' }, 'builder');
    writer.close();

    const lines = readEvents(file);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ v: 1, runId: 'exec_abc123', seq: 0, event: { type: 'run_start' } });
    expect(lines[1]).toMatchObject({ seq: 1, agent: 'builder', event: { type: 'tool_call', tool: 'Read' } });
    expect(typeof lines[0].ts).toBe('string');
  });

  it('caps detail events and records an explicit truncated marker — never a silent cap', () => {
    const file = execEventsFile(root, 'exec_cap');
    const writer = new ExecEventWriter(file, 'exec_cap', { maxEvents: 3 });
    writer.emit(runStart);
    for (let i = 0; i < 10; i++) writer.emit({ type: 'tool_call', tool: 'Bash', inputSummary: `cmd ${i}` });
    // Terminal events bypass the cap: the aggregate must always land.
    writer.emit({ type: 'token_usage', input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costEst: 0, model: 'sonnet' });
    writer.close();

    const lines = readEvents(file);
    const types = lines.map((l) => l.event.type);
    expect(types.filter((t) => t === 'tool_call')).toHaveLength(2); // seq 1,2 then capped
    expect(types).toContain('token_usage');
    expect(types[types.length - 1]).toBe('truncated');
    const truncated = lines[lines.length - 1].event as Extract<ExecEvent, { type: 'truncated' }>;
    expect(truncated.droppedCount).toBe(8);
  });

  it('never throws when the target path is unwritable', () => {
    // A path whose ancestor is a FILE (mkdir fails with ENOTDIR) — the writer
    // must go dead silently: persistence never takes down the run it observes.
    const bogus = join(root, 'not-a-dir');
    writeFileSync(bogus, 'i am a file');
    const writer = new ExecEventWriter(join(bogus, 'x', 'events.jsonl'), 'exec_dead');
    expect(() => {
      writer.emit(runStart);
      writer.close();
    }).not.toThrow();
    expect(writer.writtenCount).toBe(0);
  });
});

// ── normalizeDetachedLog ───────────────────────────────────────────────────

describe('normalizeDetachedLog', () => {
  let root: string;

  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'squads-events-norm-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const runEnd: Extract<ExecEvent, { type: 'run_end' }> = {
    type: 'run_end', ok: true, durationMs: 1234,
    totalUsage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 200, costEst: 0.42 },
    outcomes: { actions: 2, files_edited: 1, commits: 1, prs_created: 0, issues_created: 0 },
  };

  it('normalizes a raw stream-json log into the events file and closes with run_end', () => {
    const rawLog = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      assistantLine([toolUse('t1', 'Bash', { command: 'git commit -m x' })]),
      resultLine,
    ].join('\n');

    const written = normalizeDetachedLog(rawLog, root, 'exec_detached1', 'profiler', runEnd);
    expect(written).toBeGreaterThan(0);

    const lines = readEvents(execEventsFile(root, 'exec_detached1'));
    const types = lines.map((l) => l.event.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('artifact');
    expect(types).toContain('token_usage');
    expect(types[types.length - 1]).toBe('run_end');
    expect(lines.every((l) => l.runId === 'exec_detached1')).toBe(true);
    expect(lines.find((l) => l.event.type === 'tool_call')?.agent).toBe('profiler');
  });

  it('yields zero events for a legacy plain-text log and fabricates nothing', () => {
    const written = normalizeDetachedLog('plain claude output\nno json here', root, 'exec_legacy', 'agent', runEnd);
    expect(written).toBe(0);
    expect(existsSync(execEventsFile(root, 'exec_legacy'))).toBe(false);
  });
});

// ── ExecEventFlusher (#1158) ───────────────────────────────────────────────

import { vi } from 'vitest';
import { ExecEventFlusher } from '../src/lib/exec-events.js';

vi.mock('../src/lib/api-client.js', () => ({
  reportExecutionEvents: vi.fn(async () => true),
}));

describe('ExecEventFlusher', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'exec-flush-'));
    const { reportExecutionEvents } = await import('../src/lib/api-client.js');
    vi.mocked(reportExecutionEvents).mockClear();
    vi.mocked(reportExecutionEvents).mockResolvedValue(true);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const envelope = (seq: number): PersistedExecEvent => ({
    v: 2, runId: 'exec_flush_1', seq, ts: new Date().toISOString(),
    source: 'squads-cli', event: { type: 'tool_call', tool: 'Bash', inputSummary: 'ls' },
  });

  it('flushes when the batch size is reached', async () => {
    const { reportExecutionEvents } = await import('../src/lib/api-client.js');
    const flusher = new ExecEventFlusher('exec_flush_1', 3, 60_000);
    flusher.push(envelope(0));
    flusher.push(envelope(1));
    expect(reportExecutionEvents).not.toHaveBeenCalled();
    flusher.push(envelope(2));
    await flusher.flush();
    expect(reportExecutionEvents).toHaveBeenCalledTimes(1);
    const [runId, batch] = vi.mocked(reportExecutionEvents).mock.calls[0];
    expect(runId).toBe('exec_flush_1');
    expect((batch as PersistedExecEvent[]).map((e) => e.seq)).toEqual([0, 1, 2]);
  });

  it('sends a batch once it reaches the byte budget, whatever the count (#1316)', async () => {
    const { reportExecutionEvents } = await import('../src/lib/api-client.js');
    const flusher = new ExecEventFlusher('exec_flush_1', 25, 60_000, 10_000);
    const big = (seq: number): PersistedExecEvent => ({ ...envelope(seq), event: { type: 'message', role: 'assistant', text: 'x'.repeat(6_000) } });
    flusher.push(big(0));
    expect(reportExecutionEvents).not.toHaveBeenCalled();
    flusher.push(big(1));
    flusher.push(envelope(2));
    await flusher.close();
    expect(vi.mocked(reportExecutionEvents).mock.calls.map(([, b]) => (b as PersistedExecEvent[]).map((e) => e.seq))).toEqual([[0, 1], [2]]);
  });

  it('close() sends whatever is buffered', async () => {
    const { reportExecutionEvents } = await import('../src/lib/api-client.js');
    const flusher = new ExecEventFlusher('exec_flush_1', 25, 60_000);
    flusher.push(envelope(0));
    await flusher.close();
    expect(reportExecutionEvents).toHaveBeenCalledTimes(1);
  });

  it('retries a failed batch exactly once, then drops it silently', async () => {
    const { reportExecutionEvents } = await import('../src/lib/api-client.js');
    vi.mocked(reportExecutionEvents).mockResolvedValue(false);
    const flusher = new ExecEventFlusher('exec_flush_1', 25, 60_000);
    flusher.push(envelope(0));
    await flusher.close();
    expect(reportExecutionEvents).toHaveBeenCalledTimes(2);
    // A later flush with nothing buffered stays quiet.
    await flusher.flush();
    expect(reportExecutionEvents).toHaveBeenCalledTimes(2);
  });

  it('writer mirrors persisted lines to the flusher, after the file append', async () => {
    const { reportExecutionEvents } = await import('../src/lib/api-client.js');
    const file = execEventsFile(dir, 'exec_flush_2');
    const flusher = new ExecEventFlusher('exec_flush_2', 25, 60_000);
    const writer = new ExecEventWriter(file, 'exec_flush_2', {
      source: 'squads-cli', provider: 'glm', flusher,
    });
    writer.emit({ type: 'run_start', squad: 's', mode: 'foreground', model: 'm', role: '', startedAt: 'now' });
    writer.emit({ type: 'run_end', ok: true, durationMs: 1, totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEst: 0 } });
    await writer.drain();

    const persisted = readEvents(file);
    expect(persisted).toHaveLength(2);
    expect(persisted[0].v).toBe(2);
    expect(persisted[0].source).toBe('squads-cli');
    expect(persisted[0].provider).toBe('glm');

    const flushed = vi.mocked(reportExecutionEvents).mock.calls.flatMap((c) => c[1] as PersistedExecEvent[]);
    expect(flushed).toEqual(persisted);
  });

  it('writer without v2 fields keeps writing v1 lines', () => {
    const file = execEventsFile(dir, 'exec_flush_3');
    const writer = new ExecEventWriter(file, 'exec_flush_3');
    writer.emit({ type: 'file_read', path: '/x' });
    expect(readEvents(file)[0].v).toBe(1);
  });
});

// ── seq resume + whole-file replay (#1159) ─────────────────────────────────

describe('ExecEventWriter seq resume (#1159)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'exec-seq-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('a second writer on the same file continues the seq counter', () => {
    const file = execEventsFile(dir, 'exec_seq_1');
    const w1 = new ExecEventWriter(file, 'exec_seq_1');
    w1.emit({ type: 'run_start', squad: 's', mode: 'background', model: 'm', role: '', startedAt: 'now' });
    w1.close();

    // Reconcile-time writer (normalizeDetachedLog) — must NOT restart at 0,
    // or the Postgres (run_id, seq) identity silently drops the collisions.
    const w2 = new ExecEventWriter(file, 'exec_seq_1');
    w2.emit({ type: 'file_read', path: '/x' });
    w2.close();

    const seqs = readEvents(file).map((e) => e.seq);
    expect(seqs).toEqual([0, 1]);
  });
});
