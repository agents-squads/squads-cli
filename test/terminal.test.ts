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
  box,
  icons,
  spinnerFrames,
  cursor,
  clear,
  ESC,
  bold,
  dim,
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

    it('handles negative values gracefully', () => {
      const result = progressBar(-10, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });

    it('handles values over 100%', () => {
      const result = progressBar(150, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });

    it('handles undefined/NaN gracefully', () => {
      const result = progressBar(NaN, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });
  });

  describe('stripAnsi', () => {
    it('removes ANSI escape codes', () => {
      const colored = `${colors.green}hello${RESET}`;
      const result = stripAnsi(colored);
      expect(result).toBe('hello');
    });

    it('handles multiple ANSI codes', () => {
      const text = `${colors.green}green${RESET} ${colors.red}red${RESET}`;
      const result = stripAnsi(text);
      expect(result).toBe('green red');
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

  describe('sparkline', () => {
    it('generates sparkline for array of values', () => {
      const result = sparkline([1, 2, 3, 4, 5]);
      expect(result).toBeTruthy();
      expect(stripAnsi(result).length).toBe(5);
    });

    it('handles empty array', () => {
      const result = sparkline([]);
      expect(result).toBe('');
    });

    it('handles single value', () => {
      const result = sparkline([5]);
      expect(stripAnsi(result).length).toBe(1);
    });

    it('handles all zeros', () => {
      const result = sparkline([0, 0, 0]);
      expect(stripAnsi(result).length).toBe(3);
    });

    it('handles mixed values with zero', () => {
      const result = sparkline([0, 5, 10, 0, 5]);
      expect(stripAnsi(result).length).toBe(5);
    });
  });

  describe('barChart', () => {
    it('generates horizontal bar chart', () => {
      const result = barChart(50, 100, 20);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(20);
    });

    it('handles 0 value', () => {
      const result = barChart(0, 100, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });

    it('handles max value', () => {
      const result = barChart(100, 100, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });

    it('includes label when provided', () => {
      const result = barChart(50, 100, 10, '50%');
      expect(result).toContain('50%');
    });

    it('handles zero max gracefully', () => {
      const result = barChart(10, 0, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });

    it('handles negative values gracefully', () => {
      const result = barChart(-5, 100, 10);
      const visible = stripAnsi(result);
      expect(visible.length).toBe(10);
    });
  });

  describe('box characters', () => {
    it('has all required box drawing characters', () => {
      expect(box.topLeft).toBeDefined();
      expect(box.topRight).toBeDefined();
      expect(box.bottomLeft).toBeDefined();
      expect(box.bottomRight).toBeDefined();
      expect(box.horizontal).toBeDefined();
      expect(box.vertical).toBeDefined();
      expect(box.teeRight).toBeDefined();
      expect(box.teeLeft).toBeDefined();
    });
  });

  describe('icons', () => {
    it('has all required status icons', () => {
      expect(icons.success).toBeDefined();
      expect(icons.warning).toBeDefined();
      expect(icons.error).toBeDefined();
      expect(icons.pending).toBeDefined();
      expect(icons.active).toBeDefined();
      expect(icons.running).toBeDefined();
      expect(icons.progress).toBeDefined();
      expect(icons.empty).toBeDefined();
    });

    it('icons contain color codes', () => {
      expect(icons.success).toContain('\x1b[');
      expect(icons.error).toContain('\x1b[');
    });
  });

  describe('spinnerFrames', () => {
    it('has multiple frames', () => {
      expect(spinnerFrames.length).toBeGreaterThan(1);
    });
  });

  describe('cursor control', () => {
    it('generates cursor movement sequences', () => {
      expect(cursor.up(1)).toBe(`${ESC}1A`);
      expect(cursor.down(1)).toBe(`${ESC}1B`);
      expect(cursor.left(1)).toBe(`${ESC}1D`);
      expect(cursor.right(1)).toBe(`${ESC}1C`);
    });

    it('generates cursor position sequence', () => {
      const result = cursor.to(5, 10);
      expect(result).toBe(`${ESC}10;5H`);
    });

    it('has hide/show sequences', () => {
      expect(cursor.hide).toBeDefined();
      expect(cursor.show).toBeDefined();
    });

    it('has save/restore sequences', () => {
      expect(cursor.save).toBeDefined();
      expect(cursor.restore).toBeDefined();
    });
  });

  describe('clear sequences', () => {
    it('has line clear sequence', () => {
      expect(clear.line).toBeDefined();
      expect(clear.line).toContain(ESC);
    });

    it('has screen clear sequence', () => {
      expect(clear.screen).toBeDefined();
      expect(clear.screen).toContain(ESC);
    });

    it('has clear to end sequence', () => {
      expect(clear.toEnd).toBeDefined();
      expect(clear.toEnd).toContain(ESC);
    });
  });

  describe('text styles', () => {
    it('has bold style', () => {
      expect(bold).toBeDefined();
      expect(bold).toContain(ESC);
    });

    it('has dim style', () => {
      expect(dim).toBeDefined();
      expect(dim).toContain(ESC);
    });

    it('RESET clears formatting', () => {
      expect(RESET).toBe(`${ESC}0m`);
    });
  });

  describe('colors object', () => {
    it('has all required color properties', () => {
      expect(colors.purple).toBeDefined();
      expect(colors.pink).toBeDefined();
      expect(colors.cyan).toBeDefined();
      expect(colors.green).toBeDefined();
      expect(colors.yellow).toBeDefined();
      expect(colors.red).toBeDefined();
      expect(colors.gray).toBeDefined();
      expect(colors.dim).toBeDefined();
      expect(colors.white).toBeDefined();
    });

    it('colors contain ANSI escape codes', () => {
      expect(colors.green).toContain(ESC);
      expect(colors.red).toContain(ESC);
    });
  });
});
