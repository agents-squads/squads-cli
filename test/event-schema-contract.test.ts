/**
 * The event contract as data, cross-repo: the schema, its
 * fixtures and the validator are copied VERBATIM from the engine — so both
 * producers are checked against one schema text, and nothing the CLI does can
 * drift it silently. Copied files are pinned by sha256 in schemas/exec-events/SOURCE.json
 * (a local edit here fails the hash check; re-copy with
 * `node scripts/sync-event-schema.mjs [engineDir]`).
 *
 * What this file checks:
 *  (a) every copied file's sha256 equals SOURCE.json — a hand edit anywhere in
 *      the copy fails;
 *  (b) every engine fixture line validates exactly as the schema says (valid
 *      fixtures pass, invalid ones fail);
 *  (c) events from the CLI's REAL writer path (adapters building call/result
 *      events → ExecEventWriter's envelope + persist) validate, for every
 *      event type the CLI emits;
 *  (d) removing `v` or `schema_version` from a persisted CLI line validates
 *      or fails exactly as the schema specifies.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { validate } from '../src/lib/event-schema-validate.js';
import {
  EXEC_EVENT_TYPES,
  ExecEventWriter,
  execEventsFile,
  createClaudeStreamJsonAdapter,
  createOpencodeStreamJsonAdapter,
  createKimiStreamJsonAdapter,
  type ExecEvent,
  type PersistedExecEvent,
  type ProviderEventAdapter,
} from '../src/lib/exec-events.js';

const SCHEMA_PATH = join(__dirname, '..', 'schemas', 'exec-events', 'exec-events.v2.json');
const SOURCE_PATH = join(__dirname, '..', 'schemas', 'exec-events', 'SOURCE.json');

const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Schema;

/**
 * The validator resolves `$ref`s from the schema document's own definitions,
 * which callers pass explicitly (validate(schema, data, defs)).
 */
const DEFS = SCHEMA.definitions ?? {};

interface Schema {
  definitions?: Record<string, Schema>;
}

/** Every copied contract file the CLI carries — the schema, the fixtures, and the validator. */
function contractFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const entry = join(dir, name);
      if (statSync(entry).isDirectory()) walk(entry, [...prefix, name]);
      else files.push([...prefix, name].join('/'));
    }
  };
  walk(join(__dirname, '..', 'schemas', 'exec-events'), ['schemas', 'exec-events']);
  // SOURCE.json is the pin itself — the ledger cannot hash its own contents;
  // .npmignore is this repo's packaging (fixtures and the pin stay out of npm).
  const local = new Set(['schemas/exec-events/SOURCE.json', 'schemas/exec-events/.npmignore']);
  const copies = files.filter((f) => !local.has(f));
  copies.push('src/lib/event-schema-validate.ts');
  return copies;
}

function readLines(file: string): PersistedExecEvent[] {
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as PersistedExecEvent);
}

// ── (c) drive the CLI's real writer, end to end ─────────────────────────────

