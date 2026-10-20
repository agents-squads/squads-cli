/**
 * The event contract (#1341): every line the CLI writes carries `schema_version` and validates
 * against the exported `schemas/exec-event.v1.schema.json`, for every event type and every harness.
 * Consumers (interactive mode, Platform API) validate with the same file, without importing CLI code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  EXEC_EVENT_SCHEMA_VERSION,
  EXEC_EVENT_TYPES,
  ExecEventWriter,
  createClaudeStreamJsonAdapter,
  createKimiStreamJsonAdapter,
  createOpencodeStreamJsonAdapter,
  execEventsFile,
  normalizeDetachedLog,
  replayEventsFile,
  type ExecEvent,
  type PersistedExecEvent,
  type ProviderEventAdapter,
} from '../src/lib/exec-events.js';

vi.mock('../src/lib/api-client.js', () => ({
  reportExecutionEvents: vi.fn(async () => true),
}));

const SCHEMA = JSON.parse(readFileSync(join(__dirname, '..', 'schemas', 'exec-event.v1.schema.json'), 'utf8')) as Schema;

// ── A validator for the JSON Schema subset the file uses ────────────────────
// (type, integer, minimum, const, enum, required, properties, items, oneOf, $ref to #/$defs).
// Not a dependency: the schema stays plain enough that any validator reads it the same way.

interface Schema {
  $defs?: Record<string, Schema>;
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  oneOf?: Schema[];
}

function validate(value: unknown, schema: Schema, path = '$'): string[] {
  if (schema.$ref) return validate(value, SCHEMA.$defs![schema.$ref.replace('#/$defs/', '')]!, path);
  if (schema.oneOf) {
    const hits = schema.oneOf.map((s) => validate(value, s, path));
    const ok = hits.filter((e) => e.length === 0).length;
    return ok === 1 ? [] : [`${path}: matches ${ok} of ${hits.length} alternatives`];
  }
  if ('const' in schema && value !== schema.const) return [`${path}: expected ${JSON.stringify(schema.const)}`];
  if (schema.enum && !schema.enum.includes(value)) return [`${path}: not one of ${JSON.stringify(schema.enum)}`];
  const errors: string[] = [];
  switch (schema.type) {
    case 'string': if (typeof value !== 'string') errors.push(`${path}: expected string`); break;
    case 'boolean': if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`); break;
    case 'number': case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) errors.push(`${path}: expected ${schema.type}`);
      else if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below ${schema.minimum}`);
      break;
    case 'array':
      if (!Array.isArray(value)) errors.push(`${path}: expected array`);
      else if (schema.items) value.forEach((v, i) => errors.push(...validate(v, schema.items!, `${path}[${i}]`)));
      break;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { errors.push(`${path}: expected object`); break; }
      const obj = value as Record<string, unknown>;
      for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${path}.${k}: required`);
      // Unknown fields are allowed: adding an optional field keeps the version.
      for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in obj) errors.push(...validate(obj[k], s, `${path}.${k}`));
      break;
    }
  }
  return errors;
}

// ── Fixtures: one run per harness, written through the real writer ──────────

const claudeRun = [
  { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [
    { type: 'thinking', thinking: 'plan' },
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
    { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'b.ts', content: 'x' } },
    { type: 'tool_use', id: 't3', name: 'WebFetch', input: { url: 'https://example.com' } },
    { type: 'tool_use', id: 't4', name: 'Task', input: { subagent_type: 'worker', description: 'do it' } },
    { type: 'tool_use', id: 't5', name: 'Bash', input: { command: 'gh pr create --title x' } },
  ] } },
  { type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: 'file text' },
    { type: 'tool_result', tool_use_id: 't4', content: 'done', is_error: false },
    { type: 'tool_result', tool_use_id: 't5', content: 'https://github.com/o/r/pull/7' },
  ] } },
  { type: 'result', total_cost_usd: 0.1, model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } },
].map((l) => JSON.stringify(l)).join('\n');

const fixture = (...p: string[]) => readFileSync(join(__dirname, 'fixtures', ...p), 'utf8');

/** A native-harness lane (squads-engine) writes its own events file, so its fixture is the
 *  persisted lines themselves rather than output from one of our stream adapters. */
