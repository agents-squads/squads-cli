import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseKimiJson, parseKimiLine, extractKimiSessionId, readKimiSessionUsage, readKimiSessionReasoning, detectKimiAuthError,
} from '../src/lib/kimi-code.js';
import { LLM_CLIS } from '../src/lib/llm-clis.js';
import { createKimiStreamJsonAdapter, type ExecEvent } from '../src/lib/exec-events.js';

// Sanitized capture of a live kimi-code 2.2.0 run (subscription login, 2026-10-19, cli#1309).
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'kimi-code', 'tool-run.jsonl'), 'utf-8');
const SESSION = 'session_d5dd8847-999d-48ba-8983-3f0f559584c3';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'kimi-home-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** Lay down kimi's session index + wire log the way the CLI does. */
function writeSession(wireLines: unknown[], sessionId = SESSION): void {
  const sessionDir = join(home, 'sessions', 'abc');
  mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
  writeFileSync(join(home, 'session_index.jsonl'), [
    JSON.stringify({ sessionId: 'session_other', sessionDir: '/nonexistent', workDir: '/x' }),
    JSON.stringify({ sessionId, sessionDir, workDir: '/repo' }),
  ].join('\n') + '\n');
  writeFileSync(join(sessionDir, 'agents', 'main', 'wire.jsonl'), wireLines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const usageRecord = (u: Record<string, number>, model = 'k3') => ({ type: 'usage.record', usage: u, model });

describe('parseKimiJson (fixture)', () => {
  const r = parseKimiJson(FIXTURE);

  it('counts every tool call as an action and Write as a file edit', () => {
    expect(r.outcomes.actions).toBe(3); // Bash, Read, Write
    expect(r.outcomes.files_edited).toBe(1);
  });

  it('takes the final assistant text and the terminal resume_hint as sawResult', () => {
    expect(r.text).toContain('`name` field in package.json is **`fixture-pkg`**');
    expect(r.sawResult).toBe(true);
    expect(r.isError).toBe(false);
  });

  it('carries NO usage — stdout has none, so it stays zero rather than invented', () => {
    expect(r.usage.input_tokens).toBe(0);
    expect(r.usage.output_tokens).toBe(0);
    expect(r.usage.cost_usd).toBe(0);
  });

  it('a log cut off before resume_hint is not a result (#1131)', () => {
    const cut = FIXTURE.split('\n').filter((l) => !l.includes('session.resume_hint')).join('\n');
    expect(parseKimiJson(cut).sawResult).toBe(false);
  });

  it('counts a commit only from the paired tool result, not the command text (#1134)', () => {
    const call = (id: string, command: string) => JSON.stringify({ role: 'assistant', tool_calls: [
      { type: 'function', id, function: { name: 'Bash', arguments: JSON.stringify({ command }) } }] });
    const res = (id: string, content: string) => JSON.stringify({ role: 'tool', tool_call_id: id, content });
    const log = [
      call('c1', 'git commit -m "fix: x"'), res('c1', '[main ab12cd3] fix: x\n 1 file changed'),
      call('c2', 'git commit -m "nothing"'), res('c2', 'nothing to commit, working tree clean'),
    ].join('\n');
    expect(parseKimiJson(log).outcomes.commits).toBe(1);
  });

  it('ignores non-JSON noise lines (stderr in the same log)', () => {
    expect(parseKimiLine('Warning: something on stderr')).toBeNull();
    expect(parseKimiLine('')).toBeNull();
    expect(parseKimiJson('garbage\n' + FIXTURE).outcomes.actions).toBe(3);
  });
});

describe('createKimiStreamJsonAdapter', () => {
  it('normalizes the fixture to tool_call/file_read/file_write/tool_result events', () => {
    const adapter = createKimiStreamJsonAdapter();
    const events: ExecEvent[] = FIXTURE.split('\n').flatMap((l) => adapter.parseLine(l));
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'tool_call')).toHaveLength(3);
    expect(types.filter((t) => t === 'tool_result')).toHaveLength(3);
    expect(events).toContainEqual({ type: 'tool_call', tool: 'Bash', inputSummary: 'ls -la' });
    expect(events).toContainEqual({ type: 'file_read', path: 'package.json' });
    expect(events).toContainEqual({ type: 'file_write', path: 'out.txt', bytes: 12 });
  });

  it('emits no token_usage when the wire is unreadable (null, not 0)', () => {
    const prev = process.env.HOME;
    process.env.HOME = home; // empty home: no session index
    try {
      const adapter = createKimiStreamJsonAdapter();
      const events = FIXTURE.split('\n').flatMap((l) => adapter.parseLine(l));
      expect(events.some((e) => e.type === 'token_usage')).toBe(false);
    } finally {
      process.env.HOME = prev;
    }
  });

  it('emits one cumulative token_usage from the wire at resume_hint, cost 0', () => {
    const prev = process.env.HOME;
    process.env.HOME = home; // kimiHome() = <HOME>/.kimi-code
    try {
      const kimiDir = join(home, '.kimi-code');
      mkdirSync(kimiDir, { recursive: true });
      const sessionDir = join(kimiDir, 'sessions', 's1');
      mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
      writeFileSync(join(kimiDir, 'session_index.jsonl'), JSON.stringify({ sessionId: SESSION, sessionDir }) + '\n');
      writeFileSync(join(sessionDir, 'agents', 'main', 'wire.jsonl'),
        JSON.stringify(usageRecord({ inputOther: 10, output: 5, inputCacheRead: 100, inputCacheCreation: 2 })) + '\n');
      const adapter = createKimiStreamJsonAdapter();
      const usage = FIXTURE.split('\n').flatMap((l) => adapter.parseLine(l)).filter((e) => e.type === 'token_usage');
      expect(usage).toEqual([{
        type: 'token_usage', input: 112, output: 5, cacheRead: 100, cacheWrite: 2, costEst: 0, model: 'k3',
      }]);
    } finally {
      process.env.HOME = prev;
    }
  });
});

