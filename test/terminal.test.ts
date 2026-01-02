import { describe, it, expect } from 'vitest';
import { padEnd, truncate, gradient, progressBar, colors, RESET } from '../src/lib/terminal.js';

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
  });
});
