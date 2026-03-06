import { describe, it, expect } from 'vitest';
import { formatValue, getThresholdColor, calculateColumnWidths } from '../src/lib/dashboard/renderers/base.js';
import { renderView } from '../src/lib/dashboard/renderers/index.js';
import type { ViewDefinition, MetricDefinition, DimensionDefinition, QueryResult } from '../src/lib/dashboard/types.js';

// Strip ANSI escape codes for cleaner assertions
function strip(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

const emptyData: QueryResult = { rows: [], columns: [] };

const metricDefs: MetricDefinition[] = [
  { name: 'total_runs', sql: 'COUNT(*)', format: 'number', label: 'Total Runs' },
  { name: 'cost', sql: 'SUM(cost)', format: 'currency', label: 'Total Cost' },
  { name: 'success_rate', sql: 'AVG(success)', format: 'percent', label: 'Success' },
  { name: 'duration', sql: 'AVG(dur)', format: 'duration', label: 'Avg Duration' },
  { name: 'tokens', sql: 'SUM(tokens)', format: 'tokens', label: 'Tokens' },
];

const dimensionDefs: DimensionDefinition[] = [
  { name: 'squad', sql: 'squad_name', type: 'string', label: 'Squad' },
];

describe('dashboard renderers', () => {
  describe('formatValue', () => {
    describe('number format', () => {
      it('formats small numbers', () => {
        expect(strip(formatValue(42, 'number'))).toBe('42');
      });

      it('formats thousands with k suffix', () => {
        expect(strip(formatValue(1500, 'number'))).toBe('1.5k');
      });

      it('formats millions with M suffix', () => {
        expect(strip(formatValue(2_500_000, 'number'))).toBe('2.5M');
      });

      it('handles NaN gracefully', () => {
        expect(strip(formatValue('not-a-number', 'number'))).toBe('not-a-number');
      });
    });

    describe('currency format', () => {
      it('formats with dollar sign and 2 decimals', () => {
        expect(strip(formatValue(12.5, 'currency'))).toBe('$12.50');
      });

      it('formats zero', () => {
        expect(strip(formatValue(0, 'currency'))).toBe('$0.00');
      });
    });

    describe('percent format', () => {
      it('formats with one decimal and percent sign', () => {
        expect(strip(formatValue(87.654, 'percent'))).toBe('87.7%');
      });

      it('formats zero percent', () => {
        expect(strip(formatValue(0, 'percent'))).toBe('0.0%');
      });
    });

    describe('duration format', () => {
      it('formats seconds under 60', () => {
        expect(strip(formatValue(45.2, 'duration'))).toBe('45.2s');
      });

      it('formats minutes and seconds', () => {
        expect(strip(formatValue(125, 'duration'))).toBe('2m 5s');
      });

      it('formats hours and minutes', () => {
        expect(strip(formatValue(3700, 'duration'))).toBe('1h 1m');
      });
    });

    describe('tokens format', () => {
      it('formats small token count', () => {
        expect(strip(formatValue(500, 'tokens'))).toBe('500');
      });

      it('formats thousands with k suffix', () => {
        expect(strip(formatValue(15000, 'tokens'))).toBe('15k');
      });

      it('formats millions with M suffix', () => {
        expect(strip(formatValue(1_200_000, 'tokens'))).toBe('1.2M');
      });
    });

    describe('relative_time format', () => {
      it('formats recent time as seconds ago', () => {
        const recent = new Date(Date.now() - 30000); // 30 seconds ago
        const result = strip(formatValue(recent, 'relative_time'));
        expect(result).toMatch(/\d+s ago/);
      });

      it('formats older time as minutes ago', () => {
        const older = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
        const result = strip(formatValue(older, 'relative_time'));
        expect(result).toMatch(/\d+m ago/);
      });

      it('handles invalid date', () => {
        const result = strip(formatValue('not-a-date', 'relative_time'));
        expect(result).toBe('not-a-date');
      });
    });

    describe('relative_date format', () => {
      it('formats today', () => {
        const today = new Date();
        const result = strip(formatValue(today, 'relative_date'));
        expect(result).toBe('today');
      });

      it('formats yesterday', () => {
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const result = strip(formatValue(yesterday, 'relative_date'));
        expect(result).toBe('yesterday');
      });
    });

    describe('status_badge format', () => {
      it('formats success status', () => {
        const result = formatValue('success', 'status_badge');
        expect(strip(result)).toBe('success');
      });

      it('formats failed status', () => {
        const result = formatValue('failed', 'status_badge');
        expect(strip(result)).toBe('failed');
      });

      it('formats running status', () => {
        const result = formatValue('running', 'status_badge');
        expect(strip(result)).toBe('running');
      });
    });

    describe('null/undefined handling', () => {
      it('handles null values', () => {
        const result = strip(formatValue(null, 'number'));
        expect(result).toBe('—');
      });

      it('handles undefined values', () => {
        const result = strip(formatValue(undefined, 'number'));
        expect(result).toBe('—');
      });
    });

    describe('default format with truncation', () => {
      it('truncates long strings', () => {
        const longStr = 'a'.repeat(50);
        const result = strip(formatValue(longStr, 'string', 10));
        expect(result.length).toBeLessThanOrEqual(13); // truncate adds '...'
      });

      it('does not truncate short strings', () => {
        const shortStr = 'hello';
        const result = strip(formatValue(shortStr, 'string', 20));
        expect(result).toBe('hello');
      });
    });
  });

  describe('getThresholdColor', () => {
    it('returns green for values above good threshold (up direction)', () => {
      const color = getThresholdColor(90, { good: 80, warning: 50, direction: 'up' });
      expect(color).toContain('\x1b['); // is an ANSI code
      expect(strip(color + 'x')).toBe('x');
    });

    it('returns yellow for values between warning and good', () => {
      const good = getThresholdColor(90, { good: 80, direction: 'up' });
      const warning = getThresholdColor(60, { good: 80, direction: 'up' });
      expect(good).not.toBe(warning);
    });

    it('uses default thresholds when not provided', () => {
      // Should not throw
      expect(() => getThresholdColor(75, {})).not.toThrow();
    });

    it('handles down direction (lower is better)', () => {
      const good = getThresholdColor(10, { good: 20, warning: 50, direction: 'down' });
      const bad = getThresholdColor(90, { good: 20, warning: 50, direction: 'down' });
      expect(good).not.toBe(bad);
    });
  });

  describe('calculateColumnWidths', () => {
    it('returns widths matching number of columns', () => {
      const rows = [{ name: 'Alice', age: '30' }];
      const cols = [{ field: 'name' }, { field: 'age' }];
      const widths = calculateColumnWidths(rows, cols);
      expect(widths).toHaveLength(2);
    });

    it('returns minimum width of 5', () => {
      const rows = [{ x: '1' }];
      const cols = [{ field: 'x', label: 'X' }];
      const widths = calculateColumnWidths(rows, cols, 1); // Force scale down
      expect(widths[0]).toBeGreaterThanOrEqual(5);
    });

    it('scales down widths when total exceeds maxWidth', () => {
      const rows = [{ a: 'a'.repeat(40), b: 'b'.repeat(40) }];
      const cols = [{ field: 'a' }, { field: 'b' }];
      const widths = calculateColumnWidths(rows, cols, 40);
      const total = widths.reduce((sum, w) => sum + w, 0);
      expect(total).toBeLessThanOrEqual(40);
    });

    it('caps individual column width at 30', () => {
      const rows = [{ long_col: 'x'.repeat(100) }];
      const cols = [{ field: 'long_col' }];
      const widths = calculateColumnWidths(rows, cols, 200);
      expect(widths[0]).toBeLessThanOrEqual(30);
    });
  });

  describe('renderView', () => {
    describe('summary view', () => {
      it('renders summary with metric values', () => {
        const view: ViewDefinition = { id: 'v1', type: 'summary', metrics: ['total_runs'] };
        const data: QueryResult = { rows: [{ total_runs: 42 }], columns: ['total_runs'] };
        const lines = renderView(view, data, metricDefs, dimensionDefs);
        const combined = strip(lines.join('\n'));
        expect(combined).toContain('42');
      });
    });

    describe('table view', () => {
      it('renders no data message when empty', () => {
        const view: ViewDefinition = { id: 'v1', type: 'table', metrics: ['total_runs'] };
        const lines = renderView(view, emptyData, metricDefs, dimensionDefs);
        const combined = strip(lines.join('\n'));
        expect(combined).toContain('No data');
      });

      it('renders table with data', () => {
        const view: ViewDefinition = {
          id: 'v1', type: 'table',
          group_by: ['squad'],
          metrics: ['total_runs'],
        };
        const data: QueryResult = {
          rows: [{ squad: 'eng', total_runs: 10 }],
          columns: ['squad', 'total_runs'],
        };
        const lines = renderView(view, data, metricDefs, dimensionDefs);
        const combined = strip(lines.join('\n'));
        expect(combined).toContain('eng');
        expect(combined).toContain('10');
      });
    });

    describe('bar view', () => {
      it('renders no data message when empty', () => {
        const view: ViewDefinition = { id: 'v1', type: 'bar', group_by: ['squad'], metrics: ['total_runs'] };
        const lines = renderView(view, emptyData, metricDefs, dimensionDefs);
        expect(strip(lines.join('\n'))).toContain('No data');
      });

      it('renders bars for each row', () => {
        const view: ViewDefinition = {
          id: 'v1', type: 'bar',
          group_by: ['squad'],
          metrics: ['total_runs'],
        };
        const data: QueryResult = {
          rows: [
            { squad: 'engineering', total_runs: 10 },
            { squad: 'marketing', total_runs: 5 },
          ],
          columns: ['squad', 'total_runs'],
        };
        const lines = renderView(view, data, metricDefs, dimensionDefs);
        expect(lines.length).toBeGreaterThan(1);
        const combined = strip(lines.join('\n'));
        expect(combined).toContain('engineering');
        expect(combined).toContain('marketing');
      });

      it('shows error when group_by or metrics are missing', () => {
        const view: ViewDefinition = { id: 'v1', type: 'bar' };
        const data: QueryResult = { rows: [{ x: 1 }], columns: ['x'] };
        const lines = renderView(view, data, metricDefs, dimensionDefs);
        expect(strip(lines.join('\n'))).toContain('requires');
      });
    });

    describe('pie view', () => {
      it('renders no data message when empty', () => {
        const view: ViewDefinition = { id: 'v1', type: 'pie', group_by: ['squad'], metrics: ['total_runs'] };
        const lines = renderView(view, emptyData, metricDefs, dimensionDefs);
        expect(strip(lines.join('\n'))).toContain('No data');
      });

      it('renders pie distribution', () => {
        const view: ViewDefinition = {
          id: 'v1', type: 'pie',
          group_by: ['squad'],
          metrics: ['total_runs'],
        };
        const data: QueryResult = {
          rows: [
            { squad: 'engineering', total_runs: 60 },
            { squad: 'marketing', total_runs: 40 },
          ],
          columns: ['squad', 'total_runs'],
        };
        const lines = renderView(view, data, metricDefs, dimensionDefs);
        expect(lines.length).toBeGreaterThan(2);
      });
    });

    describe('list view', () => {
      it('renders no data message when empty', () => {
        const view: ViewDefinition = { id: 'v1', type: 'list' };
        const lines = renderView(view, emptyData, metricDefs, dimensionDefs);
        expect(strip(lines.join('\n'))).toContain('No data');
      });

      it('renders list items', () => {
        const view: ViewDefinition = {
          id: 'v1', type: 'list',
          columns: [{ field: 'name' }, { field: 'status' }],
        };
        const data: QueryResult = {
          rows: [{ name: 'Agent Alpha', status: 'active' }],
          columns: ['name', 'status'],
        };
        const lines = renderView(view, data, metricDefs, dimensionDefs);
        expect(strip(lines.join('\n'))).toContain('Agent Alpha');
      });

      it('renders recent list when columns include time fields', () => {
        const view: ViewDefinition = {
          id: 'v1', type: 'list',
          columns: [{ field: 'name' }, { field: 'created_at', format: 'relative_time' }],
        };
        const data: QueryResult = {
          rows: [{ name: 'Run A', created_at: new Date().toISOString() }],
          columns: ['name', 'created_at'],
        };
        // Should not throw
        const lines = renderView(view, data, metricDefs, dimensionDefs);
        expect(lines.length).toBeGreaterThan(0);
      });
    });

    describe('trend view', () => {
      it('handles trend view type', () => {
        const view: ViewDefinition = { id: 'v1', type: 'trend', metrics: ['total_runs'] };
        // Should not throw even with empty data
        const lines = renderView(view, emptyData, metricDefs, dimensionDefs);
        expect(Array.isArray(lines)).toBe(true);
      });
    });

    describe('unimplemented view types', () => {
      it('returns not implemented message for histogram', () => {
        const view: ViewDefinition = { id: 'v1', type: 'histogram' };
        const lines = renderView(view, emptyData, metricDefs, dimensionDefs);
        expect(strip(lines.join('\n'))).toContain('not yet implemented');
      });

      it('returns not implemented message for heatmap', () => {
        const view: ViewDefinition = { id: 'v1', type: 'heatmap' };
        const lines = renderView(view, emptyData, metricDefs, dimensionDefs);
        expect(strip(lines.join('\n'))).toContain('not yet implemented');
      });

      it('returns unknown type message for unrecognized type', () => {
        const view = { id: 'v1', type: 'unknown_type' } as unknown as ViewDefinition;
        const lines = renderView(view, emptyData, metricDefs, dimensionDefs);
        expect(strip(lines.join('\n'))).toContain('Unknown view type');
      });
    });
  });
});
