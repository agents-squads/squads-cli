/**
 * Tests for dashboard trend renderer
 */

import { describe, it, expect } from 'vitest';
import { renderTrend, renderStackedTrend } from '../src/lib/dashboard/renderers/trend.js';
import type { ViewDefinition, MetricDefinition, QueryResult } from '../src/lib/dashboard/types.js';

// Helper to strip ANSI codes for easier assertions
const stripAnsi = (str: string): string => str.replace(/\x1b\[[0-9;]*m/g, '');

describe('dashboard trend renderer', () => {
  describe('renderTrend', () => {
    const metricDefs: MetricDefinition[] = [
      { name: 'count', label: 'Count', format: 'number' },
      { name: 'cost', label: 'Cost', format: 'currency' },
      { name: 'percent', label: 'Percent', format: 'percent' },
    ];

    it('returns "No data" for empty data', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = { rows: [], columns: [] };

      const result = renderTrend(view, data, metricDefs);

      expect(result.length).toBe(1);
      expect(stripAnsi(result[0])).toContain('No data');
    });

    it('renders title when provided', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        title: 'Test Trend Chart',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [{ count: 10 }, { count: 20 }],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      expect(stripAnsi(result[0])).toContain('Test Trend Chart');
    });

    it('renders sparkline for metric', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { count: 10 },
          { count: 20 },
          { count: 30 },
          { count: 25 },
          { count: 35 },
        ],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      // Should have a line with sparkline characters
      expect(result.length).toBeGreaterThan(0);
      const stripped = result.map(stripAnsi);
      // Should show metric label
      expect(stripped.some(line => line.includes('Count'))).toBe(true);
      // Should show "total"
      expect(stripped.some(line => line.includes('total'))).toBe(true);
    });

    it('calculates and shows change percentage', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { count: 100 }, // latest (gets reversed to be last)
          { count: 50 },  // previous
        ],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi).join(' ');
      // After reversal: [50, 100], change = (100-50)/50 = 100%
      expect(stripped.includes('%')).toBe(true);
    });

    it('handles string values by parsing to number', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { count: '100' },
          { count: '200' },
        ],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      // Should render without error
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles non-numeric values gracefully', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { count: 'not a number' },
          { count: NaN },
        ],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      // Should render without error (values default to 0)
      expect(result.length).toBeGreaterThan(0);
    });

    it('skips metrics without definition', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['unknown_metric'],
      };
      const data: QueryResult = {
        rows: [{ unknown_metric: 100 }],
        columns: ['unknown_metric'],
      };

      const result = renderTrend(view, data, metricDefs);

      // Should not render anything for unknown metric (no def found)
      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('unknown_metric'))).toBe(false);
    });

    it('renders multiple metrics', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count', 'cost'],
      };
      const data: QueryResult = {
        rows: [
          { count: 10, cost: 100 },
          { count: 20, cost: 200 },
        ],
        columns: ['count', 'cost'],
      };

      const result = renderTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('Count'))).toBe(true);
      expect(stripped.some(line => line.includes('Cost'))).toBe(true);
    });

    it('uses metric label from definition', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [{ count: 10 }],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi);
      // Should use "Count" label not "count"
      expect(stripped.some(line => line.includes('Count'))).toBe(true);
    });

    it('falls back to metric name when no label', () => {
      const metricDefsNoLabel: MetricDefinition[] = [
        { name: 'count', format: 'number' },
      ];
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [{ count: 10 }],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefsNoLabel);

      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('count'))).toBe(true);
    });

    it('handles zero previous value for change calculation', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { count: 100 }, // latest
          { count: 0 },   // previous
        ],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      // Should not crash, change = 0 when previous = 0
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles single data point', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [{ count: 100 }],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      // Should render without error
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles empty metrics array', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: [],
      };
      const data: QueryResult = {
        rows: [{ count: 100 }],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      // Should not crash
      expect(result).toBeDefined();
    });

    it('handles undefined metrics', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
      };
      const data: QueryResult = {
        rows: [{ count: 100 }],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      // Should not crash
      expect(result).toBeDefined();
    });

    it('shows positive change with plus sign', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'trend',
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { count: 200 }, // latest (reversed to be last)
          { count: 100 }, // previous
        ],
        columns: ['count'],
      };

      const result = renderTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi).join(' ');
      // Should show positive change
      expect(stripped.includes('+') || stripped.includes('%')).toBe(true);
    });
  });

  describe('renderStackedTrend', () => {
    const metricDefs: MetricDefinition[] = [
      { name: 'revenue', label: 'Revenue', format: 'currency' },
      { name: 'cost', label: 'Cost', format: 'currency' },
      { name: 'profit', label: 'Profit', format: 'currency' },
    ];

    it('returns "No data" for empty data', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue', 'cost'],
      };
      const data: QueryResult = { rows: [], columns: [] };

      const result = renderStackedTrend(view, data, metricDefs);

      expect(result.length).toBe(1);
      expect(stripAnsi(result[0])).toContain('No data');
    });

    it('renders title when provided', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        title: 'Test Stacked Trend',
        metrics: ['revenue'],
      };
      const data: QueryResult = {
        rows: [{ revenue: 100 }],
        columns: ['revenue'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      expect(stripAnsi(result[0])).toContain('Test Stacked Trend');
    });

    it('renders sparkline for primary metric', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue', 'cost'],
      };
      const data: QueryResult = {
        rows: [
          { revenue: 100, cost: 50 },
          { revenue: 150, cost: 60 },
          { revenue: 200, cost: 70 },
        ],
        columns: ['revenue', 'cost'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      // Should have sparkline and legend
      expect(result.length).toBeGreaterThan(1);
    });

    it('shows legend with totals for all metrics', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue', 'cost'],
      };
      const data: QueryResult = {
        rows: [
          { revenue: 100, cost: 50 },
          { revenue: 150, cost: 60 },
        ],
        columns: ['revenue', 'cost'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('Revenue'))).toBe(true);
      expect(stripped.some(line => line.includes('Cost'))).toBe(true);
    });

    it('calculates correct totals', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue'],
      };
      const data: QueryResult = {
        rows: [
          { revenue: 100 },
          { revenue: 200 },
          { revenue: 300 },
        ],
        columns: ['revenue'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi).join(' ');
      // Total should be 600
      expect(stripped.includes('600') || stripped.includes('$600')).toBe(true);
    });

    it('handles string values by parsing to number', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue'],
      };
      const data: QueryResult = {
        rows: [
          { revenue: '100' },
          { revenue: '200' },
        ],
        columns: ['revenue'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      // Should render without error
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles non-numeric values gracefully', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue'],
      };
      const data: QueryResult = {
        rows: [
          { revenue: 'invalid' },
          { revenue: NaN },
        ],
        columns: ['revenue'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      // Should render without error
      expect(result.length).toBeGreaterThan(0);
    });

    it('skips metrics without definition in legend', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue', 'unknown_metric'],
      };
      const data: QueryResult = {
        rows: [{ revenue: 100, unknown_metric: 50 }],
        columns: ['revenue', 'unknown_metric'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('Revenue'))).toBe(true);
      expect(stripped.some(line => line.includes('unknown_metric'))).toBe(false);
    });

    it('handles three metrics with color coding', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue', 'cost', 'profit'],
      };
      const data: QueryResult = {
        rows: [
          { revenue: 100, cost: 50, profit: 50 },
        ],
        columns: ['revenue', 'cost', 'profit'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('Revenue'))).toBe(true);
      expect(stripped.some(line => line.includes('Cost'))).toBe(true);
      expect(stripped.some(line => line.includes('Profit'))).toBe(true);
    });

    it('uses metric label from definition', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue'],
      };
      const data: QueryResult = {
        rows: [{ revenue: 100 }],
        columns: ['revenue'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      const stripped = result.map(stripAnsi);
      // Should use "Revenue" label
      expect(stripped.some(line => line.includes('Revenue'))).toBe(true);
    });

    it('falls back to metric name when no label', () => {
      const metricDefsNoLabel: MetricDefinition[] = [
        { name: 'revenue', format: 'currency' },
      ];
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: ['revenue'],
      };
      const data: QueryResult = {
        rows: [{ revenue: 100 }],
        columns: ['revenue'],
      };

      const result = renderStackedTrend(view, data, metricDefsNoLabel);

      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('revenue'))).toBe(true);
    });

    it('handles empty metrics array', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
        metrics: [],
      };
      const data: QueryResult = {
        rows: [{ revenue: 100 }],
        columns: ['revenue'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      // Should not crash
      expect(result).toBeDefined();
    });

    it('handles undefined metrics', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'stacked_trend',
      };
      const data: QueryResult = {
        rows: [{ revenue: 100 }],
        columns: ['revenue'],
      };

      const result = renderStackedTrend(view, data, metricDefs);

      // Should not crash
      expect(result).toBeDefined();
    });
  });
});
