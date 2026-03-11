import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { formatCostBar, calculateROIMetrics, calculateSquadCostProjections } from '../src/lib/costs.js';
import { detectPlan, getPlanType, isMaxPlan, getPlanDescription } from '../src/lib/plan.js';
import type { BridgeStats } from '../src/lib/costs.js';

// Model pricing (per 1M tokens) - same as in costs.ts
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.0 },
  default: { input: 3.0, output: 15.0 },
};

// Pure cost calculation function (extracted for testing)
function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.default;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

describe('costs utilities', () => {
  describe('calcCost', () => {
    it('calculates cost for claude-opus-4-5', () => {
      // 1M input + 1M output at opus pricing
      const cost = calcCost('claude-opus-4-5-20251101', 1_000_000, 1_000_000);
      expect(cost).toBe(15.0 + 75.0); // $90
    });

    it('calculates cost for claude-sonnet-4', () => {
      // 1M input + 1M output at sonnet pricing
      const cost = calcCost('claude-sonnet-4-20250514', 1_000_000, 1_000_000);
      expect(cost).toBe(3.0 + 15.0); // $18
    });

    it('calculates cost for claude-haiku', () => {
      // 1M input + 1M output at haiku pricing
      const cost = calcCost('claude-haiku-4-5-20251001', 1_000_000, 1_000_000);
      expect(cost).toBe(0.80 + 4.0); // $4.80
    });

    it('uses default pricing for unknown models', () => {
      const cost = calcCost('unknown-model', 1_000_000, 1_000_000);
      expect(cost).toBe(3.0 + 15.0); // $18 (default)
    });

    it('handles small token counts', () => {
      // 1000 input + 500 output at sonnet pricing
      const cost = calcCost('claude-sonnet-4-20250514', 1000, 500);
      const expected = (1000 / 1_000_000) * 3.0 + (500 / 1_000_000) * 15.0;
      expect(cost).toBeCloseTo(expected);
    });

    it('handles zero tokens', () => {
      const cost = calcCost('claude-sonnet-4-20250514', 0, 0);
      expect(cost).toBe(0);
    });

    it('calculates typical conversation cost', () => {
      // Typical conversation: 5000 input, 2000 output
      const cost = calcCost('claude-sonnet-4-20250514', 5000, 2000);
      const expected = (5000 / 1_000_000) * 3.0 + (2000 / 1_000_000) * 15.0;
      expect(cost).toBeCloseTo(expected);
      // ~$0.015 + ~$0.03 = ~$0.045
    });
  });

  describe('model pricing constants', () => {
    it('has pricing for all current claude models', () => {
      expect(MODEL_PRICING['claude-opus-4-5-20251101']).toBeDefined();
      expect(MODEL_PRICING['claude-sonnet-4-20250514']).toBeDefined();
      expect(MODEL_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
    });

    it('has default fallback pricing', () => {
      expect(MODEL_PRICING.default).toBeDefined();
      expect(MODEL_PRICING.default.input).toBe(3.0);
      expect(MODEL_PRICING.default.output).toBe(15.0);
    });

    it('opus is most expensive', () => {
      expect(MODEL_PRICING['claude-opus-4-5-20251101'].output)
        .toBeGreaterThan(MODEL_PRICING['claude-sonnet-4-20250514'].output);
    });

    it('haiku is cheapest', () => {
      expect(MODEL_PRICING['claude-haiku-4-5-20251001'].output)
        .toBeLessThan(MODEL_PRICING['claude-sonnet-4-20250514'].output);
    });
  });
});

// ── formatCostBar ───────────────────────────────────────────────────

describe('formatCostBar', () => {
  it('returns all filled at 100%', () => {
    const bar = formatCostBar(100, 10);
    expect(bar).toBe('█'.repeat(10));
  });

  it('returns all empty at 0%', () => {
    const bar = formatCostBar(0, 10);
    expect(bar).toBe('░'.repeat(10));
  });

  it('returns half filled at 50%', () => {
    const bar = formatCostBar(50, 10);
    expect(bar).toBe('█'.repeat(5) + '░'.repeat(5));
  });

  it('uses default width of 20', () => {
    const bar = formatCostBar(0);
    expect(bar).toHaveLength(20);
  });

  it('clamps at width when over 100%', () => {
    const bar = formatCostBar(200, 10);
    expect(bar).toBe('█'.repeat(10));
  });

  it('rounds to nearest character', () => {
    // 33% of 10 = 3.3 → rounds to 3
    const bar = formatCostBar(33, 10);
    expect(bar).toBe('█'.repeat(3) + '░'.repeat(7));
  });

  it('always returns string of exact width', () => {
    for (const pct of [0, 25, 50, 75, 100]) {
      const bar = formatCostBar(pct, 20);
      expect(bar).toHaveLength(20);
    }
  });
});

// ── calculateROIMetrics ─────────────────────────────────────────────

describe('calculateROIMetrics', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.SQUADS_GOAL_VALUE = process.env.SQUADS_GOAL_VALUE;
    savedEnv.SQUADS_PR_VALUE = process.env.SQUADS_PR_VALUE;
    savedEnv.SQUADS_COMMIT_VALUE = process.env.SQUADS_COMMIT_VALUE;
    delete process.env.SQUADS_GOAL_VALUE;
    delete process.env.SQUADS_PR_VALUE;
    delete process.env.SQUADS_COMMIT_VALUE;
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it('returns zero metrics when no costs or activity', () => {
    const metrics = calculateROIMetrics(null, 0, 0, 0, 8);
    expect(metrics.totalCostUsd).toBe(0);
    expect(metrics.costPerGoal).toBe(0);
    expect(metrics.costPerCommit).toBe(0);
    expect(metrics.costPerPR).toBe(0);
    expect(metrics.roiMultiplier).toBe(0);
  });

  it('calculates cost per goal correctly', () => {
    const costs = { totalCost: 10 } as any;
    const metrics = calculateROIMetrics(costs, 5, 0, 0, 8);
    expect(metrics.costPerGoal).toBe(2); // $10 / 5 goals
  });

  it('calculates cost per commit correctly', () => {
    const costs = { totalCost: 100 } as any;
    const metrics = calculateROIMetrics(costs, 0, 10, 0, 8);
    expect(metrics.costPerCommit).toBe(10); // $100 / 10 commits
  });

  it('calculates cost per PR correctly', () => {
    const costs = { totalCost: 50 } as any;
    const metrics = calculateROIMetrics(costs, 0, 0, 5, 8);
    expect(metrics.costPerPR).toBe(10); // $50 / 5 PRs
  });

  it('calculates estimated value with defaults (goal=$100, PR=$200, commit=$25)', () => {
    const costs = { totalCost: 0 } as any;
    const metrics = calculateROIMetrics(costs, 1, 1, 1, 8);
    // 1 goal * $100 + 1 PR * $200 + 1 commit * $25 = $325
    expect(metrics.estimatedValueUsd).toBe(325);
  });

  it('respects custom env values for goal/pr/commit pricing', () => {
    process.env.SQUADS_GOAL_VALUE = '50';
    process.env.SQUADS_PR_VALUE = '100';
    process.env.SQUADS_COMMIT_VALUE = '10';
    const costs = { totalCost: 0 } as any;
    const metrics = calculateROIMetrics(costs, 1, 1, 1, 8);
    expect(metrics.estimatedValueUsd).toBe(160); // 50 + 100 + 10
  });

  it('calculates ROI multiplier', () => {
    const costs = { totalCost: 100 } as any;
    // 1 PR = $200 value, cost = $100 → ROI = 2x
    const metrics = calculateROIMetrics(costs, 0, 0, 1, 8);
    expect(metrics.roiMultiplier).toBe(2);
  });

  it('projects daily/weekly/monthly costs from hourly rate', () => {
    const costs = { totalCost: 24 } as any;
    // $24 spent in 24 hours = $1/hr
    const metrics = calculateROIMetrics(costs, 0, 0, 0, 24);
    expect(metrics.costPerHour).toBeCloseTo(1);
    expect(metrics.dailyProjectedCost).toBeCloseTo(24);
    expect(metrics.weeklyProjectedCost).toBeCloseTo(168);
    expect(metrics.monthlyProjectedCost).toBeCloseTo(720);
  });

  it('handles null costs gracefully', () => {
    const metrics = calculateROIMetrics(null, 2, 5, 1, 8);
    expect(metrics.totalCostUsd).toBe(0);
    expect(metrics.estimatedValueUsd).toBe(2 * 100 + 5 * 25 + 1 * 200); // 725
  });

  it('returns hoursTracked from parameter', () => {
    const metrics = calculateROIMetrics(null, 0, 0, 0, 10);
    expect(metrics.hoursTracked).toBe(10);
  });
});

