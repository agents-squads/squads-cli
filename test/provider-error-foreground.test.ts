/**
 * #1298 / review of #1333 — the FOREGROUND close path of executeWithProvider
 * (the third classification boundary, next to spool reconcile and the
 * conversation turn). Drives the real spawn with a STUB `claude` on PATH that
 * replays a z.ai-style failed stream, then reads the ledger and events file.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

vi.mock('../src/lib/api-client.js', () => ({
  reportExecutionStart: vi.fn().mockResolvedValue(true),
  reportExecutionComplete: vi.fn().mockResolvedValue(true),
  reportExecutionEvents: vi.fn().mockResolvedValue(true),
}));

const GLM_1309 = 'API Error: 429 {"error":{"code":"1309","message":"Your Coding Plan package has expired, please renew."}}';

let root: string;
let prevEnv: NodeJS.ProcessEnv;

function installStubClaude(resultText: string, isError: boolean, exitCode: number): void {
  const stub = join(root, 'stub');
  mkdirSync(stub);
  const stream = [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'starting' }], model: 'glm-4.7' } }),
    JSON.stringify({ type: 'result', subtype: isError ? 'error_during_execution' : 'success', result: resultText, is_error: isError,
      total_cost_usd: 0, num_turns: 1, model: 'glm-4.7', usage: { input_tokens: 0, output_tokens: 0 } }),
  ].join('\n') + '\n';
  writeFileSync(join(stub, 'stream.jsonl'), stream);
  const bin = join(stub, 'claude');
  writeFileSync(bin, `#!/bin/sh\ncat "${join(stub, 'stream.jsonl')}"\nexit ${exitCode}\n`);
  chmodSync(bin, 0o755);
  process.env.PATH = `${stub}:${process.env.PATH}`;
}

beforeEach(() => {
  prevEnv = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'fg-provider-err-')));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.agents', 'squads', 'demo'), { recursive: true });
  writeFileSync(join(repo, '.agents', 'squads', 'demo', 'tester.md'), '---\nname: tester\n---\n# tester\n');
  execSync('git init -q -b main && git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m init', { cwd: repo });
  process.env.GLM_API_KEY = 'test-key';
  vi.spyOn(process, 'cwd').mockReturnValue(repo);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  process.env = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

async function runGlm(): Promise<{ done: Record<string, unknown>; events: Array<{ event: Record<string, unknown> }> }> {
  const { executeWithProvider } = await import('../src/lib/execution-engine.js');
  const repo = join(root, 'repo');
  await executeWithProvider('glm', 'do it', {
    foreground: true, cwd: repo, squadName: 'demo', agentName: 'tester', executionId: 'exec_fg_glm',
  }).catch(() => undefined);

  const ledger = readFileSync(join(repo, '.agents', 'observability', 'executions.jsonl'), 'utf-8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const done = ledger.filter((e) => e.status === 'completed' || e.status === 'failed').pop();
  const evDir = join(repo, '.agents', 'observability', 'events');
  const evFile = existsSync(evDir) ? readdirSync(evDir).find((f) => f.includes('exec_fg_glm')) : undefined;
  const events = evFile
    ? readFileSync(join(evDir, evFile), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    : [];
  return { done, events };
}

describe('executeWithProvider foreground (stub claude)', () => {
  it('records plan_expired in the ledger and exactly one error event before run_end', async () => {
    installStubClaude(GLM_1309, true, 1);
    const { done, events } = await runGlm();

    expect(done.status).toBe('failed');
    expect(done.provider_error).toMatchObject({ type: 'plan_expired', retryable: false, provider: 'glm', status: 429, providerCode: '1309' });
    expect(String(done.error)).toContain('plan_expired');

    const types = events.map((e) => e.event.type);
    expect(types.filter((t) => t === 'error')).toHaveLength(1);
    expect(types.indexOf('error')).toBeLessThan(types.lastIndexOf('run_end'));
  });

  it('a failed run whose result is prose (is_error:false) stays unclassified', async () => {
    installStubClaude('Documented HTTP 401 handling: the request was unauthorized. All tests pass.', false, 1);
    const { done, events } = await runGlm();

    expect(done.status).toBe('failed');
    expect(done.provider_error).toBeUndefined();
    expect(events.filter((e) => e.event.type === 'error')).toHaveLength(0);
  });
});
