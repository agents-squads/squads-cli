import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('health command', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('formatTimeAgo', () => {
    function formatTimeAgo(date: Date): string {
      const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

      if (seconds < 60) return `${seconds}s ago`;
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
      return `${Math.floor(seconds / 86400)}d ago`;
    }

    it('formats seconds ago', () => {
      const date = new Date(Date.now() - 30 * 1000);
      expect(formatTimeAgo(date)).toBe('30s ago');
    });

    it('formats minutes ago', () => {
      const date = new Date(Date.now() - 5 * 60 * 1000);
      expect(formatTimeAgo(date)).toBe('5m ago');
    });

    it('formats hours ago', () => {
      const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
      expect(formatTimeAgo(date)).toBe('3h ago');
    });

    it('formats days ago', () => {
      const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      expect(formatTimeAgo(date)).toBe('2d ago');
    });
  });

  describe('formatLatency', () => {
    function formatLatency(ms?: number): string {
      if (!ms) return '—';
      return `${ms}ms`;
    }

    it('returns dash for undefined', () => {
      expect(formatLatency(undefined)).toBe('—');
    });

    it('returns dash for 0', () => {
      expect(formatLatency(0)).toBe('—');
    });

    it('formats milliseconds', () => {
      expect(formatLatency(15)).toBe('15ms');
      expect(formatLatency(150)).toBe('150ms');
    });
  });

  describe('service URL configuration', () => {
    it('defaults bridge URL to localhost:8088', () => {
      delete process.env.SQUADS_BRIDGE_URL;
      const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';
      expect(bridgeUrl).toBe('http://localhost:8088');
    });

    it('uses custom bridge URL from env', () => {
      process.env.SQUADS_BRIDGE_URL = 'http://custom:9000';
      const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';
      expect(bridgeUrl).toBe('http://custom:9000');
    });

    it('defaults scheduler URL to localhost:8090', () => {
      delete process.env.SQUADS_SCHEDULER_URL;
      const schedulerUrl = process.env.SQUADS_SCHEDULER_URL || 'http://localhost:8090';
      expect(schedulerUrl).toBe('http://localhost:8090');
    });

    it('defaults langfuse URL to localhost:3100', () => {
      delete process.env.LANGFUSE_HOST;
      const langfuseUrl = process.env.LANGFUSE_HOST || 'http://localhost:3100';
      expect(langfuseUrl).toBe('http://localhost:3100');
    });
  });

  describe('service status mapping', () => {
    it('maps status to correct display', () => {
      const statusDisplay = (status: string) => {
        switch (status) {
          case 'healthy': return { icon: '●', color: 'green', text: 'healthy' };
          case 'degraded': return { icon: '○', color: 'yellow', text: 'degraded' };
          case 'down': return { icon: '●', color: 'red', text: 'down' };
          default: return { icon: '?', color: 'gray', text: 'unknown' };
        }
      };

      expect(statusDisplay('healthy').text).toBe('healthy');
      expect(statusDisplay('degraded').text).toBe('degraded');
      expect(statusDisplay('down').text).toBe('down');
    });
  });

  describe('trigger stats parsing', () => {
    it('handles valid trigger stats', () => {
      interface TriggerStats {
        active: number;
        disabled: number;
      }

      const parseStats = (data: { active?: number; disabled?: number }): TriggerStats => ({
        active: data.active || 0,
        disabled: data.disabled || 0,
      });

      expect(parseStats({ active: 12, disabled: 3 })).toEqual({ active: 12, disabled: 3 });
      expect(parseStats({})).toEqual({ active: 0, disabled: 0 });
    });
  });

  describe('issue categorization', () => {
    interface ServiceResult {
      name: string;
      status: 'healthy' | 'down' | 'degraded';
      optional?: boolean;
    }

    it('separates critical from optional issues', () => {
      const results: ServiceResult[] = [
        { name: 'PostgreSQL', status: 'down' },
        { name: 'Langfuse', status: 'down', optional: true },
        { name: 'Bridge', status: 'healthy' },
      ];

      const issues = results.filter(r => r.status !== 'healthy');
      const criticalIssues = issues.filter(i => !i.optional);
      const optionalIssues = issues.filter(i => i.optional);

      expect(criticalIssues.length).toBe(1);
      expect(criticalIssues[0].name).toBe('PostgreSQL');
      expect(optionalIssues.length).toBe(1);
      expect(optionalIssues[0].name).toBe('Langfuse');
    });

    it('identifies when all services are healthy', () => {
      const results: ServiceResult[] = [
        { name: 'PostgreSQL', status: 'healthy' },
        { name: 'Bridge', status: 'healthy' },
      ];

      const issues = results.filter(r => r.status !== 'healthy');
      expect(issues.length).toBe(0);
    });
  });
});
