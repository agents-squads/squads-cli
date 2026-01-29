/**
 * Tests for dashboard base renderer utilities
 * Tests pure formatting functions without terminal output side effects
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatValue,
  getThresholdColor,
  calculateColumnWidths,
} from '../src/lib/dashboard/renderers/base.js';
import { colors } from '../src/lib/terminal.js';

describe('formatValue', () => {
  describe('number format', () => {
    it('should format small numbers with locale string', () => {
      const result = formatValue(123, 'number');
      expect(result).toBe('123');
    });

    it('should format thousands with k suffix', () => {
      const result = formatValue(5000, 'number');
      expect(result).toBe('5.0k');
    });

    it('should format millions with M suffix', () => {
      const result = formatValue(2500000, 'number');
      expect(result).toBe('2.5M');
    });

    it('should handle string numbers', () => {
      const result = formatValue('7500', 'number');
      expect(result).toBe('7.5k');
    });

    it('should return original for invalid numbers', () => {
      const result = formatValue('abc', 'number');
      expect(result).toBe('abc');
    });
  });

  describe('currency format', () => {
    it('should format as dollar amount', () => {
      const result = formatValue(99.5, 'currency');
      expect(result).toBe('$99.50');
    });

    it('should format integers with cents', () => {
      const result = formatValue(100, 'currency');
      expect(result).toBe('$100.00');
    });

    it('should handle string amounts', () => {
      const result = formatValue('25.123', 'currency');
      expect(result).toBe('$25.12');
    });
  });

  describe('percent format', () => {
    it('should format percentage with one decimal', () => {
      const result = formatValue(75.5, 'percent');
      expect(result).toBe('75.5%');
    });

    it('should handle integer percentages', () => {
      const result = formatValue(100, 'percent');
      expect(result).toBe('100.0%');
    });
  });

  describe('duration format', () => {
    it('should format seconds', () => {
      const result = formatValue(45.5, 'duration');
      expect(result).toBe('45.5s');
    });

    it('should format minutes and seconds', () => {
      const result = formatValue(125, 'duration');
      expect(result).toBe('2m 5s');
    });

    it('should format hours and minutes', () => {
      const result = formatValue(7500, 'duration');
      expect(result).toBe('2h 5m');
    });
  });

  describe('tokens format', () => {
    it('should format small token counts', () => {
      const result = formatValue(500, 'tokens');
      expect(result).toBe('500');
    });

    it('should format thousands with k suffix', () => {
      const result = formatValue(5000, 'tokens');
      expect(result).toBe('5k');
    });

    it('should format millions with M suffix', () => {
      const result = formatValue(1500000, 'tokens');
      expect(result).toBe('1.5M');
    });
  });

  describe('null/undefined handling', () => {
    it('should return dash for null', () => {
      const result = formatValue(null, 'number');
      expect(result).toContain('—');
    });

    it('should return dash for undefined', () => {
      const result = formatValue(undefined, 'currency');
      expect(result).toContain('—');
    });
  });

  describe('default format with truncation', () => {
    it('should truncate long strings when truncateLen is provided', () => {
      const result = formatValue('This is a very long string that should be truncated', 'text', 20);
      // The truncate function returns visible length + ellipsis, may include ANSI codes
      // Just verify it's shorter than the original
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBeLessThanOrEqual(20);
    });

    it('should not truncate short strings', () => {
      const result = formatValue('Short', 'text', 20);
      expect(result).toBe('Short');
    });
  });
});

describe('getThresholdColor', () => {
  describe('direction up (higher is better)', () => {
    it('should return green for values at or above good threshold', () => {
      const result = getThresholdColor(85, { good: 80, warning: 50, direction: 'up' });
      expect(result).toBe(colors.green);
    });

    it('should return yellow for values between warning and good', () => {
      const result = getThresholdColor(60, { good: 80, warning: 50, direction: 'up' });
      expect(result).toBe(colors.yellow);
    });

    it('should return red for values below warning', () => {
      const result = getThresholdColor(30, { good: 80, warning: 50, direction: 'up' });
      expect(result).toBe(colors.red);
    });

    it('should use default thresholds', () => {
      const result = getThresholdColor(90, {});
      expect(result).toBe(colors.green);
    });
  });

  describe('direction down (lower is better)', () => {
    it('should return green for values at or below good threshold', () => {
      const result = getThresholdColor(5, { good: 10, warning: 30, direction: 'down' });
      expect(result).toBe(colors.green);
    });

    it('should return yellow for values between good and warning', () => {
      const result = getThresholdColor(20, { good: 10, warning: 30, direction: 'down' });
      expect(result).toBe(colors.yellow);
    });

    it('should return red for values above warning', () => {
      const result = getThresholdColor(50, { good: 10, warning: 30, direction: 'down' });
      expect(result).toBe(colors.red);
    });
  });
});

describe('calculateColumnWidths', () => {
  it('should calculate widths based on header and data', () => {
    const rows = [
      { name: 'Alice', score: 100 },
      { name: 'Bob', score: 95 },
    ];
    const columns = [
      { field: 'name', label: 'Name' },
      { field: 'score', label: 'Score' },
    ];
    const widths = calculateColumnWidths(rows, columns);

    // Name column: max of 'Name' (4) and 'Alice' (5) + 2 padding = 7
    // Score column: max of 'Score' (5) and '100' (3) + 2 padding = 7
    expect(widths[0]).toBeGreaterThanOrEqual(6);
    expect(widths[1]).toBeGreaterThanOrEqual(5);
  });

  it('should use field name when label is not provided', () => {
    const rows = [{ id: 1 }];
    const columns = [{ field: 'id' }];
    const widths = calculateColumnWidths(rows, columns);

    // 'id' (2) + 2 padding = 4
    expect(widths[0]).toBeGreaterThanOrEqual(4);
  });

  it('should cap individual column width at 30', () => {
    const rows = [
      { description: 'A'.repeat(50) }, // 50 character value
    ];
    const columns = [{ field: 'description', label: 'Desc' }];
    const widths = calculateColumnWidths(rows, columns, 100);

    expect(widths[0]).toBeLessThanOrEqual(30);
  });

  it('should scale down widths when total exceeds maxWidth', () => {
    const rows = [
      { col1: 'A'.repeat(25), col2: 'B'.repeat(25), col3: 'C'.repeat(25) },
    ];
    const columns = [
      { field: 'col1', label: 'Column1' },
      { field: 'col2', label: 'Column2' },
      { field: 'col3', label: 'Column3' },
    ];
    const widths = calculateColumnWidths(rows, columns, 50);

    // Total should not exceed maxWidth
    const total = widths.reduce((sum, w) => sum + w, 0);
    expect(total).toBeLessThanOrEqual(50);
  });

  it('should ensure minimum width of 5 when scaling down', () => {
    const rows = [
      { a: 'X'.repeat(50), b: 'Y'.repeat(50) },
    ];
    const columns = [
      { field: 'a' },
      { field: 'b' },
    ];
    const widths = calculateColumnWidths(rows, columns, 10);

    // Each column should be at least 5
    expect(widths[0]).toBeGreaterThanOrEqual(5);
    expect(widths[1]).toBeGreaterThanOrEqual(5);
  });

  it('should handle empty rows', () => {
    const columns = [{ field: 'name', label: 'Name' }];
    const widths = calculateColumnWidths([], columns);

    // Should use header length + padding
    expect(widths[0]).toBeGreaterThanOrEqual(4);
  });

  it('should handle undefined values in rows', () => {
    const rows = [
      { name: 'Alice' },
      { name: undefined },
    ];
    const columns = [{ field: 'name', label: 'Name' }];
    const widths = calculateColumnWidths(rows, columns);

    // Should handle undefined gracefully
    expect(widths[0]).toBeGreaterThanOrEqual(4);
  });
});