describe('session wire usage', () => {
  it('extracts the session id from resume_hint', () => {
    expect(extractKimiSessionId(FIXTURE)).toBe(SESSION);
    expect(extractKimiSessionId('no events here')).toBeUndefined();
  });

  it('sums usage.record only — step.end duplicates inside append_loop_event are not counted', () => {
    writeSession([
      usageRecord({ inputOther: 100, output: 20, inputCacheRead: 1000, inputCacheCreation: 50 }),
      { type: 'context.append_loop_event', event: { type: 'step.end', usage: { inputOther: 100, output: 20, inputCacheRead: 1000, inputCacheCreation: 50 } } },
      usageRecord({ inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 }, 'k3-turbo'),
      { type: 'context.append_loop_event', event: { type: 'step.end', usage: { inputOther: 7, output: 3 } } },
    ]);
    expect(readKimiSessionUsage(SESSION, home)).toEqual({
      input_tokens: 100 + 1000 + 50 + 7,
      output_tokens: 23,
      cache_read_tokens: 1000,
      cache_write_tokens: 50,
      model: 'k3-turbo',
      steps: 2,
    });
  });

  it('is null — never zero — when the index, the wire or any usage record is missing', () => {
    expect(readKimiSessionUsage(SESSION, home)).toBeNull(); // no index
    writeSession([{ type: 'context.append_loop_event', event: { type: 'step.end', usage: { output: 9 } } }]);
    expect(readKimiSessionUsage(SESSION, home)).toBeNull(); // wire without usage.record
    expect(readKimiSessionUsage('session_unknown', home)).toBeNull(); // id not in the index
    expect(readKimiSessionUsage('../../etc/passwd', home)).toBeNull(); // not a session id
  });

  it('tolerates a torn trailing line while kimi is still writing', () => {
    writeSession([usageRecord({ inputOther: 1, output: 1 })]);
    const wire = join(home, 'sessions', 'abc', 'agents', 'main', 'wire.jsonl');
    writeFileSync(wire, readFileSync(wire, 'utf-8') + '{"type":"usage.rec');
    expect(readKimiSessionUsage(SESSION, home)?.steps).toBe(1);
  });
});

