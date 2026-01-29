import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { findSquadsDir, listSquads, listAgents } from '../src/lib/squad-parser.js';

// Helper to resolve symlinks (macOS /var -> /private/var)
function normalizePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

describe('list command dependencies', () => {
  let testDir: string;
  let squadsDir: string;
  let originalCwd: string;

  beforeEach(() => {
    const rawDir = join(tmpdir(), 'squads-list-test-' + Date.now());
    mkdirSync(join(rawDir, '.agents', 'squads'), { recursive: true });
    // Normalize after creation to handle macOS /var -> /private/var symlink
    testDir = normalizePath(rawDir);
    squadsDir = normalizePath(join(testDir, '.agents', 'squads'));
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('findSquadsDir', () => {
    it('finds squads directory in current path', () => {
      const result = findSquadsDir();
      expect(normalizePath(result!)).toBe(squadsDir);
    });

    it('finds squads directory in parent path', () => {
      const subDir = join(testDir, 'sub', 'nested');
      mkdirSync(subDir, { recursive: true });
      process.chdir(subDir);

      const result = findSquadsDir();
      expect(normalizePath(result!)).toBe(squadsDir);
    });

    it('returns null when not in a squads project', () => {
      const emptyDir = join(tmpdir(), 'empty-' + Date.now());
      mkdirSync(emptyDir, { recursive: true });
      process.chdir(emptyDir);

      const result = findSquadsDir();
      expect(result).toBeNull();

      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('listSquads', () => {
    it('returns empty array for empty squads directory', () => {
      const result = listSquads(squadsDir);
      expect(result).toEqual([]);
    });

    it('lists squads with SQUAD.md files', () => {
      // Create engineering squad
      const engineeringDir = join(squadsDir, 'engineering');
      mkdirSync(engineeringDir);
      writeFileSync(join(engineeringDir, 'SQUAD.md'), '# Engineering Squad');

      // Create research squad
      const researchDir = join(squadsDir, 'research');
      mkdirSync(researchDir);
      writeFileSync(join(researchDir, 'SQUAD.md'), '# Research Squad');

      const result = listSquads(squadsDir);
      expect(result).toContain('engineering');
      expect(result).toContain('research');
      expect(result).toHaveLength(2);
    });

    it('ignores directories without SQUAD.md', () => {
      const validDir = join(squadsDir, 'valid');
      mkdirSync(validDir);
      writeFileSync(join(validDir, 'SQUAD.md'), '# Valid');

      const invalidDir = join(squadsDir, 'invalid');
      mkdirSync(invalidDir);
      writeFileSync(join(invalidDir, 'agent.md'), '# Some agent');

      const result = listSquads(squadsDir);
      expect(result).toContain('valid');
      expect(result).not.toContain('invalid');
    });

    it('ignores directories starting with underscore', () => {
      const normalDir = join(squadsDir, 'normal');
      mkdirSync(normalDir);
      writeFileSync(join(normalDir, 'SQUAD.md'), '# Normal');

      const hiddenDir = join(squadsDir, '_hidden');
      mkdirSync(hiddenDir);
      writeFileSync(join(hiddenDir, 'SQUAD.md'), '# Hidden');

      const result = listSquads(squadsDir);
      expect(result).toContain('normal');
      expect(result).not.toContain('_hidden');
    });
  });

  describe('listAgents', () => {
    beforeEach(() => {
      // Set up a squad with agents
      const squadDir = join(squadsDir, 'engineering');
      mkdirSync(squadDir, { recursive: true });
      writeFileSync(join(squadDir, 'SQUAD.md'), '# Engineering');
      writeFileSync(join(squadDir, 'code-reviewer.md'), '# Code Reviewer');
      writeFileSync(join(squadDir, 'ci-optimizer.md'), '# CI Optimizer');
    });

    it('lists all agents across all squads', () => {
      const result = listAgents(squadsDir);
      expect(result).toHaveLength(2);
      expect(result.some(a => a.name === 'code-reviewer')).toBe(true);
      expect(result.some(a => a.name === 'ci-optimizer')).toBe(true);
    });

    it('lists agents for a specific squad', () => {
      // Add another squad
      const otherDir = join(squadsDir, 'research');
      mkdirSync(otherDir);
      writeFileSync(join(otherDir, 'SQUAD.md'), '# Research');
      writeFileSync(join(otherDir, 'analyst.md'), '# Analyst');

      const result = listAgents(squadsDir, 'engineering');
      expect(result).toHaveLength(2);
      expect(result.every(a => a.name !== 'analyst')).toBe(true);
    });

    it('excludes SQUAD.md from agent list', () => {
      const result = listAgents(squadsDir, 'engineering');
      expect(result.every(a => a.name !== 'SQUAD')).toBe(true);
    });

    it('returns empty array for non-existent squad', () => {
      const result = listAgents(squadsDir, 'nonexistent');
      expect(result).toEqual([]);
    });

    it('includes file path in agent metadata', () => {
      const result = listAgents(squadsDir, 'engineering');
      const codeReviewer = result.find(a => a.name === 'code-reviewer');
      expect(codeReviewer?.filePath).toContain('code-reviewer.md');
    });
  });
});
