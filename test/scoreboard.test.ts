import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildScoreboard,
  readExecutionRecords,
  readSquadFeedback,
  renderScoreboard,
  modelFamily,
} from '../src/lib/scoreboard.js';
import type { ObservabilityRecord } from '../src/lib/observability.js';

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const rec = (over: Partial<ObservabilityRecord>): ObservabilityRecord => ({
  ts: new Date().toISOString(), id: 'x', squad: 'cli', agent: 'issue-solver',
  provider: 'anthropic', model: 'claude-sonnet-4-6', trigger: 'manual',
  status: 'completed', duration_ms: 1000,
  input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_write_tokens: 0,
  cost_usd: 1, context_tokens: 0, ...over,
});

describe('modelFamily', () => {
  it('groups dated variants into families across vendors', () => {
    expect(modelFamily('claude-sonnet-4-6')).toBe('sonnet');
    expect(modelFamily('claude-fable-5')).toBe('fable');
    expect(modelFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(modelFamily('deepseek-chat')).toBe('deepseek');
    expect(modelFamily('gpt-5.5-turbo')).toBe('gpt-5.5-turbo');
    expect(modelFamily('qwen2.5-coder')).toBe('qwen');
    expect(modelFamily('glm-4-plus')).toBe('glm');
    expect(modelFamily('')).toBe('unknown');
  });
});

describe('buildScoreboard', () => {
  it('groups by provider × model-family × task class with rates and per-dollar activity', () => {
    const board = buildScoreboard([
      rec({ commits: 2, prs_created: 1, cost_usd: 2 }),
      rec({ commits: 1, prs_created: 0, cost_usd: 1 }),
      rec({ status: 'timeout', cost_usd: 0.5 }),
      rec({ provider: 'deepseek', model: 'deepseek-chat', agent: 'issue-solver', commits: 3, cost_usd: 0.1 }),
    ], { windowDays: 30 });

    expect(board.rows).toHaveLength(2);
    const anthropic = board.rows[0]; // n=3, sorted first
    expect(anthropic.n).toBe(3);
    expect(anthropic.model).toBe('sonnet');
    expect(anthropic.completed).toBe(2);
    expect(anthropic.timeout).toBe(1);
    expect(anthropic.totalCostUsd).toBeCloseTo(3.5);
    expect(anthropic.activityPerUsd).toBeCloseTo(4 / 3.5); // 3 commits + 1 pr

    const deepseek = board.rows[1];
    expect(deepseek.provider).toBe('deepseek');
    expect(deepseek.activityPerUsd).toBeCloseTo(30); // 3 commits / $0.1
  });

  it('near-zero cost rows do not fabricate an infinite per-dollar score', () => {
    const board = buildScoreboard([rec({ cost_usd: 0, commits: 5 })], { windowDays: 30 });
    expect(board.rows[0].activityPerUsd).toBeNull();
  });
});

describe('readExecutionRecords window + malformed tolerance', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'squads-board-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('filters by window and skips malformed lines', () => {
    const obs = join(dir, '.agents', 'observability');
    mkdirSync(obs, { recursive: true });
    const old = rec({ ts: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString() });
    const fresh = rec({});
    writeFileSync(join(obs, 'executions.jsonl'), [JSON.stringify(old), '{broken', JSON.stringify(fresh)].join('\n') + '\n');

    const records = readExecutionRecords(dir, 30);
    expect(records).toHaveLength(1);
  });
});

describe('readSquadFeedback', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'squads-fb-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('parses star ratings per squad from feedback.md', () => {
    mkdirSync(join(dir, 'intelligence'), { recursive: true });
    writeFileSync(join(dir, 'intelligence', 'feedback.md'), [
      '# intelligence - Feedback Log', '',
      '---', '_Date: 2026-06-20_', '', '**Rating**: 4/5 ★★★★☆', '**Feedback**: solid',
      '---', '_Date: 2026-07-01_', '', '**Rating**: 5/5 ★★★★★', '**Feedback**: great brief',
    ].join('\n'));

    const fb = readSquadFeedback(dir);
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ squad: 'intelligence', n: 2, lastDate: '2026-07-01' });
    expect(fb[0].avgRating).toBeCloseTo(4.5);
  });
});

describe('renderScoreboard provenance discipline', () => {
  it('always shows n, the notional-cost caveat, and the proxy warning without --resolve', () => {
    const board = buildScoreboard([rec({}), rec({})], { windowDays: 30 });
    const text = renderScoreboard(board).map(strip).join('\n');
    expect(text).toContain('n=2');
    expect(text).toContain('NOTIONAL');
    expect(text).toContain('directional');
    expect(text).toContain('--resolve');
  });

  it('feedback renders as its own squad-level section, never blended into rows', () => {
    const board = buildScoreboard([rec({})], { windowDays: 30 });
    board.feedback = [{ squad: 'intelligence', n: 2, avgRating: 4.5, lastDate: '2026-07-01' }];
    const text = renderScoreboard(board).map(strip).join('\n');
    expect(text).toContain('never blended');
    expect(text).toContain('4.5/5');
  });

  it('empty window renders an instruction, not a crash', () => {
    const text = renderScoreboard(buildScoreboard([], { windowDays: 7 })).map(strip).join('\n');
    expect(text).toContain('no execution records');
  });
});