const claudeRun = [
  { type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [
    { type: 'text', text: 'On it.' },
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
    { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'b.ts', content: 'x' } },
    { type: 'tool_use', id: 't3', name: 'WebFetch', input: { url: 'https://example.com/x' } },
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

const attachment = (...p: string[]) => readFileSync(join(__dirname, 'fixtures', ...p), 'utf8');

/** Lifecycle events no provider stream produces: the runner emits them itself. */
const runnerEvents: ExecEvent[] = [
  { type: 'run_start', squad: 'demo', agent: 'builder', mode: 'background', model: 'sonnet', role: 'worker', startedAt: '2026-07-01T00:00:00Z', title: 't', task: 'do it' },
  { type: 'context_assembled', layers: [{ layer: 1, name: 'company', chars: 10, tokensEst: 3, evicted: false }], totalTokensEst: 3, budgetTokens: 1000 },
  { type: 'artifact', kind: 'commit', ref: 'abc123' },
  { type: 'gate_result', ok: true, newFailures: [], tests: '3104/3109', sha: 'abc123' },
  { type: 'review_verdict', pr: 'https://github.com/o/r/pull/7', verdict: 'PASS', findings: 3, sha: 'abc123' },
  { type: 'error', errorType: 'rate_limited', retryable: true, message: 'slow down', provider: 'anthropic', status: 429, attempt: 1 },
  { type: 'run_end', ok: true, durationMs: 1200, totalUsage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costEst: 0.5 }, outcomes: { actions: 1, files_edited: 1, commits: 1, prs_created: 0, issues_created: 0 } },
];

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'squads-event-contract-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** One run: the writer emits the runner's own events and ingests every provider line through a real adapter. */
function produce(id: string, adapter: ProviderEventAdapter, raw: string, opts: { source?: string; provider?: string; sessionId?: string } = {}): PersistedExecEvent[] {
  const file = execEventsFile(root, id);
  const w = new ExecEventWriter(file, id, opts);
  for (const e of runnerEvents.slice(0, 2)) w.emit(e, 'builder');
  for (const line of raw.split('\n')) w.ingestProviderLine(adapter, line, 'builder');
  for (const e of runnerEvents.slice(2)) w.emit(e, 'builder');
  w.close();
  return readLines(file);
}

const harnesses: Record<string, () => PersistedExecEvent[]> = {
  'claude (stream-json)': () => produce('contract_claude', createClaudeStreamJsonAdapter(), claudeRun, { source: 'squads-cli', provider: 'anthropic' }),
  'opencode': () => produce('contract_opencode', createOpencodeStreamJsonAdapter(), attachment('opencode', 'thinking-run.jsonl'), { source: 'squads-cli', provider: 'glm' }),
  'kimi-code': () => produce('contract_kimi', createKimiStreamJsonAdapter(), attachment('kimi-code', 'tool-run.jsonl'), { source: 'squads-cli', provider: 'kimi' }),
};

/** All lines of one harness run must validate; returns them for count assertions. */
function expectLines(name: string, lines: PersistedExecEvent[]): PersistedExecEvent[] {
  expect(lines.length, name).toBeGreaterThan(runnerEvents.length);
  for (const line of lines) {
    expectIds(line);
    expect(validate(SCHEMA, line, DEFS), JSON.stringify(line)).toEqual([]);
  }
  return lines;
}

/** The envelope fields that are not schema-conditional: always present, per the writer. */
function expectIds(line: PersistedExecEvent): void {
  expect(line.schema_version).toBe(1);
  expect(line.runId).toBeTruthy();
  expect(line.seq).toBeGreaterThanOrEqual(0);
  expect(line.ts).toBeTruthy();
}

describe('event schema v2 contract — copied files', () => {
  it('(a) every copied file matches its sha256 in SOURCE.json, so a local edit fails', () => {
    const source = JSON.parse(readFileSync(SOURCE_PATH, 'utf8')) as { engine_commit: string; files: Record<string, string> };
    expect(source.engine_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(source.files).sort()).toEqual(contractFiles().sort());
    for (const rel of contractFiles()) {
      const actual = createHash('sha256').update(readFileSync(join(__dirname, '..', rel))).digest('hex');
      expect(actual, rel).toBe(source.files[rel]);
    }
  });
});

describe('event schema v2 contract — fixtures', () => {
  const valid = (p: string) => readLines(join(__dirname, '..', 'schemas', 'exec-events', 'fixtures', ...p));
  const raw = (p: string) => readFileSync(join(__dirname, '..', 'schemas', 'exec-events', 'fixtures', ...p), 'utf8');

  it('(b) every event fixture line validates', () => {
    const lines = valid(['events.jsonl']);
    expect(lines.length).toBeGreaterThan(20);
    for (const line of lines) {
      const issues = validate(SCHEMA, line, DEFS);
      expect(issues, JSON.stringify(line)).toEqual([]);
      // v1 lines remain valid under the union schema; producers stamp 2 today.
      expect([1, 2], JSON.stringify(line)).toContain(line.v);
    }
  });

  it('(b) turn fixture lines validate under #/definitions/turn, the definition the schema names for them', () => {
    const turn: Schema | undefined = SCHEMA.definitions?.turn;
    expect(turn).toBeDefined();
    for (const line of raw(['turns.jsonl']).trim().split('\n')) {
      const record = JSON.parse(line) as unknown;
      expect(validate(turn, record, DEFS), line).toEqual([]);
      // A turn record is not an execution event: against the envelope document
      // it carries none of the required envelope fields, so it fails there.
      expect(validate(SCHEMA, record, DEFS).length, line).toBeGreaterThan(0);
    }
  });

  for (const name of ['bad-date-time', 'missing-required', 'unknown-event-type', 'unknown-schema-version']) {
    it(`(b) every ${name} fixture line is rejected`, () => {
      for (const line of raw(['invalid', `${name}.jsonl`]).trim().split('\n')) {
        const issues = validate(SCHEMA, JSON.parse(line), DEFS);
        expect(issues.length, line).toBeGreaterThan(0);
      }
    });
  }
});

describe('event schema v2 contract — the CLI runs against it', () => {
  it('(c) every line the real writer persists validates', () => {
    const all = Object.entries(harnesses).flatMap(([name, produceLines]) => expectLines(name, produceLines()));
    expect(all.length).toBeGreaterThan(15);
  });

  it('(c) across the writer runs, every event type the CLI emits is exercised and valid', () => {
    const seen = new Set<string>();
    for (const produceLines of Object.values(harnesses)) {
      for (const line of produceLines()) seen.add(line.event.type);
    }
    // `truncated` only lands when the cap is hit — force it once, and keep it valid.
    const w = new ExecEventWriter(execEventsFile(root, 'contract_cap'), 'contract_cap', { maxEvents: 1 });
    w.emit(runnerEvents[0]!);
    w.emit({ type: 'file_read', path: '/x' });
    w.close();
    for (const line of readLines(execEventsFile(root, 'contract_cap'))) {
      seen.add(line.event.type);
      expectIds(line);
      expect(validate(SCHEMA, line, DEFS), JSON.stringify(line)).toEqual([]);
    }
    expect([...EXEC_EVENT_TYPES].filter((t) => !seen.has(t))).toEqual([]);
  });

  it('(d) deleting `v` from a persisted CLI line fails exactly as the schema says', () => {
    const line = harnesses['claude (stream-json)']()[0] as unknown;
    const copy = JSON.parse(JSON.stringify(line)) as { v?: number; event: { type: string } };
    expect(copy.v).toBeDefined();
    delete copy.v;
    const issues = validate(SCHEMA, copy, DEFS);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('(d) deleting `schema_version` from a persisted CLI line fails: both producers stamp it, so the contract requires it', () => {
    const line = harnesses['claude (stream-json)']()[0] as unknown;
    const copy = JSON.parse(JSON.stringify(line)) as { schema_version?: number; event: { type: string } };
    expect(copy.schema_version).toBeDefined();
    delete copy.schema_version;
    expect(validate(SCHEMA, copy, DEFS).map(i => i.message).join(' ')).toContain('schema_version');
  });
});
