import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  toKebabCase,
  toTitleCase,
  getTemplateSource,
  templateExists,
} from '../src/lib/templates';
import { formatLocalStatus } from '../src/lib/local';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('templates utilities', () => {
  describe('toKebabCase', () => {
    it('converts simple names to kebab-case', () => {
      expect(toKebabCase('My Squad')).toBe('my-squad');
    });

    it('handles multiple spaces', () => {
      expect(toKebabCase('My   First   Squad')).toBe('my-first-squad');
    });

    it('handles mixed case', () => {
      expect(toKebabCase('MySquadName')).toBe('mysquadname');
    });

    it('removes special characters', () => {
      expect(toKebabCase('My Squad!')).toBe('my-squad');
      expect(toKebabCase('Test @#$ Squad')).toBe('test-squad');
    });

    it('handles already kebab-case strings', () => {
      expect(toKebabCase('my-squad')).toBe('my-squad');
    });

    it('handles leading/trailing spaces', () => {
      expect(toKebabCase('  My Squad  ')).toBe('my-squad');
    });

    it('handles leading/trailing dashes', () => {
      expect(toKebabCase('-my-squad-')).toBe('my-squad');
    });

    it('handles numbers', () => {
      expect(toKebabCase('Squad 1')).toBe('squad-1');
      expect(toKebabCase('123 Squad')).toBe('123-squad');
    });

    it('handles empty string', () => {
      expect(toKebabCase('')).toBe('');
    });

    it('collapses multiple dashes', () => {
      expect(toKebabCase('my--squad')).toBe('my-squad');
      expect(toKebabCase('my---squad')).toBe('my-squad');
    });
  });

  describe('toTitleCase', () => {
    it('converts simple names to Title Case', () => {
      expect(toTitleCase('my squad')).toBe('My Squad');
    });

    it('handles kebab-case input', () => {
      expect(toTitleCase('my-squad')).toBe('My Squad');
    });

    it('handles underscore-separated input', () => {
      expect(toTitleCase('my_squad')).toBe('My Squad');
    });

    it('handles mixed separators', () => {
      expect(toTitleCase('my-first_squad name')).toBe('My First Squad Name');
    });

    it('handles single word', () => {
      expect(toTitleCase('squad')).toBe('Squad');
    });

    it('handles UPPERCASE input', () => {
      expect(toTitleCase('MY SQUAD')).toBe('My Squad');
    });

    it('handles empty string', () => {
      expect(toTitleCase('')).toBe('');
    });

    it('handles multiple consecutive separators', () => {
      expect(toTitleCase('my--squad')).toBe('My Squad');
    });
  });

  describe('getTemplateSource', () => {
    it('returns a valid TemplateSource object', () => {
      const source = getTemplateSource();
      expect(source).toHaveProperty('type');
      expect(source).toHaveProperty('path');
      expect(source).toHaveProperty('description');
      expect(['repo', 'global', 'bundled']).toContain(source.type);
    });
  });
});

describe('local utilities', () => {
  describe('formatLocalStatus', () => {
    it('formats unavailable services correctly', () => {
      const status = {
        running: false,
        services: [
          { name: 'API', url: '', running: false },
          { name: 'Traces', url: '', running: false },
        ],
      };

      const result = formatLocalStatus(status);
      expect(result).toContain('Service Status');
      expect(result).toContain('○ API');
      expect(result).toContain('○ Traces');
      expect(result).toContain('unavailable');
      expect(result).toContain('squads login');
    });

    it('formats running services correctly', () => {
      const status = {
        running: true,
        services: [
          { name: 'API', url: 'http://localhost:8088/health', running: true },
          { name: 'Traces', url: 'http://localhost:3100/api/public/health', running: true },
        ],
      };

      const result = formatLocalStatus(status);
      expect(result).toContain('● API');
      expect(result).toContain('● Traces');
      expect(result).toContain('running');
    });

    it('shows mixed status correctly', () => {
      const status = {
        running: true,
        services: [
          { name: 'API', url: 'http://localhost:8088/health', running: true },
          { name: 'Traces', url: '', running: false },
        ],
      };

      const result = formatLocalStatus(status);
      expect(result).toContain('● API');
      expect(result).toContain('○ Traces');
    });
  });
});
