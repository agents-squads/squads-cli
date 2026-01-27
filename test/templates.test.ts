import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  toKebabCase,
  toTitleCase,
  getTemplateSource,
  templateExists,
  getLocalEnvVars,
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
    it('formats all stopped services correctly', () => {
      const status = {
        running: false,
        services: [
          { name: 'postgres', port: 5433, healthUrl: '', running: false },
          { name: 'langfuse', port: 3100, healthUrl: 'http://localhost:3100/api/public/health', running: false },
          { name: 'redis', port: 6379, healthUrl: '', running: false },
        ],
        configPath: null,
      };

      const result = formatLocalStatus(status);
      expect(result).toContain('Local Stack Status:');
      expect(result).toContain('○ postgres');
      expect(result).toContain('○ langfuse');
      expect(result).toContain('○ redis');
      expect(result).toContain('stopped');
      expect(result).toContain('docker-compose up -d');
    });

    it('formats running services correctly', () => {
      const status = {
        running: true,
        services: [
          { name: 'postgres', port: 5433, healthUrl: '', running: true },
          { name: 'langfuse', port: 3100, healthUrl: 'http://localhost:3100/api/public/health', running: true },
          { name: 'redis', port: 6379, healthUrl: '', running: true },
        ],
        configPath: '/path/to/docker-compose.yml',
      };

      const result = formatLocalStatus(status);
      expect(result).toContain('● postgres');
      expect(result).toContain('● langfuse');
      expect(result).toContain('● redis');
      expect(result).toContain('running');
    });

    it('shows langfuse start hint when only langfuse is stopped', () => {
      const status = {
        running: true,
        services: [
          { name: 'postgres', port: 5433, healthUrl: '', running: true },
          { name: 'langfuse', port: 3100, healthUrl: 'http://localhost:3100/api/public/health', running: false },
          { name: 'redis', port: 6379, healthUrl: '', running: true },
        ],
        configPath: null,
      };

      const result = formatLocalStatus(status);
      expect(result).toContain('Langfuse not running');
      expect(result).toContain('docker-compose up -d langfuse');
    });

    it('formats port numbers correctly', () => {
      const status = {
        running: false,
        services: [
          { name: 'postgres', port: 5433, healthUrl: '', running: false },
          { name: 'langfuse', port: 3100, healthUrl: '', running: false },
          { name: 'redis', port: 6379, healthUrl: '', running: false },
        ],
        configPath: null,
      };

      const result = formatLocalStatus(status);
      expect(result).toContain(':5433');
      expect(result).toContain(':3100');
      expect(result).toContain(':6379');
    });
  });
});
