import { describe, it, expect } from 'vitest';
import { padEnd, truncate, gradient, progressBar, stripAnsi, sparkline, barChart, colors, RESET } from '../src/lib/terminal.js';

describe('terminal utilities', () => {
  describe('padEnd', () => {
    it('pads string to specified length', () => {
      const result = padEnd('test', 10);
      expect(result).toBe('test      ');
    });

    it('does not truncate if string is longer', () => {
      const result = padEnd('hello world', 5);
      expect(result).toBe('hello world');
    });

    it('handles empty string', () => {
      const result = padEnd('', 5);
      expect(result).toBe('     ');
    });

    it('ignores ANSI codes when calculating length', () => {
      const coloredText = `${colors.green}test${RESET}`;
      const result = padEnd(coloredText, 10);
      // Should have 6 spaces of padding (10 - 4 visible chars)
      expect(result.endsWith('      ')).toBe(true);
    });
  });

  describe('truncate', () => {
    it('truncates long strings with ellipsis', () => {
      const result = truncate('hello world', 5);
      // Should be 4 chars + ellipsis
      expect(result.replace(/\x1b\[[0-9;]*m/g, '')).toBe('hell…');
    });

    it('does not truncate short strings', () => {
      const result = truncate('hi', 10);
      expect(result).toBe('hi');
    });

    it('handles exact length', () => {
      const result = truncate('hello', 5);
      expect(result).toBe('hello');
    });
  });

  describe('gradient', () => {
    it('returns string with ANSI codes', () => {
      const result = gradient('test');
      expect(result).toContain('\x1b['); // Contains ANSI escape
      expect(result).toContain('t');
      expect(result).toContain('e');
      expect(result).toContain('s');
    });

    it('ends with RESET', () => {
      const result = gradient('test');
      expect(result.endsWith(RESET)).toBe(true);
    });

    it('handles empty string', () => {
      const result = gradient('');
      expect(result).toBe(RESET);
    });
  });

  describe('progressBar', () => {
    it('returns bar with correct characters', () => {
      const result = progressBar(50, 10);
      expect(result).toContain('━');
    });

    it('handles 0%', () => {
      const result = progressBar(0, 10);
      // Should have 10 empty bars
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible).toBe('━━━━━━━━━━');
    });

    it('handles 100%', () => {
      const result = progressBar(100, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles negative values', () => {
      const result = progressBar(-50, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible).toBe('━━━━━━━━━━');
    });

    it('handles values over 100%', () => {
      const result = progressBar(150, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles undefined/NaN values', () => {
      const result = progressBar(NaN, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible).toBe('━━━━━━━━━━');
    });
  });

  describe('stripAnsi', () => {
    it('removes ANSI color codes from string', () => {
      const colored = `${colors.green}test${RESET}`;
      const result = stripAnsi(colored);
      expect(result).toBe('test');
    });

    it('removes multiple ANSI codes', () => {
      const colored = `${colors.red}hello${RESET} ${colors.green}world${RESET}`;
      const result = stripAnsi(colored);
      expect(result).toBe('hello world');
    });

    it('handles string with no ANSI codes', () => {
      const result = stripAnsi('plain text');
      expect(result).toBe('plain text');
    });

    it('handles empty string', () => {
      const result = stripAnsi('');
      expect(result).toBe('');
    });

    it('removes RGB ANSI codes', () => {
      const rgbColored = '\x1b[38;2;255;0;0mred\x1b[0m';
      const result = stripAnsi(rgbColored);
      expect(result).toBe('red');
    });
  });

  describe('sparkline', () => {
    it('generates sparkline from values', () => {
      const result = sparkline([1, 2, 3, 4, 5]);
      // Should contain block characters
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(5);
    });

    it('handles empty array', () => {
      const result = sparkline([]);
      expect(result).toBe('');
    });

    it('handles single value', () => {
      const result = sparkline([50]);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(1);
    });

    it('handles all zeros', () => {
      const result = sparkline([0, 0, 0]);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(3);
    });

    it('handles identical values', () => {
      const result = sparkline([5, 5, 5, 5]);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(4);
    });

    it('normalizes values to max', () => {
      const result = sparkline([0, 50, 100]);
      // Should contain different block heights
      expect(result).toContain('\x1b['); // Should have color codes
    });
  });

  describe('barChart', () => {
    it('generates bar chart with correct width', () => {
      const result = barChart(50, 100, 20);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(20);
    });

    it('handles 0 value', () => {
      const result = barChart(0, 100, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles max value', () => {
      const result = barChart(100, 100, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles value exceeding max', () => {
      const result = barChart(150, 100, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles label parameter', () => {
      const result = barChart(50, 100, 10, '50%');
      expect(result).toContain('50%');
    });

    it('handles negative values', () => {
      const result = barChart(-10, 100, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles zero max (division by zero guard)', () => {
      const result = barChart(50, 0, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles undefined/NaN value', () => {
      const result = barChart(NaN, 100, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles undefined/NaN max', () => {
      const result = barChart(50, NaN, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('uses default width when not specified', () => {
      const result = barChart(50, 100);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(20); // Default is 20
    });
  });
});
