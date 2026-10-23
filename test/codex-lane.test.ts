/**
 * openai lane (codex exec): writes in the worktree, honours only OpenAI model
 * names, and records the model that ran plus tokens/cost from `--json`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import {
  LLM_CLIS, parseCodexUsage, renderCodexLine, resolveCodexModel, codexConfigModel, codexSandboxMode,
} from '../src/lib/llm-clis.js';

vi.mock('../src/lib/api-client.js', () => ({
  reportExecutionStart: vi.fn().mockResolvedValue(true),
  reportExecutionComplete: vi.fn().mockResolvedValue(true),
  reportExecutionEvents: vi.fn().mockResolvedValue(true),
}));

const CODEX_STREAM = [
  { type: 'thread.started', thread_id: '01a16b2b-5938-7730-abae-54c5bebb2684' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Creating hello.txt.' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: "printf hi > hello.txt", exit_code: 0, status: 'completed' } },
  { type: 'turn.completed', usage: { input_tokens: 37570, cached_input_tokens: 31744, cache_write_input_tokens: 0, output_tokens: 62, reasoning_output_tokens: 0 } },
].map((e) => JSON.stringify(e)).join('\n') + '\n';

let prevEnv: NodeJS.ProcessEnv;
beforeEach(() => { prevEnv = { ...process.env }; });
afterEach(() => { process.env = prevEnv; });

describe('openai lane args', () => {
  it('runs codex exec with a workspace-write sandbox, no approvals, JSON events, in the worktree', () => {
    delete process.env.OPENAI_MODEL;
    const args = LLM_CLIS.openai.buildArgs('do it', { cwd: '/work/tree', allowedTools: ['Read', 'Write', 'Bash(git:*)'] });
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args[args.indexOf('--sandbox') + 1]).toBe('workspace-write');
    expect(args[args.indexOf('-c') + 1]).toBe('approval_policy="never"');
    expect(args[args.indexOf('-C') + 1]).toBe('/work/tree');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args.slice(-2)).toEqual(['--', 'do it']);
    expect(LLM_CLIS.openai.stdinIgnore).toBe(true);
  });

  it('stays read-only unless the agent is granted a file-write tool', () => {
    expect(codexSandboxMode(undefined)).toBe('read-only');
    expect(codexSandboxMode([])).toBe('read-only');
    expect(codexSandboxMode(['Read', 'Grep', 'Bash(git:*)'])).toBe('read-only');
    expect(codexSandboxMode(['Read', 'Edit'])).toBe('workspace-write');
    expect(codexSandboxMode(['Write(src/**)'])).toBe('workspace-write');
    const args = LLM_CLIS.openai.buildArgs('x', { allowedTools: ['Read', 'Glob'] });
    expect(args[args.indexOf('--sandbox') + 1]).toBe('read-only');
  });

  it('passes an OpenAI model with -m', () => {
    const args = LLM_CLIS.openai.buildArgs('x', { model: 'gpt-5.5' });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
    const prefixed = LLM_CLIS.openai.buildArgs('x', { model: 'openai/o4-mini' });
    expect(prefixed[prefixed.indexOf('-m') + 1]).toBe('o4-mini');
  });

  it('drops a leaked Anthropic model name (#937) — codex keeps its own default', () => {
    delete process.env.OPENAI_MODEL;
    for (const model of ['sonnet', 'opus', 'claude-sonnet-4-6']) {
      expect(LLM_CLIS.openai.buildArgs('x', { model })).not.toContain('-m');
    }
  });

  it('OPENAI_MODEL is the lane default when no OpenAI model is requested', () => {
    process.env.OPENAI_MODEL = 'gpt-5.5-mini';
    const args = LLM_CLIS.openai.buildArgs('x', { model: 'sonnet' });
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5-mini');
    expect(resolveCodexModel('gpt-5.5')).toBe('gpt-5.5');
  });
});

describe('openai lane model attribution', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'codex-home-'));
    process.env.CODEX_HOME = home;
    delete process.env.OPENAI_MODEL;
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('reads the top-level model from codex config, ignoring tables', () => {
    writeFileSync(join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n\n[profiles.fast]\nmodel = "gpt-5.5-mini"\n');
    expect(codexConfigModel()).toBe('gpt-6-astra');
    expect(LLM_CLIS.openai.resolveModel!({ model: 'sonnet' })).toBe('gpt-6-astra');
    expect(LLM_CLIS.openai.resolveModel!({ model: 'gpt-5.5' })).toBe('gpt-5.5');
  });

  it('unknown model is undefined, never the leaked name', () => {
    expect(codexConfigModel()).toBeUndefined();
    expect(LLM_CLIS.openai.resolveModel!({ model: 'sonnet' })).toBeUndefined();
  });
});

describe('parseCodexUsage', () => {
  it('reads tokens from turn.completed and prices them from the table', () => {
    const u = parseCodexUsage(CODEX_STREAM, 'gpt-4o');
    expect(u).toMatchObject({ input_tokens: 37570, output_tokens: 62 });
    expect(u!.cost_usd).toBeCloseTo((37570 * 2.5 + 62 * 10) / 1_000_000, 8);
  });

  it('sums multiple turns', () => {
    const u = parseCodexUsage(CODEX_STREAM + CODEX_STREAM, 'gpt-4o');
    expect(u).toMatchObject({ input_tokens: 75140, output_tokens: 124 });
  });

  it('env rates override the table', () => {
    process.env.SQUADS_OPENAI_COST_PER_MTOK_IN = '1';
    process.env.SQUADS_OPENAI_COST_PER_MTOK_OUT = '100';
    expect(parseCodexUsage(CODEX_STREAM, 'gpt-4o')!.cost_usd).toBeCloseTo((37570 + 62 * 100) / 1_000_000, 8);
  });

  it('returns null without a turn.completed event and skips partial lines', () => {
    expect(parseCodexUsage('{"type":"turn.started"}\nplain text')).toBeNull();
    expect(parseCodexUsage('{"type":"turn.completed","usage":{"input_tok')).toBeNull();
  });

  it('is the lane parser', () => {
    expect(LLM_CLIS.openai.parseUsage).toBe(parseCodexUsage);
  });
});

describe('renderCodexLine', () => {
  it('shows agent messages and hides other events', () => {
    const lines = CODEX_STREAM.trim().split('\n');
    expect(lines.map(renderCodexLine).filter(Boolean)).toEqual(['Creating hello.txt.']);
    expect(renderCodexLine('not json "agent_message"')).toBeNull();
  });
});

describe('executeWithProvider openai foreground (stub codex)', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'fg-codex-')));
    const repo = join(root, 'repo');
    mkdirSync(join(repo, '.agents', 'squads', 'demo'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'squads', 'demo', 'tester.md'), '---\nname: tester\nmodel: sonnet\n---\n# tester\n');
    execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m init', { cwd: repo });
    const stub = join(root, 'stub');
    mkdirSync(stub);
    writeFileSync(join(stub, 'stream.jsonl'), CODEX_STREAM);
    writeFileSync(join(stub, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(stub, 'argv.txt')}"\ncat "${join(stub, 'stream.jsonl')}"\nexit 0\n`);
    chmodSync(join(stub, 'codex'), 0o755);
    process.env.PATH = `${stub}:${process.env.PATH}`;
    process.env.CODEX_HOME = join(root, 'codex-home');
    delete process.env.OPENAI_MODEL;
    vi.spyOn(process, 'cwd').mockReturnValue(repo);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    rmSync(root, { recursive: true, force: true });
  });

  async function run(model: string): Promise<{ done: Record<string, unknown>; argv: string[] }> {
    const { executeWithProvider } = await import('../src/lib/execution-engine.js');
    const repo = join(root, 'repo');
    await executeWithProvider('openai', 'do it', {
      foreground: true, cwd: repo, squadName: 'demo', agentName: 'tester', model, executionId: 'exec_fg_codex',
    }).catch(() => undefined);
    const ledger = readFileSync(join(repo, '.agents', 'observability', 'executions.jsonl'), 'utf-8')
      .trim().split('\n').map((l) => JSON.parse(l));
    const done = ledger.filter((e) => e.status === 'completed' || e.status === 'failed').pop();
    const argv = readFileSync(join(root, 'stub', 'argv.txt'), 'utf-8').trim().split('\n');
    return { done, argv };
  }

  it('records the requested OpenAI model, tokens and cost', async () => {
    const { done, argv } = await run('gpt-4o');
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-4o');
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only'); // no grants passed
    expect(done).toMatchObject({ status: 'completed', provider: 'openai', model: 'gpt-4o', input_tokens: 37570, output_tokens: 62 });
    expect(done.cost_usd as number).toBeGreaterThan(0);
  });

  it('a leaked frontmatter model is neither passed nor recorded', async () => {
    mkdirSync(join(root, 'codex-home'));
    writeFileSync(join(root, 'codex-home', 'config.toml'), 'model = "gpt-6-astra"\n');
    const { done, argv } = await run('sonnet');
    expect(argv).not.toContain('-m');
    expect(done.model).toBe('gpt-6-astra');
    expect(done.input_tokens).toBe(37570);
  });
});
