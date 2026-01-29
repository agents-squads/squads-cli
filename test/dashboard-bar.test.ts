/**
 * Tests for dashboard bar renderer
 */

import { describe, it, expect } from 'vitest';
import { renderBar, renderPie } from '../src/lib/dashboard/renderers/bar.js';
import type { ViewDefinition, MetricDefinition, DimensionDefinition, QueryResult } from '../src/lib/dashboard/types.js';

// Helper to strip ANSI codes for easier assertions
const stripAnsi = (str: string): string => str.replace(/\x1b\[[0-9;]*m/g, '');

describe('dashboard bar renderer', () => {
  describe('renderBar', () => {
    const metricDefs: MetricDefinition[] = [
      { name: 'count', label: 'Count', format: 'number' },
      { name: 'cost', label: 'Cost', format: 'currency' },
    ];
    const dimensionDefs: DimensionDefinition[] = [
      { name: 'category', label: 'Category', type: 'string' },
    ];

    it('returns "No data" for empty data', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = { rows: [], columns: [] };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      expect(result.length).toBe(1);
      expect(stripAnsi(result[0])).toContain('No data');
    });

    it('renders title when provided', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        title: 'Test Bar Chart',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [{ category: 'A', count: 10 }],
        columns: ['category', 'count'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      expect(stripAnsi(result[0])).toContain('Test Bar Chart');
    });

    it('requires group_by and metrics', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
      };
      const data: QueryResult = {
        rows: [{ category: 'A', count: 10 }],
        columns: ['category', 'count'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      expect(stripAnsi(result.join(''))).toContain('requires group_by and metrics');
    });

    it('requires metrics when only group_by provided', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
      };
      const data: QueryResult = {
        rows: [{ category: 'A', count: 10 }],
        columns: ['category', 'count'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      expect(stripAnsi(result.join(''))).toContain('requires group_by and metrics');
    });

    it('renders bars for each row', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: 100 },
          { category: 'B', count: 50 },
          { category: 'C', count: 25 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      // Should have entries for each row
      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('A'))).toBe(true);
      expect(stripped.some(line => line.includes('B'))).toBe(true);
      expect(stripped.some(line => line.includes('C'))).toBe(true);
    });

    it('handles string values by parsing to number', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: '100' },
          { category: 'B', count: '50' },
        ],
        columns: ['category', 'count'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      // Should render without error
      expect(result.length).toBeGreaterThan(0);
      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('A'))).toBe(true);
    });

    it('handles null/undefined dimension values', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: null, count: 100 },
          { category: undefined, count: 50 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('Unknown'))).toBe(true);
    });

    it('handles non-numeric values gracefully', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: 'not a number' },
          { category: 'B', count: NaN },
        ],
        columns: ['category', 'count'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      // Should render without error, values default to 0
      expect(result.length).toBeGreaterThan(0);
    });

    it('truncates long labels', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'This is a very long category name that should be truncated', count: 100 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      // Labels are capped at 20 chars
      const stripped = result.map(stripAnsi).join('');
      expect(stripped.includes('This is a very long category name that should be truncated')).toBe(false);
    });

    it('uses metric format for value display', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
        metrics: ['cost'],
      };
      const data: QueryResult = {
        rows: [{ category: 'A', cost: 1000 }],
        columns: ['category', 'cost'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      // Should use currency format
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles missing metric definition', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'bar',
        group_by: ['category'],
        metrics: ['unknown_metric'],
      };
      const data: QueryResult = {
        rows: [{ category: 'A', unknown_metric: 100 }],
        columns: ['category', 'unknown_metric'],
      };

      const result = renderBar(view, data, metricDefs, dimensionDefs);

      // Should render without error, using default format
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe('renderPie', () => {
    const metricDefs: MetricDefinition[] = [
      { name: 'count', label: 'Count', format: 'number' },
    ];
    const dimensionDefs: DimensionDefinition[] = [
      { name: 'category', label: 'Category', type: 'string' },
    ];

    it('returns "No data" for empty data', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = { rows: [], columns: [] };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      expect(result.length).toBe(1);
      expect(stripAnsi(result[0])).toContain('No data');
    });

    it('renders title when provided', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        title: 'Test Pie Chart',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [{ category: 'A', count: 10 }],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      expect(stripAnsi(result[0])).toContain('Test Pie Chart');
    });

    it('requires group_by and metrics', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
      };
      const data: QueryResult = {
        rows: [{ category: 'A', count: 10 }],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      expect(stripAnsi(result.join(''))).toContain('requires group_by and metrics');
    });

    it('handles all zeros (total = 0)', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: 0 },
          { category: 'B', count: 0 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      expect(stripAnsi(result.join(''))).toContain('No data');
    });

    it('renders distribution bar and legend', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: 50 },
          { category: 'B', count: 30 },
          { category: 'C', count: 20 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      // Should have bar and legend entries
      expect(result.length).toBeGreaterThan(3);
      const stripped = result.map(stripAnsi);
      // Should show percentages
      expect(stripped.some(line => line.includes('%'))).toBe(true);
    });

    it('calculates correct percentages', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: 100 },
          { category: 'B', count: 100 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      const stripped = result.map(stripAnsi).join(' ');
      // Each should be 50%
      expect(stripped.includes('50.0%')).toBe(true);
    });

    it('handles string values by parsing to number', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: '60' },
          { category: 'B', count: '40' },
        ],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      const stripped = result.map(stripAnsi).join(' ');
      expect(stripped.includes('60.0%')).toBe(true);
      expect(stripped.includes('40.0%')).toBe(true);
    });

    it('handles null/undefined dimension values', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: null, count: 50 },
          { category: 'B', count: 50 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('Unknown'))).toBe(true);
    });

    it('cycles through color palette for many items', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: 20 },
          { category: 'B', count: 20 },
          { category: 'C', count: 20 },
          { category: 'D', count: 20 },
          { category: 'E', count: 10 },
          { category: 'F', count: 10 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      // Should have legend entries for all 6 items
      const stripped = result.map(stripAnsi);
      expect(stripped.some(line => line.includes('A'))).toBe(true);
      expect(stripped.some(line => line.includes('F'))).toBe(true);
    });

    it('truncates long labels in legend', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'This is a very long category name', count: 100 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      // Labels in pie chart are sliced to 15 chars
      const stripped = result.map(stripAnsi).join('');
      expect(stripped.includes('This is a very long category name')).toBe(false);
    });

    it('shows values in parentheses in legend', () => {
      const view: ViewDefinition = {
        name: 'test',
        type: 'pie',
        group_by: ['category'],
        metrics: ['count'],
      };
      const data: QueryResult = {
        rows: [
          { category: 'A', count: 1000 },
          { category: 'B', count: 500 },
        ],
        columns: ['category', 'count'],
      };

      const result = renderPie(view, data, metricDefs, dimensionDefs);

      const stripped = result.map(stripAnsi).join(' ');
      // Should show formatted values in parentheses
      expect(stripped.includes('(1,000)')).toBe(true);
      expect(stripped.includes('(500)')).toBe(true);
    });
  });
});
