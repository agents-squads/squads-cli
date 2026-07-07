import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  createClaudeStreamJsonAdapter,
  ExecEventWriter,
  execEventsFile,
  normalizeDetachedLog,
  type ExecEvent,
  type PersistedExecEvent,
} from '../src/lib/exec-events.js';

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
    // assistant text-only (no tool_use) is not an event in v1
    expect(adapter.parseLine(assistantLine([{ type: 'text', text: 'thinking…' }]))).toEqual([]);
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
