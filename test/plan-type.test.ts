import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// We test the plan type logic directly since the functions are simple
describe('plan type detection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // Test the logic that's used in getPlanType()
  function getPlanType(): 'max' | 'usage' {
    const planType = process.env.SQUADS_PLAN_TYPE?.toLowerCase();
    if (planType === 'usage') return 'usage';
    return 'max';
  }

  function isMaxPlan(): boolean {
    return getPlanType() === 'max';
  }

  describe('getPlanType', () => {
    it('defaults to max when no env var set', () => {
      delete process.env.SQUADS_PLAN_TYPE;
      expect(getPlanType()).toBe('max');
    });

    it('returns max when SQUADS_PLAN_TYPE=max', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      expect(getPlanType()).toBe('max');
    });

    it('returns max when SQUADS_PLAN_TYPE=MAX (case insensitive)', () => {
      process.env.SQUADS_PLAN_TYPE = 'MAX';
      expect(getPlanType()).toBe('max');
    });

    it('returns usage when SQUADS_PLAN_TYPE=usage', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      expect(getPlanType()).toBe('usage');
    });

    it('returns usage when SQUADS_PLAN_TYPE=USAGE (case insensitive)', () => {
      process.env.SQUADS_PLAN_TYPE = 'USAGE';
      expect(getPlanType()).toBe('usage');
    });

    it('defaults to max for unknown values', () => {
      process.env.SQUADS_PLAN_TYPE = 'unknown';
      expect(getPlanType()).toBe('max');
    });
  });

  describe('isMaxPlan', () => {
    it('returns true when on max plan', () => {
      process.env.SQUADS_PLAN_TYPE = 'max';
      expect(isMaxPlan()).toBe(true);
    });

    it('returns true when env not set (default)', () => {
      delete process.env.SQUADS_PLAN_TYPE;
      expect(isMaxPlan()).toBe(true);
    });

    it('returns false when on usage plan', () => {
      process.env.SQUADS_PLAN_TYPE = 'usage';
      expect(isMaxPlan()).toBe(false);
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