// ── calculateSquadCostProjections ───────────────────────────────────

describe('calculateSquadCostProjections', () => {
  it('returns empty array when bridgeStats is null', () => {
    const result = calculateSquadCostProjections(null, null);
    expect(result).toEqual([]);
  });

  it('returns empty array when bySquad is empty', () => {
    const stats = { bySquad: [] } as unknown as BridgeStats;
    const result = calculateSquadCostProjections(stats, null);
    expect(result).toEqual([]);
  });

  it('returns projections for each squad', () => {
    const stats = {
      bySquad: [
        { squad: 'engineering', costUsd: 10, generations: 5 },
        { squad: 'marketing', costUsd: 5, generations: 2 },
      ],
    } as unknown as BridgeStats;
    const result = calculateSquadCostProjections(stats, null);
    expect(result).toHaveLength(2);
    expect(result[0].squad).toBe('engineering');
    expect(result[1].squad).toBe('marketing');
  });

  it('includes all required projection fields', () => {
    const stats = {
      bySquad: [{ squad: 'cli', costUsd: 12, generations: 10 }],
    } as unknown as BridgeStats;
    const result = calculateSquadCostProjections(stats, null);
    const proj = result[0];
    expect(proj).toHaveProperty('squad', 'cli');
    expect(proj).toHaveProperty('currentDailyCost', 12);
    expect(proj).toHaveProperty('projectedDailyCost');
    expect(proj).toHaveProperty('projectedWeeklyCost');
    expect(proj).toHaveProperty('projectedMonthlyCost');
    expect(proj).toHaveProperty('costTrend', 'stable');
    expect(proj).toHaveProperty('trendPct', 0);
  });

  it('projects weekly as ~7x daily projected', () => {
    const stats = {
      bySquad: [{ squad: 'test', costUsd: 24, generations: 1 }],
    } as unknown as BridgeStats;
    const result = calculateSquadCostProjections(stats, null);
    const proj = result[0];
    expect(proj.projectedWeeklyCost).toBeCloseTo(proj.projectedDailyCost * 7, 0);
  });

  it('projects monthly as ~30x daily projected', () => {
    const stats = {
      bySquad: [{ squad: 'test', costUsd: 24, generations: 1 }],
    } as unknown as BridgeStats;
    const result = calculateSquadCostProjections(stats, null);
    const proj = result[0];
    expect(proj.projectedMonthlyCost).toBeCloseTo(proj.projectedDailyCost * 30, 0);
  });
});