describe('detectKimiAuthError', () => {
  it('names the fix when kimi is not logged in', () => {
    expect(detectKimiAuthError('Error: not logged in. Please log in.')).toMatch(/run `kimi` and log in/);
    expect(detectKimiAuthError('401 Unauthorized')).toMatch(/never falls back to a metered key/);
  });

  it('is silent for a run that reached resume_hint, and for unrelated output', () => {
    expect(detectKimiAuthError(FIXTURE + '\n401 in a tool result')).toBeNull();
    expect(detectKimiAuthError('some other failure')).toBeNull();
  });
});

describe('kimi-code CLIConfig', () => {
  const cfg = LLM_CLIS['kimi-code'];

  it('runs kimi -p with stream-json and NEVER --auto (cannot combine with -p)', () => {
    const args = cfg.buildArgs('do the thing');
    expect(args.slice(0, 4)).toEqual(['-p', 'do the thing', '--output-format', 'stream-json']);
    expect(args).not.toContain('--auto');
  });

  it('maps kimi-code/<alias> to -m <alias> and drops leaked Claude models', () => {
    expect(cfg.buildArgs('x', { model: 'kimi-code/k3' }).slice(-2)).toEqual(['-m', 'kimi-code/k3']);
    expect(cfg.buildArgs('x', { model: 'claude-sonnet-5' })).not.toContain('-m');
    expect(cfg.buildArgs('x')).not.toContain('-m');
  });

  it('spawns with stdin ignored and strips metered keys and ANTHROPIC_* from the env', () => {
    expect(cfg.stdinIgnore).toBe(true);
    // Restore keys in place: reassigning process.env detaches it from the real environment, and
    // later HOME overrides in this file stop reaching os.homedir().
    const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'KIMI_API_KEY'] as const;
    const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    process.env.ANTHROPIC_API_KEY = 'a'; process.env.ANTHROPIC_BASE_URL = 'b'; process.env.KIMI_API_KEY = 'k';
    try {
      const env = cfg.env!();
      expect(env).toHaveProperty('KIMI_API_KEY', undefined);
      expect(env).toHaveProperty('MOONSHOT_API_KEY', undefined);
      expect(env).toHaveProperty('ANTHROPIC_API_KEY', undefined);
      expect(env).toHaveProperty('ANTHROPIC_BASE_URL', undefined);
      expect(Object.values(env).every((v) => v === undefined)).toBe(true);
    } finally {
      for (const k of keys) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  });
});

describe('kimi adapter emits message events (#1275 part 2)', () => {
  it('turns assistant content into a message event, alongside tool calls', async () => {
    const { createKimiStreamJsonAdapter } = await import('../src/lib/exec-events.js');
    const a = createKimiStreamJsonAdapter();
    const events = FIXTURE.split('\n').filter(Boolean).flatMap((l) => a.parseLine(l));
    const messages = events.filter((e) => e.type === 'message');
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.at(-1)).toMatchObject({ type: 'message', role: 'assistant' });
    expect(events.some((e) => e.type === 'tool_call')).toBe(true);
    const both = a.parseLine(JSON.stringify({ role: 'assistant', content: 'checking', tool_calls: [{ type: 'function', id: 'x', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] }));
    expect(both.map((e) => e.type)).toEqual(['message', 'tool_call']);
  });
});

