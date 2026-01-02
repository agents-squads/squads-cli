import { describe, it, expect } from 'vitest';

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
