import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  padEnd,
  truncate,
  gradient,
  progressBar,
  colors,
  RESET,
  stripAnsi,
  sparkline,
  barChart,
  rgb,
  bgRgb,
  cursor,
  clear,
  box,
  icons,
} from '../src/lib/terminal.js';

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
      const result = progressBar(-10, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });

    it('handles over 100%', () => {
      const result = progressBar(150, 10);
      const visible = result.replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBe(10);
    });
  });

  describe('stripAnsi', () => {
    it('removes ANSI escape codes', () => {
      const colored = `${colors.green}hello${RESET} world`;
      const result = stripAnsi(colored);
      expect(result).toBe('hello world');
    });

    it('handles string without ANSI codes', () => {
      const result = stripAnsi('plain text');
      expect(result).toBe('plain text');
    });

    it('handles empty string', () => {
      const result = stripAnsi('');
      expect(result).toBe('');
    });
  });

  describe('rgb and bgRgb', () => {
    it('generates valid RGB escape codes', () => {
      const result = rgb(255, 128, 64);
      expect(result).toBe('\x1b[38;2;255;128;64m');
    });

    it('generates valid background RGB escape codes', () => {
      const result = bgRgb(255, 128, 64);
      expect(result).toBe('\x1b[48;2;255;128;64m');
    });
  });

  describe('cursor control', () => {
    it('generates cursor movement codes', () => {
      expect(cursor.up(3)).toBe('\x1b[3A');
      expect(cursor.down(2)).toBe('\x1b[2B');
      expect(cursor.left(5)).toBe('\x1b[5D');
      expect(cursor.right(4)).toBe('\x1b[4C');
    });

    it('generates cursor position code', () => {
      expect(cursor.to(10, 20)).toBe('\x1b[20;10H');
    });

    it('has hide and show codes', () => {
      expect(cursor.hide).toBe('\x1b[?25l');
      expect(cursor.show).toBe('\x1b[?25h');
    });
  });

  describe('clear codes', () => {
    it('has line clear codes', () => {
      expect(clear.line).toBe('\x1b[2K');
      expect(clear.toEnd).toBe('\x1b[0K');
    });

    it('has screen clear code', () => {
      expect(clear.screen).toBe('\x1b[2J\x1b[0;0H');
    });
  });

  describe('box characters', () => {
    it('has all box drawing characters', () => {
      expect(box.topLeft).toBeDefined();
      expect(box.topRight).toBeDefined();
      expect(box.bottomLeft).toBeDefined();
      expect(box.bottomRight).toBeDefined();
      expect(box.horizontal).toBeDefined();
      expect(box.vertical).toBeDefined();
      expect(box.teeLeft).toBeDefined();
      expect(box.teeRight).toBeDefined();
    });
  });

  describe('icons', () => {
    it('has all status icons', () => {
      expect(icons.success).toBeDefined();
      expect(icons.warning).toBeDefined();
      expect(icons.error).toBeDefined();
      expect(icons.pending).toBeDefined();
      expect(icons.active).toBeDefined();
      expect(icons.running).toBeDefined();
      expect(icons.progress).toBeDefined();
      expect(icons.empty).toBeDefined();
    });
  });

  describe('sparkline', () => {
    it('generates sparkline from values', () => {
      const result = sparkline([1, 2, 3, 4, 5]);
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles empty array', () => {
      const result = sparkline([]);
      expect(result).toBe('');
    });

    it('handles single value', () => {
      const result = sparkline([5]);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(1);
    });

    it('handles all zeros', () => {
      const result = sparkline([0, 0, 0]);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(3);
    });
  });

  describe('barChart', () => {
    it('generates bar chart', () => {
      const result = barChart(50, 100, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });

    it('handles zero value', () => {
      const result = barChart(0, 100, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });

    it('handles full value', () => {
      const result = barChart(100, 100, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });

    it('adds label when provided', () => {
      const result = barChart(50, 100, 10, 'test');
      expect(result).toContain('test');
    });

    it('handles zero max safely', () => {
      const result = barChart(50, 0, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });
  });
});
