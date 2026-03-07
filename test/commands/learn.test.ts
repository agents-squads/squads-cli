import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('learn command', () => {
  let testDir: string;
  let originalCwd: string;
  let memoryDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-learn-test-' + Date.now());
    memoryDir = join(testDir, '.agents', 'memory');
    mkdirSync(memoryDir, { recursive: true });

    // Create a squad so learnCommand can validate squad names
    const engineeringSquadDir = join(testDir, '.agents', 'squads', 'engineering');
    mkdirSync(engineeringSquadDir, { recursive: true });
    writeFileSync(
      join(engineeringSquadDir, 'SQUAD.md'),
      `---
name: engineering
status: active
lead: lead
---

## Mission
Build and maintain infrastructure.
`
    );

    originalCwd = process.cwd();
    process.chdir(testDir);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe('learnCommand', () => {
    it('saves a learning to general squad by default', async () => {
      const { learnCommand } = await import('../../src/commands/learn.js');
      await learnCommand('Always run tests before merging', {});

      const learningsPath = join(memoryDir, 'general', 'shared', 'learnings.md');
      expect(existsSync(learningsPath)).toBe(true);

      const content = readFileSync(learningsPath, 'utf-8');
      expect(content).toContain('Always run tests before merging');
    });

    it('saves a learning to a specific squad', async () => {
      const { learnCommand } = await import('../../src/commands/learn.js');
      await learnCommand('Deploy on Fridays failed twice', { squad: 'engineering' });

      const learningsPath = join(memoryDir, 'engineering', 'shared', 'learnings.md');
      expect(existsSync(learningsPath)).toBe(true);

      const content = readFileSync(learningsPath, 'utf-8');
      expect(content).toContain('Deploy on Fridays failed twice');
    });

    it('falls back to general when squad not found', async () => {
      const { learnCommand } = await import('../../src/commands/learn.js');
      await learnCommand('Some insight', { squad: 'nonexistent' });

      const generalPath = join(memoryDir, 'general', 'shared', 'learnings.md');
      expect(existsSync(generalPath)).toBe(true);
    });

    it('infers failure category from insight text', async () => {
      const { learnCommand } = await import('../../src/commands/learn.js');
      await learnCommand('This approach failed to handle edge cases', {});

      const learningsPath = join(memoryDir, 'general', 'shared', 'learnings.md');
      const content = readFileSync(learningsPath, 'utf-8');
      expect(content).toContain('**Failure**');
    });

    it('infers success category from insight text', async () => {
      const { learnCommand } = await import('../../src/commands/learn.js');
      await learnCommand('The new approach worked and fixed the issue', {});

      const learningsPath = join(memoryDir, 'general', 'shared', 'learnings.md');
      const content = readFileSync(learningsPath, 'utf-8');
      expect(content).toContain('**Success**');
    });

    it('accepts explicit category option', async () => {
      const { learnCommand } = await import('../../src/commands/learn.js');
      await learnCommand('Whenever you use X, always check Y', { category: 'pattern' });

      const learningsPath = join(memoryDir, 'general', 'shared', 'learnings.md');
      const content = readFileSync(learningsPath, 'utf-8');
      expect(content).toContain('**Pattern**');
    });

    it('auto-extracts tags from insight text', async () => {
      const { learnCommand } = await import('../../src/commands/learn.js');
      await learnCommand('Database query was slow, needed index for performance', {});

      const learningsPath = join(memoryDir, 'general', 'shared', 'learnings.md');
      const content = readFileSync(learningsPath, 'utf-8');
      // Should auto-tag with 'db' and 'perf'
      expect(content).toMatch(/Tags:.*`[^`]*`/);
    });

    it('appends multiple learnings to same file', async () => {
      const { learnCommand } = await import('../../src/commands/learn.js');
      await learnCommand('First insight', {});
      await learnCommand('Second insight', {});

      const learningsPath = join(memoryDir, 'general', 'shared', 'learnings.md');
      const content = readFileSync(learningsPath, 'utf-8');
      expect(content).toContain('First insight');
      expect(content).toContain('Second insight');
    });

    it('handles missing .agents directory gracefully', async () => {
      // Remove the .agents directory
      rmSync(join(testDir, '.agents'), { recursive: true, force: true });

      const { learnCommand } = await import('../../src/commands/learn.js');
      // Should not throw
      await expect(learnCommand('Some insight', {})).resolves.toBeUndefined();
    });
  });

  describe('learnShowCommand', () => {
    it('shows message when no learnings recorded for squad', async () => {
      const { learnShowCommand } = await import('../../src/commands/learn.js');

      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
        output += data;
        return true;
      });

      await learnShowCommand('engineering', {});

      expect(output).toContain('No learnings recorded');
    });

    it('displays learnings for a squad', async () => {
      // First add a learning
      const { learnCommand, learnShowCommand } = await import('../../src/commands/learn.js');
      await learnCommand('Testing is important', { squad: 'engineering' });

      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
        output += data;
        return true;
      });

      await learnShowCommand('engineering', {});

      expect(output).toContain('Testing is important');
    });

    it('filters by category', async () => {
      const { learnCommand, learnShowCommand } = await import('../../src/commands/learn.js');
      await learnCommand('This pattern worked', { squad: 'engineering', category: 'pattern' });
      await learnCommand('This fixed the bug', { squad: 'engineering', category: 'success' });

      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
        output += data;
        return true;
      });

      await learnShowCommand('engineering', { category: 'pattern' });

      expect(output).toContain('This pattern worked');
    });
  });

  describe('learnSearchCommand', () => {
    it('shows message when no matches found', async () => {
      const { learnSearchCommand } = await import('../../src/commands/learn.js');

      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
        output += data;
        return true;
      });

      await learnSearchCommand('completely unique query xyz', {});

      expect(output).toContain('No learnings found');
    });

    it('finds learnings matching search query', async () => {
      const { learnCommand, learnSearchCommand } = await import('../../src/commands/learn.js');
      await learnCommand('Redis caching improved performance by 50%', {});

      let output = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
        output += data;
        return true;
      });

      await learnSearchCommand('Redis', {});

      expect(output).toContain('Redis');
    });
  });
});