const nativeRun = fixture('native', 'events.jsonl').trim().split('\n').map((l) => JSON.parse(l) as PersistedExecEvent);

/** Lifecycle events no provider stream produces: our own runner emits them. */
const runnerEvents: ExecEvent[] = [
  { type: 'run_start', squad: 'eng', agent: 'builder', mode: 'background', model: 'sonnet', role: 'worker', startedAt: '2026-07-01T00:00:00Z', title: 't', task: 'do it' },
  { type: 'context_assembled', layers: [{ layer: 1, name: 'company', chars: 10, tokensEst: 3, evicted: false }], totalTokensEst: 3, budgetTokens: 1000 },
  { type: 'artifact', kind: 'commit', ref: 'abc123' },
  { type: 'gate_result', ok: true, newFailures: [], tests: '3104/3109', sha: 'abc123' },
  { type: 'review_verdict', pr: 'https://github.com/o/r/pull/7', verdict: 'PASS', findings: 3, sha: 'abc123' },
  { type: 'error', errorType: 'rate_limited', retryable: true, message: 'slow down', provider: 'anthropic', status: 429, attempt: 1 },
  { type: 'run_end', ok: true, durationMs: 1200, totalUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costEst: 0.5 }, outcomes: { actions: 1, files_edited: 1, commits: 1, prs_created: 0, issues_created: 0 } },
];

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'squads-event-schema-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function readLines(file: string): PersistedExecEvent[] {
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PersistedExecEvent);
}

function runThrough(id: string, adapter: ProviderEventAdapter, raw: string, opts: { source?: string; provider?: string } = {}): PersistedExecEvent[] {
  const file = execEventsFile(root, id);
  const w = new ExecEventWriter(file, id, opts);
  for (const e of runnerEvents.slice(0, 2)) w.emit(e, 'builder');
  for (const l of raw.split('\n')) w.ingestProviderLine(adapter, l, 'builder');
  for (const e of runnerEvents.slice(2)) w.emit(e, 'builder');
  w.close();
  return readLines(file);
}

const harnesses: Record<string, () => PersistedExecEvent[]> = {
  'claude (stream-json)': () => runThrough('exec_claude', createClaudeStreamJsonAdapter(), claudeRun, { source: 'squads-cli', provider: 'anthropic' }),
  'opencode': () => runThrough('exec_opencode', createOpencodeStreamJsonAdapter(), fixture('opencode', 'thinking-run.jsonl')),
  'kimi-code': () => runThrough('exec_kimi', createKimiStreamJsonAdapter(), fixture('kimi-code', 'tool-run.jsonl')),
  'native (squads-engine)': () => nativeRun,
};