// Shapes from a live kimi-code 2.2.0 wire log (2026-10-19): the think part is written once as a
// loop event and repeated inside agent.message.appended.
const thinkPart = (step: number, think: string) => ({
  type: 'context.append_loop_event', agentId: 'main',
  event: { type: 'content.part', turnId: '0', step, part: { type: 'think', think, reasoningKey: 'reasoning_content' } },
});
const appended = (think: string) => ({
  type: 'agent.message.appended',
  message: { message: { role: 'assistant', content: [{ type: 'think', think }, { type: 'text', text: 'reading the issue' }] } },
});

describe('kimi reasoning from the session wire (#1316)', () => {
  it('reads each step\'s think part once, in order, with its step', () => {
    writeSession([
      thinkPart(1, 'Let me start by reading the issue.'), appended('Let me start by reading the issue.'),
      usageRecord({ inputOther: 1, output: 1 }),
      thinkPart(2, '   '), // blank: skipped
      thinkPart(3, 'The fix belongs in the adapter.'), appended('The fix belongs in the adapter.'),
    ]);
    expect(readKimiSessionReasoning(SESSION, home)).toEqual([
      { step: 1, text: 'Let me start by reading the issue.' },
      { step: 3, text: 'The fix belongs in the adapter.' },
    ]);
  });

  it('is empty, never a throw, when the session or the wire is missing or torn', () => {
    expect(readKimiSessionReasoning(SESSION, home)).toEqual([]);
    expect(readKimiSessionReasoning('../../etc/passwd', home)).toEqual([]);
    writeSession([thinkPart(1, 'ok')]);
    const wire = join(home, 'sessions', 'abc', 'agents', 'main', 'wire.jsonl');
    writeFileSync(wire, readFileSync(wire, 'utf-8') + '{"type":"context.append_loop_event","event":{"part":{"type":"think"');
    expect(readKimiSessionReasoning(SESSION, home)).toEqual([{ step: 1, text: 'ok' }]);
  });

  /** The adapter reads kimiHome() = <HOME>/.kimi-code. */
  function withKimiHome(wire: unknown[], fn: () => void): void {
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const kimiDir = join(home, '.kimi-code');
      const sessionDir = join(kimiDir, 'sessions', 's1');
      mkdirSync(join(sessionDir, 'agents', 'main'), { recursive: true });
      writeFileSync(join(kimiDir, 'session_index.jsonl'), JSON.stringify({ sessionId: SESSION, sessionDir }) + '\n');
      writeFileSync(join(sessionDir, 'agents', 'main', 'wire.jsonl'), wire.map((l) => JSON.stringify(l)).join('\n') + '\n');
      fn();
    } finally {
      process.env.HOME = prev;
    }
  }

  it('the adapter emits them at resume_hint, ahead of token_usage', () => {
    withKimiHome([thinkPart(1, 'plan first'), appended('plan first'), usageRecord({ inputOther: 3, output: 2 })], () => {
      const events = FIXTURE.split('\n').flatMap((l) => createKimiStreamJsonAdapter().parseLine(l));
      const tail = events.filter((e) => e.type === 'reasoning' || e.type === 'token_usage');
      expect(tail.map((e) => e.type)).toEqual(['reasoning', 'token_usage']);
      expect(tail[0]).toEqual({ type: 'reasoning', text: 'plan first', step: 1 });
    });
  });

  it('reasoning_content on stdout is emitted live and the wire copy is not read again', () => {
    withKimiHome([thinkPart(1, 'plan first'), usageRecord({ inputOther: 3, output: 2 })], () => {
      const a = createKimiStreamJsonAdapter();
      const live = a.parseLine(JSON.stringify({ role: 'assistant', reasoning_content: 'plan first', content: 'ok' }));
      expect(live).toEqual([{ type: 'reasoning', text: 'plan first' }, { type: 'message', role: 'assistant', text: 'ok' }]);
      const end = FIXTURE.split('\n').filter((l) => l.includes('session.resume_hint')).flatMap((l) => a.parseLine(l));
      expect(end.map((e) => e.type)).toEqual(['token_usage']);
    });
  });
});
