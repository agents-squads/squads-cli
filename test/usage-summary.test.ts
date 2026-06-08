/**
 * Tests for the local-first usage rollup in src/lib/observability.ts —
 * localUsageSummary / avgCostPerRun / todayCostUsd read straight from
 * .agents/observability/executions.jsonl (no Bridge).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_ROOT = join(tmpdir(), `squads-usage-test-${Date.now()}`);
const OBS_DIR = join(TEST_ROOT, '.agents', 'observability');
const LOG_PATH = join(OBS_DIR, 'executions.jsonl');

// findProjectRoot drives getLogPath() inside observability.ts.
vi.mock('../src/lib/squad-parser.js', () => ({
  findProjectRoot: () => TEST_ROOT,
}));

import { localUsageSummary, avgCostPerRun, todayCostUsd } from '../src/lib/observability.js';

function rec(over: Record<string, unknown>): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    id: 'x', squad: 'cli', agent: 'cli-lead', provider: 'anthropic', model: 'sonnet',
    trigger: 'scheduled', status: 'completed', duration_ms: 1000,
    input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
    cost_usd: 0, context_tokens: 0,
    ...over,
  });
}

describe('local usage summary', () => {
  beforeEach(() => {
    mkdirSync(OBS_DIR, { recursive: true });
    const now = Date.now();
    const hr = 60 * 60 * 1000;
    const lines = [
      // within window + today
      rec({ squad: 'cli', cost_usd: 0.5, input_tokens: 100, output_tokens: 50, ts: new Date(now - 1 * hr).toISOString() }),
      rec({ squad: 'website', cost_usd: 1.0, input_tokens: 200, output_tokens: 80, ts: new Date(now - 2 * hr).toISOString() }),
      // today but OUTSIDE a 5h window (e.g. 8h ago, still same calendar day if early)
      rec({ squad: 'cli', cost_usd: 0.25, input_tokens: 40, output_tokens: 10, ts: new Date(now - 8 * hr).toISOString() }),
      // long ago (neither today nor window) — only counts if it happens to be same day
      rec({ squad: 'finance', cost_usd: 99, ts: new Date(now - 1000 * hr).toISOString() }),
      // zero-cost run (counts toward runs but not avg)
      rec({ squad: 'cli', cost_usd: 0, ts: new Date(now - 30 * 60 * 1000).toISOString() }),
    ];
    writeFileSync(LOG_PATH, lines.join('\n') + '\n');
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('sums the rolling window (last 5h) cost', () => {
    const s = localUsageSummary(5);
    // window: 0.5 + 1.0 + 0 (the 30-min zero-cost) = 1.5; the 8h-ago + 1000h-ago excluded
    expect(s.window.cost_usd).toBeCloseTo(1.5, 4);
    expect(s.windowHours).toBe(5);
    // tokens in window: (100+50) + (200+80) + 0 = 430
    expect(s.window.input_tokens + s.window.output_tokens).toBe(430);
  });

  it('produces a per-squad breakdown sorted by cost', () => {
    const s = localUsageSummary(5);
    const squads = s.bySquad.map((b) => b.squad);
    // website (1.0) should rank above cli (0.5 + maybe more) — assert presence + order by cost
    expect(squads).toContain('cli');
    expect(squads).toContain('website');
    const costs = s.bySquad.map((b) => b.cost_usd);
    const sorted = [...costs].sort((a, b) => b - a);
    expect(costs).toEqual(sorted);
  });

  it('avgCostPerRun ignores zero-cost runs and averages the rest', () => {
    // Over 24h: nonzero costs within 24h = 0.5, 1.0, 0.25 → avg 0.5833...
    const avg = avgCostPerRun(24, 0.75);
    expect(avg).toBeCloseTo((0.5 + 1.0 + 0.25) / 3, 4);
  });

  it('avgCostPerRun falls back when there is no usable history', () => {
    expect(avgCostPerRun(0.0001, 0.75)).toBe(0.75); // window too small → no records
  });

  it('todayCostUsd returns a non-negative number', () => {
    expect(todayCostUsd()).toBeGreaterThanOrEqual(0);
  });
});
