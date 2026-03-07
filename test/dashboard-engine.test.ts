import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the loader module
vi.mock('../src/lib/dashboard/loader.js', () => ({
  findDashboard: vi.fn(),
  listDashboards: vi.fn(),
  loadDashboard: vi.fn(),
}));

// Mock the postgres source
vi.mock('../src/lib/dashboard/sources/postgres.js', () => ({
  postgresSource: {
    name: 'postgres',
    query: vi.fn(),
    isAvailable: vi.fn(),
    close: vi.fn(),
  },
  buildQuery: vi.fn(() => 'SELECT 1'),
  buildWhereClause: vi.fn(() => null),
  parseDateRange: vi.fn(() => ({ start: new Date(), end: new Date() })),
}));

// Mock terminal output to avoid polluting test output
vi.mock('../src/lib/terminal.js', () => ({
  colors: {
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
    purple: '\x1b[35m',
    dim: '\x1b[2m',
    blue: '\x1b[34m',
  },
  bold: '\x1b[1m',
  RESET: '\x1b[0m',
  box: {
    horizontal: '─',
    vertical: '│',
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    teeRight: '├',
    teeLeft: '┤',
  },
  padEnd: (str: string, len: number) => str.padEnd(len),
  truncate: (str: string, len: number) => str.slice(0, len) + '...',
  writeLine: vi.fn(),
  progressBar: vi.fn(() => '[===   ]'),
  sparkline: vi.fn(() => '▁▂▃▄'),
  barChart: vi.fn(() => '████'),
  gradient: vi.fn((text: string) => text),
}));

import { executeDashboard, renderDashboard, showAvailableDashboards } from '../src/lib/dashboard/engine.js';
import { findDashboard, listDashboards, loadDashboard } from '../src/lib/dashboard/loader.js';
import { postgresSource } from '../src/lib/dashboard/sources/postgres.js';
import { writeLine } from '../src/lib/terminal.js';

// Strip ANSI codes
function strip(str: string) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

const mockDashboardDef = {
  name: 'test',
  title: 'Test Dashboard',
  source: 'postgres' as const,
  table: 'executions',
  metrics: [
    { name: 'total', sql: 'COUNT(*)', format: 'number' as const, label: 'Total' },
  ],
  dimensions: [
    { name: 'squad', sql: 'squad_name', type: 'string' as const },
  ],
  filters: [],
  views: [
    { id: 'overview', type: 'summary' as const, metrics: ['total'] },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(postgresSource.close).mockResolvedValue(undefined);
  vi.mocked(postgresSource.query).mockResolvedValue({ rows: [{ total: 42 }], columns: ['total'] });
  vi.mocked(postgresSource.isAvailable).mockResolvedValue(true);
});

