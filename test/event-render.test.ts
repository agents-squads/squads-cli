import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { renderEvent, renderPersistedEvent, parsePersistedLine } from '../src/lib/event-render.js';
import { followProviderLog } from '../src/lib/event-follow.js';
import type { ExecEvent, PersistedExecEvent } from '../src/lib/exec-events.js';

// Strip ANSI codes so assertions read the words, not the palette.
// eslint-disable-next-line no-control-regex
const strip = (s: string | null) => (s === null ? null : s.replace(/\x1b\[[0-9;]*m/g, ''));

describe('renderEvent — the activity feed lines (#903)', () => {
  it('renders run lifecycle, files, web, and artifacts as human lines', () => {
    expect(strip(renderEvent({ type: 'run_start', squad: 'demo', agent: 'hello', mode: 'background', model: 'haiku', role: 'worker', startedAt: 'x' })))
      .toContain('demo/hello');
    expect(strip(renderEvent({ type: 'file_read', path: 'src/a.ts' }))).toBe('read src/a.ts');
    expect(strip(renderEvent({ type: 'file_write', path: 'src/b.ts', bytes: 2048 }))).toContain('wrote src/b.ts (2.0kb)');
    expect(strip(renderEvent({ type: 'web_fetch', url: 'duckdb upsert' }))).toContain('web duckdb upsert');
    expect(strip(renderEvent({ type: 'artifact', kind: 'pr', ref: 'gh pr create --base develop' }))).toContain('✚ pr');
    expect(strip(renderEvent({ type: 'subagent_spawn', childRunId: 'a1', squad: '', agent: 'profiler', task: 'research' }))).toContain('spawned profiler — research');
    expect(strip(renderEvent({ type: 'subagent_done', childRunId: 'a1', agent: 'profiler', ok: true }))).toContain('profiler done');
  });

  it('suppresses noise: specialized tool_calls and ok tool_results render null', () => {
    expect(renderEvent({ type: 'tool_call', tool: 'Read', inputSummary: 'a.ts' })).toBeNull();
    expect(renderEvent({ type: 'tool_call', tool: 'WebSearch', inputSummary: 'q' })).toBeNull();
    expect(renderEvent({ type: 'tool_result', tool: 'Bash', ok: true, summary: 'fine' })).toBeNull();
    // Generic tools and failures DO render.
    expect(strip(renderEvent({ type: 'tool_call', tool: 'Bash', inputSummary: 'npm test' }))).toContain('Bash npm test');
    expect(strip(renderEvent({ type: 'tool_result', tool: 'Bash', ok: false, summary: 'exit 1' }))).toContain('Bash failed');
  });

  it('summarizes context, usage, run_end, and truncation', () => {
    expect(strip(renderEvent({
      type: 'context_assembled',
      layers: [
        { layer: 3, name: 'Goals', chars: 400, tokensEst: 100, evicted: false },
        { layer: 7, name: 'Briefing', chars: 0, tokensEst: 0, evicted: true },
      ],
      totalTokensEst: 100, budgetTokens: 15000,
    }))).toContain('1 layers, ~100 tokens (budget 15.0k) · 1 evicted');
    expect(strip(renderEvent({ type: 'token_usage', input: 1500, output: 80, cacheRead: 33152, cacheWrite: 0, costEst: 0.0179, model: 'haiku' })))
      .toContain('1.5k in / 80 out');
    expect(strip(renderEvent({
      type: 'run_end', ok: true, durationMs: 4000,
      totalUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costEst: 0.02 },
      outcomes: { actions: 3, files_edited: 1, commits: 2, prs_created: 1, issues_created: 0 },
    }))).toContain('completed in 4s · $0.0200 · 2 commits, 1 PR, 1 file edited');
    expect(strip(renderEvent({ type: 'truncated', droppedCount: 8, reason: 'cap' }))).toContain('8 events dropped');
  });
});

