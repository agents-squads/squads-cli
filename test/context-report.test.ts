import { describe, it, expect } from 'vitest';
import { buildContextReport, renderContextReport } from '../src/lib/context-report.js';
import type { ExecEvent, PersistedExecEvent } from '../src/lib/exec-events.js';

// eslint-disable-next-line no-control-regex
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

let seq = 0;
const ev = (event: ExecEvent, agent?: string): PersistedExecEvent =>
  ({ v: 1, runId: 'exec_report_1', seq: seq++, ts: '2026-07-01T00:00:00Z', ...(agent ? { agent } : {}), event });

const usage = (agent: string, input: number, output: number, cacheRead: number, cost: number): PersistedExecEvent =>
  ev({ type: 'token_usage', input, output, cacheRead, cacheWrite: 100, costEst: cost, model: 'sonnet' }, agent);

describe('buildContextReport (#904)', () => {
  it('aggregates per-agent usage with cache-hit ratio, sorted by cost', () => {
    const report = buildContextReport([
      usage('scanner', 100, 50, 900, 0.01),     // 90% cache hit
      usage('worker', 4000, 2000, 4000, 0.30),  // 50% cache hit — biggest spender
      usage('worker', 1000, 500, 1000, 0.10),   // accumulates onto worker
    ]);

    expect(report.runId).toBe('exec_report_1');
    expect(report.agents.map((a) => a.agent)).toEqual(['worker', 'scanner']); // cost-sorted
    const worker = report.agents[0];
    expect(worker.input).toBe(5000);
    expect(worker.output).toBe(2500);
    expect(worker.cacheHitPct).toBe(50); // 5000 read / (5000 in + 5000 read)
    expect(report.agents[1].cacheHitPct).toBe(90);
    expect(report.totals.costEst).toBeCloseTo(0.41);
    expect(report.totals.input).toBe(5100);
  });

  it('counts tool activity per tool and per agent', () => {
    const report = buildContextReport([
      ev({ type: 'tool_call', tool: 'Bash', inputSummary: 'x' }, 'worker'),
      ev({ type: 'tool_call', tool: 'Bash', inputSummary: 'y' }, 'worker'),
      ev({ type: 'tool_call', tool: 'Read', inputSummary: 'z' }, 'scanner'),
      usage('worker', 10, 5, 0, 0.01),
    ]);
    expect(report.toolCounts).toEqual([
      { tool: 'Bash', calls: 2 },
      { tool: 'Read', calls: 1 },
    ]);
    expect(report.agents.find((a) => a.agent === 'worker')?.toolCalls).toBe(2);
  });

  it('carries per-layer assembly stats including evictions and the budget', () => {
    const report = buildContextReport([
      ev({
        type: 'context_assembled',
        layers: [
          { layer: 9, name: 'Founder Context', chars: 8000, tokensEst: 2000, evicted: false },
          { layer: 3, name: 'Goals', chars: 400, tokensEst: 100, evicted: false },
          { layer: 7, name: 'Daily Briefing', chars: 0, tokensEst: 0, evicted: true },
        ],
        totalTokensEst: 2100,
        budgetTokens: 15000,
      }, 'lead'),
    ]);
    expect(report.layers).toHaveLength(3);
    expect(report.budgetTokens).toBe(15000);
    expect(report.layers.filter((l) => l.evicted)).toHaveLength(1);
  });

  it('surfaces dropped events so a partial report is never silent', () => {
    const report = buildContextReport([
      ev({ type: 'truncated', droppedCount: 42, reason: 'cap' }),
    ]);
    expect(report.droppedEvents).toBe(42);
    const rendered = renderContextReport(report).map(strip).join('\n');
    expect(rendered).toContain('42 events were dropped');
    expect(rendered).toContain('partial');
  });

  it('renders attribution-quality labels (exact vs estimate) and layer bars', () => {
    const rendered = renderContextReport(buildContextReport([
      usage('lead', 1000, 500, 3000, 0.05),
      ev({
        type: 'context_assembled',
        layers: [{ layer: 1, name: 'Company', chars: 2000, tokensEst: 500, evicted: false }],
        totalTokensEst: 500, budgetTokens: 20000,
      }, 'lead'),
    ])).map(strip).join('\n');

    expect(rendered).toContain('provider-reported — exact');
    expect(rendered).toContain('assembly-time estimate');
    expect(rendered).toContain('75% hit'); // 3000/(1000+3000)
    expect(rendered).toContain('L1 Company');
    expect(rendered).toContain('100%');
  });

  it('handles an empty event list without crashing', () => {
    const report = buildContextReport([]);
    expect(report.agents).toEqual([]);
    expect(renderContextReport(report).map(strip).join('\n')).toContain('no token_usage events');
  });
});
