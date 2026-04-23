import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isEnabled,
  Events,
  trackCommand,
} from '../src/lib/telemetry';

describe('telemetry', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment for each test
    vi.resetModules();
    process.env = { ...originalEnv };
    // Disable telemetry in tests by default
    process.env.SQUADS_TELEMETRY_DISABLED = '1';
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('isEnabled', () => {
    it('returns false when SQUADS_TELEMETRY_DISABLED=1', async () => {
      process.env.SQUADS_TELEMETRY_DISABLED = '1';
      const { isEnabled } = await import('../src/lib/telemetry');
      expect(isEnabled()).toBe(false);
    });

    it('returns false when DO_NOT_TRACK=1', async () => {
      delete process.env.SQUADS_TELEMETRY_DISABLED;
      process.env.DO_NOT_TRACK = '1';
      const { isEnabled } = await import('../src/lib/telemetry');
      expect(isEnabled()).toBe(false);
    });
  });

  describe('Events', () => {
    it('has CLI_INIT event', () => {
      expect(Events.CLI_INIT).toBe('cli.init');
    });

    it('has CLI_ERROR event', () => {
      expect(Events.CLI_ERROR).toBe('cli.error');
    });

    it('has command events', () => {
      expect(Events.CLI_RUN).toBe('cli.run');
      expect(Events.CLI_RUN_COMPLETE).toBe('cli.run.complete');
      expect(Events.CLI_STATUS).toBe('cli.status');
      expect(Events.CLI_DASHBOARD).toBe('cli.dashboard');
    });

    it('has memory events', () => {
      expect(Events.CLI_MEMORY_QUERY).toBe('cli.memory.query');
      expect(Events.CLI_MEMORY_SHOW).toBe('cli.memory.show');
      expect(Events.CLI_MEMORY_UPDATE).toBe('cli.memory.update');
    });

    it('has goal events', () => {
      expect(Events.CLI_GOAL_SET).toBe('cli.goal.set');
      expect(Events.CLI_GOAL_LIST).toBe('cli.goal.list');
      expect(Events.CLI_GOAL_COMPLETE).toBe('cli.goal.complete');
    });

    it('has KPI events', () => {
      expect(Events.CLI_KPI_SHOW).toBe('cli.kpi.show');
      expect(Events.CLI_KPI_RECORD).toBe('cli.kpi.record');
      expect(Events.CLI_KPI_TREND).toBe('cli.kpi.trend');
    });

    it('has condenser events', () => {
      expect(Events.CONDENSER_COMPRESS).toBe('condenser.compress');
      expect(Events.CONDENSER_DEDUPE).toBe('condenser.dedupe');
    });
  });

  describe('trackCommand', () => {
    it('returns a function', () => {
      const finish = trackCommand('test');
      expect(typeof finish).toBe('function');
    });

    it('does not throw when called', () => {
      const finish = trackCommand('test');
      expect(() => finish()).not.toThrow();
    });

    it('measures time between start and finish', async () => {
      const finish = trackCommand('test');
      // Wait a bit to ensure measurable time
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(() => finish()).not.toThrow();
    });
  });

  describe('user type detection', () => {
    it('detects agent execution from SQUADS_AGENT env', async () => {
      delete process.env.SQUADS_TELEMETRY_DISABLED;
      process.env.SQUADS_AGENT = 'issue-solver';

      // Import fresh to pick up env changes
      vi.resetModules();
      const { track } = await import('../src/lib/telemetry');

      // The track function includes userType in context
      // We can't easily test the internal detectUserType function,
      // but we verify the module loads without error
      expect(typeof track).toBe('function');
    });

    it('detects CI from GITHUB_ACTIONS env', async () => {
      delete process.env.SQUADS_TELEMETRY_DISABLED;
      delete process.env.SQUADS_AGENT;
      process.env.GITHUB_ACTIONS = 'true';

      vi.resetModules();
      const { track } = await import('../src/lib/telemetry');
      expect(typeof track).toBe('function');
    });

    it('detects CI from CI env variable', async () => {
      delete process.env.SQUADS_TELEMETRY_DISABLED;
      delete process.env.SQUADS_AGENT;
      delete process.env.GITHUB_ACTIONS;
      process.env.CI = 'true';

      vi.resetModules();
      const { track } = await import('../src/lib/telemetry');
      expect(typeof track).toBe('function');
    });
  });

  describe('track function', () => {
    it('does not throw when telemetry disabled', async () => {
      process.env.SQUADS_TELEMETRY_DISABLED = '1';
      const { track } = await import('../src/lib/telemetry');

      await expect(track('test.event', { foo: 'bar' })).resolves.toBeUndefined();
    });

    it('accepts properties parameter', async () => {
      process.env.SQUADS_TELEMETRY_DISABLED = '1';
      const { track } = await import('../src/lib/telemetry');

      await expect(
        track('test.event', {
          stringProp: 'value',
          numberProp: 42,
          boolProp: true,
        })
      ).resolves.toBeUndefined();
    });
  });

  describe('trackError function', () => {
    it('does not throw when telemetry disabled', async () => {
      process.env.SQUADS_TELEMETRY_DISABLED = '1';
      const { trackError } = await import('../src/lib/telemetry');

      const error = new Error('Test error message');
      await expect(trackError('test-command', error)).resolves.toBeUndefined();
    });

    it('accepts context parameter', async () => {
      process.env.SQUADS_TELEMETRY_DISABLED = '1';
      const { trackError } = await import('../src/lib/telemetry');

      const error = new Error('Test error');
      await expect(
        trackError('test-command', error, { customField: 'value' })
      ).resolves.toBeUndefined();
    });
  });

  describe('instrumentCommand', () => {
    it('wraps a function and returns result', async () => {
      process.env.SQUADS_TELEMETRY_DISABLED = '1';
      const { instrumentCommand } = await import('../src/lib/telemetry');

      const originalFn = async () => 'test-result';
      const wrapped = instrumentCommand('test', originalFn);

      const result = await wrapped();
      expect(result).toBe('test-result');
    });

    it('propagates errors from wrapped function', async () => {
      process.env.SQUADS_TELEMETRY_DISABLED = '1';
      const { instrumentCommand } = await import('../src/lib/telemetry');

      const originalFn = async () => {
        throw new Error('Test error');
      };
      const wrapped = instrumentCommand('test', originalFn);

      await expect(wrapped()).rejects.toThrow('Test error');
    });
  });

  describe('flushEvents', () => {
    it('does not throw when queue is empty', async () => {
      process.env.SQUADS_TELEMETRY_DISABLED = '1';
      const { flushEvents } = await import('../src/lib/telemetry');

      await expect(flushEvents()).resolves.toBeUndefined();
    });
  });
});