describe('renderPersistedEvent — replay view with lanes + relative time', () => {
  const persisted = (event: ExecEvent, ts: string, agent?: string): PersistedExecEvent =>
    ({ v: 1, runId: 'exec_x', seq: 0, ts, ...(agent ? { agent } : {}), event });

  it('prefixes the agent lane and a +Ns stamp', () => {
    const t0 = Date.parse('2026-07-01T00:00:00.000Z');
    const line = strip(renderPersistedEvent(
      persisted({ type: 'file_read', path: 'a.ts' }, '2026-07-01T00:00:02.300Z', 'builder'), t0,
    ));
    expect(line).toContain('+2.3s');
    expect(line).toContain('builder │');
    expect(line).toContain('read a.ts');
  });

  it('returns null for noise events so replay stays legible', () => {
    const t0 = Date.parse('2026-07-01T00:00:00.000Z');
    expect(renderPersistedEvent(
      persisted({ type: 'tool_result', tool: 'Read', ok: true, summary: '' }, '2026-07-01T00:00:01Z'), t0,
    )).toBeNull();
  });
});

describe('parsePersistedLine', () => {
  it('parses valid envelope lines and rejects malformed ones', () => {
    const good = JSON.stringify({ v: 1, runId: 'r', seq: 0, ts: '2026-07-01T00:00:00Z', event: { type: 'file_read', path: 'a' } });
    expect(parsePersistedLine(good)?.event.type).toBe('file_read');
    expect(parsePersistedLine('')).toBeNull();
    expect(parsePersistedLine('not json')).toBeNull();
    expect(parsePersistedLine(JSON.stringify({ v: 2, event: { type: 'x' } }))).toBeNull();
    expect(parsePersistedLine(JSON.stringify({ v: 1, runId: 'r', seq: 0, ts: 'x' }))).toBeNull();
  });
});

describe('followProviderLog — live feed from a growing stream-json log', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'squads-follow-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const assistantToolUse = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }] },
  });
  const resultLine = JSON.stringify({
    type: 'result', subtype: 'success', result: 'ok', is_error: false, total_cost_usd: 0.01,
    usage: { input_tokens: 5, output_tokens: 3 }, num_turns: 1,
  });

  it('renders appended lines as they land and ends when the pid file disappears', async () => {
    const logFile = join(dir, 'run.log');
    const pidFile = join(dir, 'run.pid');
    writeFileSync(logFile, '');
    writeFileSync(pidFile, '123');

    const seen: string[] = [];
    const follower = followProviderLog(logFile, {
      pidFile, pollMs: 20, onLine: (l) => seen.push(strip(l)!),
    });

    appendFileSync(logFile, assistantToolUse + '\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(seen.some((l) => l.includes('read /repo/a.ts'))).toBe(true);

    // Run ends: result line + wrapper removes the pid file.
    appendFileSync(logFile, resultLine + '\n');
    unlinkSync(pidFile);
    await follower.done;
    expect(seen.some((l) => l.includes('5 in / 3 out'))).toBe(true);
  });

  it('handles a log that does not exist yet, then appears', async () => {
    const logFile = join(dir, 'late.log');
    const pidFile = join(dir, 'late.pid');
    writeFileSync(pidFile, '123');

    const seen: string[] = [];
    const follower = followProviderLog(logFile, {
      pidFile, pollMs: 20, onLine: (l) => seen.push(strip(l)!),
    });

    await new Promise((r) => setTimeout(r, 50)); // file not there yet — no crash
    writeFileSync(logFile, assistantToolUse + '\n');
    await new Promise((r) => setTimeout(r, 80));
    expect(seen.some((l) => l.includes('read /repo/a.ts'))).toBe(true);

    follower.stop();
    await follower.done;
  });

  it('stop() drains a trailing partial line before resolving', async () => {
    const logFile = join(dir, 'partial.log');
    writeFileSync(logFile, assistantToolUse + '\n' + resultLine); // no trailing newline

    const seen: string[] = [];
    const follower = followProviderLog(logFile, { pollMs: 20, onLine: (l) => seen.push(strip(l)!) });
    await new Promise((r) => setTimeout(r, 60));
    follower.stop();
    await follower.done;
    expect(seen.some((l) => l.includes('5 in / 3 out'))).toBe(true);
  });
});
