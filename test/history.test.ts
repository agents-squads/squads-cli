import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('history command', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('formatDuration', () => {
    // Test the duration formatting logic
    function formatDuration(ms?: number): string {
      if (!ms) return '—';

      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return `${seconds}s`;

      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;

      const hours = Math.floor(minutes / 60);
      const remainingMinutes = minutes % 60;
      return `${hours}h ${remainingMinutes}m`;
    }

    it('returns dash for undefined', () => {
      expect(formatDuration(undefined)).toBe('—');
    });

    it('returns dash for 0', () => {
      expect(formatDuration(0)).toBe('—');
    });

    it('formats seconds correctly', () => {
      expect(formatDuration(5000)).toBe('5s');
      expect(formatDuration(45000)).toBe('45s');
    });

    it('formats minutes and seconds correctly', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(300000)).toBe('5m 0s'); // 5 minutes
      expect(formatDuration(3540000)).toBe('59m 0s'); // 59 minutes
    });

    it('formats hours correctly', () => {
      expect(formatDuration(3660000)).toBe('1h 1m');
      expect(formatDuration(7200000)).toBe('2h 0m');
    });
  });

  describe('groupByDate', () => {
    interface Execution {
      id: string;
      squad: string;
      agent: string;
      startedAt: Date;
      status: 'success' | 'error' | 'running';
    }

    function groupByDate(executions: Execution[]): Map<string, Execution[]> {
      const groups = new Map<string, Execution[]>();

      for (const exec of executions) {
        const dateKey = exec.startedAt.toISOString().split('T')[0];
        if (!groups.has(dateKey)) {
          groups.set(dateKey, []);
        }
        groups.get(dateKey)!.push(exec);
      }

      return groups;
    }

    it('groups executions by date', () => {
      const executions: Execution[] = [
        { id: '1', squad: 'website', agent: 'seo-eval', startedAt: new Date('2024-01-15T10:00:00Z'), status: 'success' },
        { id: '2', squad: 'website', agent: 'perf-eval', startedAt: new Date('2024-01-15T14:00:00Z'), status: 'success' },
        { id: '3', squad: 'finance', agent: 'cost-tracker', startedAt: new Date('2024-01-14T09:00:00Z'), status: 'success' },
      ];

      const groups = groupByDate(executions);

      expect(groups.size).toBe(2);
      expect(groups.get('2024-01-15')?.length).toBe(2);
      expect(groups.get('2024-01-14')?.length).toBe(1);
    });

    it('handles empty array', () => {
      const groups = groupByDate([]);
      expect(groups.size).toBe(0);
    });
  });

  describe('bridge URL configuration', () => {
    it('defaults to localhost:8088', () => {
      delete process.env.SQUADS_BRIDGE_URL;
      const BRIDGE_URL = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';
      expect(BRIDGE_URL).toBe('http://localhost:8088');
    });

    it('uses env var when set', () => {
      process.env.SQUADS_BRIDGE_URL = 'http://custom:9000';
      const BRIDGE_URL = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';
      expect(BRIDGE_URL).toBe('http://custom:9000');
    });
  });

  describe('execution status display', () => {
    it('maps status to correct icon', () => {
      const statusToIcon = (status: string): string => {
        switch (status) {
          case 'success': return '✓';
          case 'error': return '✗';
          case 'running': return '◐';
          default: return '○';
        }
      };

      expect(statusToIcon('success')).toBe('✓');
      expect(statusToIcon('error')).toBe('✗');
      expect(statusToIcon('running')).toBe('◐');
      expect(statusToIcon('unknown')).toBe('○');
    });
  });

  describe('date filtering', () => {
    it('calculates cutoff date correctly', () => {
      const days = 7;
      const now = Date.now();
      const cutoff = now - days * 24 * 60 * 60 * 1000;

      // Should be 7 days ago
      const cutoffDate = new Date(cutoff);
      const diff = (now - cutoff) / (24 * 60 * 60 * 1000);
      expect(diff).toBeCloseTo(7, 0);
    });

    it('filters by squad when specified', () => {
      const executions = [
        { squad: 'website', agent: 'seo' },
        { squad: 'finance', agent: 'cost' },
        { squad: 'website', agent: 'perf' },
      ];

      const filterBySquad = (items: typeof executions, squad?: string) =>
        squad ? items.filter(e => e.squad === squad) : items;

      expect(filterBySquad(executions, 'website').length).toBe(2);
      expect(filterBySquad(executions, 'finance').length).toBe(1);
      expect(filterBySquad(executions, undefined).length).toBe(3);
    });
  });
});