// ── detectPlan / getPlanType / isMaxPlan / getPlanDescription ───────

describe('plan detection', () => {
  const envKeys = ['SQUADS_PLAN_TYPE', 'ANTHROPIC_BUDGET_DAILY', 'SQUADS_DAILY_BUDGET', 'ANTHROPIC_TIER', 'ANTHROPIC_API_KEY'];
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  describe('detectPlan', () => {
    it('returns usage when SQUADS_PLAN_TYPE=usage', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('explicit');
    });

    it('returns max when SQUADS_PLAN_TYPE=max', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('explicit');
    });

    it('returns usage when ANTHROPIC_BUDGET_DAILY is set', () => {
      process.env.ANTHROPIC_BUDGET_DAILY = '50';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('inferred');
    });

    it('returns usage when SQUADS_DAILY_BUDGET is set', () => {
      process.env.SQUADS_DAILY_BUDGET = '25';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('inferred');
    });

    it('returns max for tier 4', () => {
      process.env.ANTHROPIC_TIER = '4';
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('inferred');
    });

    it('returns max for tier 5', () => {
      process.env.ANTHROPIC_TIER = '5';
      const result = detectPlan();
      expect(result.plan).toBe('max');
    });

    it('returns usage for tier 1', () => {
      process.env.ANTHROPIC_TIER = '1';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('inferred');
    });

    it('returns usage for tier 2', () => {
      process.env.ANTHROPIC_TIER = '2';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
    });

    it('returns max when no API key set (OAuth/subscription)', () => {
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('inferred');
    });

    it('returns usage when API key is set with no other signals', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
    });

    it('explicit config overrides budget signals', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      process.env.ANTHROPIC_BUDGET_DAILY = '50'; // would normally imply usage
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('explicit');
    });

    it('includes non-empty reason in result', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      const result = detectPlan();
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe('getPlanType', () => {
    it('returns a valid plan type', () => {
      const plan = getPlanType();
      expect(['max', 'usage', 'unknown']).toContain(plan);
    });

    it('returns max when explicitly set', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      expect(getPlanType()).toBe('max');
    });

    it('returns usage when explicitly set', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      expect(getPlanType()).toBe('usage');
    });
  });

  describe('isMaxPlan', () => {
    it('returns true when plan is max', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      expect(isMaxPlan()).toBe(true);
    });

    it('returns false when plan is usage', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      expect(isMaxPlan()).toBe(false);
    });
  });

  describe('getPlanDescription', () => {
    it('returns non-empty string for max plan', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      const desc = getPlanDescription();
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
    });

    it('returns non-empty string for usage plan', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      const desc = getPlanDescription();
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
    });

    it('includes "Max" in description for max plan', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      expect(getPlanDescription()).toContain('Max');
    });

    it('includes usage info for usage plan', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      expect(getPlanDescription().toLowerCase()).toContain('usage');
    });
  });
});
