import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { streamEventsFromLog } from '../src/lib/event-follow.js';

const ocLine = (type: string, part: Record<string, unknown>) =>
  JSON.stringify({ type, timestamp: 1, sessionID: 'ses_x', part });

const readTypes = (file: string): string[] =>
  readFileSync(file, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { event: { type: string } }).event.type);

describe('streamEventsFromLog (#1353)', () => {
  it('appends events as lines land, not buffered until exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stream-events-'));
    try {
      const logFile = join(dir, 'lane.jsonl');
      const eventsFile = join(dir, 'events.jsonl');
      const doneFile = join(dir, 'lane.jsonl.live-done');

      const done = streamEventsFromLog({
        harness: 'opencode',
        eventsFile,
        runId: 'exec_stream_1',
        provider: 'deepseek',
        agent: 'builder',
        logFile,
        doneFile,
        pollMs: 10,
      });

      writeFileSync(logFile, ocLine('tool_use', {
        type: 'tool', tool: 'bash', callID: 'c1',
        state: { status: 'completed', input: { command: 'ls' }, output: 'ok' },
      }) + '\n');
      await new Promise((r) => setTimeout(r, 60));
      expect(readTypes(eventsFile)).toEqual(['tool_call', 'tool_result']);

      appendFileSync(logFile, ocLine('step_finish', { reason: 'stop', tokens: { input: 5, output: 2 } }) + '\n');
      await new Promise((r) => setTimeout(r, 60));
      const types = readTypes(eventsFile);
      expect(types).toContain('usage_running');
      expect(types).toContain('token_usage');

      writeFileSync(doneFile, '');
      await done;

      expect(readTypes(eventsFile)).toEqual(['tool_call', 'tool_result', 'usage_running', 'token_usage']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildLiveStreamShell (#1353)', () => {
  it('embeds the harness, paths and identity into spawn + finish snippets', async () => {
    const { buildLiveStreamShell } = await import('../src/lib/execution-engine.js');
    const { spawn: spawnCmd, finish: finishCmd } = buildLiveStreamShell({
      harness: 'opencode',
      eventsFile: '/obs/.agents/observability/events/exec_1.jsonl',
      runId: 'exec_1',
      provider: 'deepseek',
      agent: 'builder',
      logFile: '/obs/.agents/logs/eng/builder-1.log',
      doneFile: '/obs/.agents/logs/eng/builder-1.log.live-done',
    });

    expect(spawnCmd).toContain('_stream-events');
    expect(spawnCmd).toContain("'--harness' 'opencode'");
    expect(spawnCmd).toContain('exec_1.jsonl');
    expect(spawnCmd).toContain("'--run-id' 'exec_1'");
    expect(spawnCmd).toContain("'--provider' 'deepseek'");
    expect(spawnCmd).toContain("'--agent' 'builder'");
    expect(spawnCmd).toContain('STREAM_PID=$!');

    expect(finishCmd).toContain('touch');
    expect(finishCmd).toContain('.live-done');
    expect(finishCmd).toContain('wait $STREAM_PID');
  });
});