describe('exec event contract (#1341)', () => {
  it('the schema describes exactly the event types the CLI has', () => {
    const described = (SCHEMA.properties!.event!.oneOf ?? []).map((s) => s.$ref!.replace('#/$defs/', ''));
    expect([...described].sort()).toEqual([...EXEC_EVENT_TYPES].sort());
  });

  it('the published package exposes the schema at its stable subpath (#1343)', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      files: string[];
    };
    expect(pkg.exports['./schemas/exec-event.v1.schema.json']).toBe('./schemas/exec-event.v1.schema.json');
    expect(pkg.exports['.']).toBeDefined();
    expect(pkg.files).toContain('schemas');
  });

  for (const [name, produce] of Object.entries(harnesses)) {
    it(`${name}: every line has schema_version ${EXEC_EVENT_SCHEMA_VERSION} and validates`, () => {
      const lines = produce();
      expect(lines.length).toBeGreaterThan(runnerEvents.length);
      for (const l of lines) {
        expect(l.schema_version).toBe(1);
        expect(validate(l, SCHEMA), JSON.stringify(l)).toEqual([]);
      }
    });
  }

  it('across the fixtures, every event type the CLI emits is exercised', () => {
    const seen = new Set<string>();
    for (const produce of Object.values(harnesses)) for (const l of produce()) seen.add(l.event.type);
    // `truncated` only appears when the cap is hit — forced below; the rest must come from the fixtures.
    const w = new ExecEventWriter(execEventsFile(root, 'exec_cap'), 'exec_cap', { maxEvents: 1 });
    w.emit(runnerEvents[0]!);
    w.emit({ type: 'file_read', path: '/x' });
    w.close();
    for (const l of readLines(execEventsFile(root, 'exec_cap'))) {
      seen.add(l.event.type);
      expect(validate(l, SCHEMA), JSON.stringify(l)).toEqual([]);
    }
    expect([...EXEC_EVENT_TYPES].filter((t) => !seen.has(t))).toEqual([]);
  });

  it('a detached run normalized after the fact is versioned and valid too', () => {
    normalizeDetachedLog(claudeRun, root, 'exec_detached', 'builder', runnerEvents[4] as Extract<ExecEvent, { type: 'run_end' }>, 'anthropic', 'claude');
    const lines = readLines(execEventsFile(root, 'exec_detached'));
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(l.schema_version).toBe(1);
      expect(validate(l, SCHEMA), JSON.stringify(l)).toEqual([]);
    }
  });

  it('a line without schema_version fails validation', () => {
    const line = { ...harnesses['claude (stream-json)']!()[0] } as Partial<PersistedExecEvent>;
    delete line.schema_version;
    expect(validate(line, SCHEMA)).toContain('$.schema_version: required');
  });

  it('a version this schema does not describe fails validation', () => {
    const line = { ...harnesses['claude (stream-json)']!()[0]!, schema_version: 2 };
    expect(validate(line, SCHEMA).join()).toContain('$.schema_version');
  });

  it('an event with a required field removed fails validation', () => {
    const lines = harnesses['claude (stream-json)']!();
    const call = lines.find((l) => l.event.type === 'tool_call')!;
    const { tool: _tool, ...rest } = call.event as Extract<ExecEvent, { type: 'tool_call' }>;
    void _tool;
    const broken = { ...call, event: rest };
    expect(validate(broken, SCHEMA).length).toBeGreaterThan(0);
  });

  it('an event with a changed field type fails validation', () => {
    const end = harnesses['claude (stream-json)']!().find((l) => l.event.type === 'run_end')!;
    const broken = { ...end, event: { ...end.event, durationMs: '1200' } };
    expect(validate(broken, SCHEMA).length).toBeGreaterThan(0);
  });

  it('additive change keeps validating: an unknown optional field is ignored', () => {
    const line = { ...harnesses['claude (stream-json)']!()[0]!, futureField: 1 };
    expect(validate(line, SCHEMA)).toEqual([]);
  });

  it('every required field of every event type is present in some fixture event (the schema is not looser than reality)', () => {
    const lines = Object.values(harnesses).flatMap((p) => p());
    for (const [type, def] of Object.entries(SCHEMA.$defs!)) {
      const sample = lines.find((l) => l.event.type === type);
      if (!sample) continue; // truncated: covered above
      for (const k of def.required!) expect(sample.event, `${type}.${k}`).toHaveProperty(k);
    }
  });

  it('replay stamps lines written before versioning, so the API never receives an unversioned one', async () => {
    const { reportExecutionEvents } = await import('../src/lib/api-client.js');
    vi.mocked(reportExecutionEvents).mockClear();
    const file = execEventsFile(root, 'exec_legacy');
    const w = new ExecEventWriter(file, 'exec_legacy');
    w.emit({ type: 'file_read', path: '/x' });
    w.close();
    const legacy = readLines(file).map((l) => { const { schema_version: _s, ...rest } = l; void _s; return rest; });
    writeFileSync(file, legacy.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await replayEventsFile(file, 'exec_legacy');
    const sent = vi.mocked(reportExecutionEvents).mock.calls.flatMap((c) => c[1] as PersistedExecEvent[]);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.schema_version).toBe(1);
    expect(validate(sent[0], SCHEMA)).toEqual([]);
  });
});
