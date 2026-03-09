import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { detectPlan, getPlanType, isMaxPlan, PlanDetection } from '../src/lib/costs.js';

describe('plan type detection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Create a clean env for each test
    process.env = { ...originalEnv };
    // Clear all plan-related env vars
    delete process.env.SQUADS_PLAN_TYPE;
    delete process.env.ANTHROPIC_BUDGET_DAILY;
    delete process.env.SQUADS_DAILY_BUDGET;
    delete process.env.ANTHROPIC_TIER;
    // Clear API key so default tests use OAuth path (no API key = subscription)
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('detectPlan - explicit configuration', () => {
    it('returns explicit max when SQUADS_PLAN_TYPE=max', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('explicit');
      expect(result.reason).toBe('SQUADS_PLAN_TYPE=max');
    });

    it('returns explicit usage when SQUADS_PLAN_TYPE=usage', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('explicit');
      expect(result.reason).toBe('SQUADS_PLAN_TYPE=usage');
    });

    it('handles case insensitivity', () => {
      process.env.SQUADS_PLAN_TYPE = 'USAGE';
      expect(detectPlan().plan).toBe('usage');

      process.env.SQUADS_PLAN_TYPE = 'MAX';
      expect(detectPlan().plan).toBe('max');
    });
  });

  describe('detectPlan - budget inference', () => {
    it('infers usage plan when ANTHROPIC_BUDGET_DAILY is set', () => {
      process.env.ANTHROPIC_BUDGET_DAILY = '50';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('inferred');
      expect(result.reason).toContain('Budget set');
    });

    it('infers usage plan when SQUADS_DAILY_BUDGET is set', () => {
      process.env.SQUADS_DAILY_BUDGET = '100';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('inferred');
    });

    it('explicit config overrides budget inference', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      process.env.ANTHROPIC_BUDGET_DAILY = '50';
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('explicit');
    });
  });

  describe('detectPlan - tier inference', () => {
    it('infers max plan for Tier 4', () => {
      process.env.ANTHROPIC_TIER = '4';
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('inferred');
      expect(result.reason).toContain('Tier 4');
    });

    it('infers usage plan for Tier 1 (new user)', () => {
      process.env.ANTHROPIC_TIER = '1';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('inferred');
      expect(result.reason).toContain('Tier 1');
    });

    it('infers usage plan for Tier 2 (new user)', () => {
      process.env.ANTHROPIC_TIER = '2';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('inferred');
    });

    it('budget takes priority over tier', () => {
      process.env.ANTHROPIC_TIER = '4';
      process.env.ANTHROPIC_BUDGET_DAILY = '50';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.reason).toContain('Budget set');
    });
  });

  describe('detectPlan - defaults', () => {
    it('defaults to max plan for OAuth users (no API key = subscription)', () => {
      // No API key = OAuth (Claude Code subscription) = max plan
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('inferred');
      expect(result.reason).toContain('OAuth');
    });

    it('defaults to usage plan when API key is set with no other signals', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const result = detectPlan();
      expect(result.plan).toBe('usage');
      expect(result.confidence).toBe('inferred');
    });

    it('defaults to max for Tier 3 OAuth users (no API key)', () => {
      process.env.ANTHROPIC_TIER = '3';
      const result = detectPlan();
      expect(result.plan).toBe('max');
      expect(result.confidence).toBe('inferred');
    });
  });

  describe('getPlanType', () => {
    it('returns the plan from detectPlan', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      expect(getPlanType()).toBe('usage');

      process.env.SQUADS_PLAN_TYPE = 'max';
      expect(getPlanType()).toBe('max');
    });
  });

  describe('isMaxPlan', () => {
    it('returns true for max plan', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      expect(isMaxPlan()).toBe(true);
    });

    it('returns false for usage plan', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      expect(isMaxPlan()).toBe(false);
    });

    it('returns true by default for OAuth users (no API key = subscription = max)', () => {
      expect(isMaxPlan()).toBe(true);
    });
  });

  describe('budget display behavior', () => {
    it('max plan should not show budget warnings', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      const maxPlan = isMaxPlan();
      const usedPercent = 159; // Over 100%

      // On max plan, we should NOT show warnings regardless of percentage
      const shouldShowWarning = !maxPlan && usedPercent > 80;
      expect(shouldShowWarning).toBe(false);
    });

    it('usage plan should show budget warnings when over threshold', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      const maxPlan = isMaxPlan();
      const usedPercent = 159;

      // On usage plan, we SHOULD show warnings when over 80%
      const shouldShowWarning = !maxPlan && usedPercent > 80;
      expect(shouldShowWarning).toBe(true);
    });
  });
});