describe('dashboard engine', () => {
  describe('executeDashboard', () => {
    it('returns failure when dashboard not found', async () => {
      vi.mocked(findDashboard).mockReturnValue(null);
      const result = await executeDashboard('nonexistent');
      expect(result.success).toBe(false);
      expect(strip(result.lines.join('\n'))).toContain('not found');
    });

    it('returns failure when data source is not supported', async () => {
      vi.mocked(findDashboard).mockReturnValue({
        ...mockDashboardDef,
        source: 'langfuse' as 'postgres',
      });
      const result = await executeDashboard('test');
      expect(result.success).toBe(false);
      expect(strip(result.lines.join('\n'))).toContain('not available');
    });

    it('returns failure when postgres is unavailable', async () => {
      vi.mocked(findDashboard).mockReturnValue(mockDashboardDef);
      vi.mocked(postgresSource.isAvailable).mockResolvedValue(false);
      const result = await executeDashboard('test');
      expect(result.success).toBe(false);
      expect(strip(result.lines.join('\n'))).toContain('Cannot connect');
    });

    it('returns success with rendered lines when dashboard executes', async () => {
      vi.mocked(findDashboard).mockReturnValue(mockDashboardDef);
      const result = await executeDashboard('test');
      expect(result.success).toBe(true);
      expect(result.lines.length).toBeGreaterThan(0);
    });

    it('includes title in output', async () => {
      vi.mocked(findDashboard).mockReturnValue(mockDashboardDef);
      const result = await executeDashboard('test');
      expect(strip(result.lines.join('\n'))).toContain('Test Dashboard');
    });

    it('includes description when verbose is true', async () => {
      vi.mocked(findDashboard).mockReturnValue({
        ...mockDashboardDef,
        description: 'Dashboard description here',
      });
      const result = await executeDashboard('test', { verbose: true });
      expect(strip(result.lines.join('\n'))).toContain('Dashboard description here');
    });

    it('does not include description when verbose is false', async () => {
      vi.mocked(findDashboard).mockReturnValue({
        ...mockDashboardDef,
        description: 'Dashboard description here',
      });
      const result = await executeDashboard('test', { verbose: false });
      expect(strip(result.lines.join('\n'))).not.toContain('Dashboard description here');
    });

    it('renders only specified views when views option provided', async () => {
      const defWithMultipleViews = {
        ...mockDashboardDef,
        views: [
          { id: 'view1', type: 'summary' as const, metrics: ['total'] },
          { id: 'view2', type: 'summary' as const, metrics: ['total'] },
        ],
      };
      vi.mocked(findDashboard).mockReturnValue(defWithMultipleViews);
      // Render only view1
      const result = await executeDashboard('test', { views: ['view1'] });
      expect(result.success).toBe(true);
      // Query should have been called once (for view1)
      expect(vi.mocked(postgresSource.query).mock.calls.length).toBe(1);
    });

    it('applies default date_range filter when not provided', async () => {
      const { parseDateRange } = await import('../src/lib/dashboard/sources/postgres.js');
      const defWithFilter = {
        ...mockDashboardDef,
        filters: [
          { name: 'period', type: 'date_range' as const, default: 'last_7d', field: 'created_at' },
        ],
      };
      vi.mocked(findDashboard).mockReturnValue(defWithFilter);
      await executeDashboard('test');
      expect(parseDateRange).toHaveBeenCalledWith('last_7d');
    });

    it('handles view rendering errors gracefully when not verbose', async () => {
      vi.mocked(findDashboard).mockReturnValue(mockDashboardDef);
      vi.mocked(postgresSource.query).mockRejectedValue(new Error('DB error'));
      const result = await executeDashboard('test');
      // Should still succeed (errors are silently swallowed when not verbose)
      expect(result.success).toBe(true);
    });

    it('includes view error message when verbose and error occurs', async () => {
      vi.mocked(findDashboard).mockReturnValue(mockDashboardDef);
      vi.mocked(postgresSource.query).mockRejectedValue(new Error('DB error'));
      const result = await executeDashboard('test', { verbose: true });
      expect(strip(result.lines.join('\n'))).toContain('Error rendering');
    });

    it('uses custom view source SQL when provided', async () => {
      const defWithCustomSQL = {
        ...mockDashboardDef,
        views: [
          { id: 'custom', type: 'summary' as const, metrics: ['total'], source: 'SELECT COUNT(*) AS total FROM custom_table' },
        ],
      };
      vi.mocked(findDashboard).mockReturnValue(defWithCustomSQL);
      await executeDashboard('test');
      expect(vi.mocked(postgresSource.query)).toHaveBeenCalledWith('SELECT COUNT(*) AS total FROM custom_table');
    });

    it('throws when no table defined and no view source', async () => {
      const defNoTable = {
        ...mockDashboardDef,
        table: undefined,
        views: [{ id: 'v1', type: 'summary' as const, metrics: ['total'] }],
      };
      vi.mocked(findDashboard).mockReturnValue(defNoTable);
      // Error is caught per-view, result still succeeds
      const result = await executeDashboard('test');
      expect(result.success).toBe(true);
    });

    it('closes the data source after execution', async () => {
      vi.mocked(findDashboard).mockReturnValue(mockDashboardDef);
      await executeDashboard('test');
      expect(postgresSource.close).toHaveBeenCalledOnce();
    });
  });

  describe('renderDashboard', () => {
    it('writes lines to terminal and returns success', async () => {
      vi.mocked(findDashboard).mockReturnValue(mockDashboardDef);
      const success = await renderDashboard('test');
      expect(success).toBe(true);
      expect(writeLine).toHaveBeenCalled();
    });

    it('returns false on failure', async () => {
      vi.mocked(findDashboard).mockReturnValue(null);
      const success = await renderDashboard('not-found');
      expect(success).toBe(false);
    });
  });

  describe('showAvailableDashboards', () => {
    it('shows no dashboards message when none exist', () => {
      vi.mocked(listDashboards).mockReturnValue([]);
      showAvailableDashboards();
      expect(writeLine).toHaveBeenCalled();
      const calls = vi.mocked(writeLine).mock.calls.map(c => strip(String(c[0] || '')));
      expect(calls.some(c => c.includes('No dashboards'))).toBe(true);
    });

    it('lists available dashboards', () => {
      vi.mocked(listDashboards).mockReturnValue(['costs', 'runs']);
      vi.mocked(loadDashboard).mockImplementation((name) => ({
        ...mockDashboardDef,
        name,
        title: `${name} dashboard`,
      }));
      showAvailableDashboards();
      const calls = vi.mocked(writeLine).mock.calls.map(c => strip(String(c[0] || '')));
      expect(calls.some(c => c.includes('costs'))).toBe(true);
      expect(calls.some(c => c.includes('runs'))).toBe(true);
    });

    it('shows usage instructions', () => {
      vi.mocked(listDashboards).mockReturnValue(['costs']);
      vi.mocked(loadDashboard).mockReturnValue(mockDashboardDef);
      showAvailableDashboards();
      const calls = vi.mocked(writeLine).mock.calls.map(c => strip(String(c[0] || '')));
      expect(calls.some(c => c.includes('squads dash'))).toBe(true);
    });
  });
});
