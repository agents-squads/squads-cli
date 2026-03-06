import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('goal command', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-goal-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    // Create a squad with SQUAD.md
    const squadDir = join(testDir, '.agents', 'squads', 'marketing');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(
      join(squadDir, 'SQUAD.md'),
      `---
name: marketing
status: active
lead: lead
---

## Mission
Drive growth through content marketing.

## Goals

- [ ] Publish 5 blog posts this quarter
- [x] Set up analytics tracking
`
    );
    // Create lead agent
    writeFileSync(
      join(squadDir, 'lead.md'),
      `---
name: lead
role: Squad lead
status: active
---
`
    );
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('goalSetCommand', () => {
    it('adds a goal to an existing squad', async () => {
      const { goalSetCommand } = await import('../../src/commands/goal.js');
      await goalSetCommand('marketing', 'Launch email campaign', {});

      const content = readFileSync(
        join(testDir, '.agents', 'squads', 'marketing', 'SQUAD.md'),
        'utf-8'
      );
      expect(content).toContain('Launch email campaign');
    });

    it('appends metric annotations when provided', async () => {
      const { goalSetCommand } = await import('../../src/commands/goal.js');
      await goalSetCommand('marketing', 'Increase traffic', { metric: ['sessions', 'bounce-rate'] });

      const content = readFileSync(
        join(testDir, '.agents', 'squads', 'marketing', 'SQUAD.md'),
        'utf-8'
      );
      expect(content).toContain('Increase traffic [metrics: sessions, bounce-rate]');
    });

    it('handles non-existent squad gracefully', async () => {
      const { goalSetCommand } = await import('../../src/commands/goal.js');
      // Should not throw
      await goalSetCommand('nonexistent', 'Some goal', {});
    });
  });

  describe('goalListCommand', () => {
    it('lists goals for a specific squad without throwing', async () => {
      const { goalListCommand } = await import('../../src/commands/goal.js');
      // Should not throw
      await goalListCommand('marketing');
    });

    it('lists goals for all squads without throwing', async () => {
      const { goalListCommand } = await import('../../src/commands/goal.js');
      await goalListCommand();
    });

    it('handles squad with no goals', async () => {
      // Create squad with no goals section
      const emptySquadDir = join(testDir, '.agents', 'squads', 'empty');
      mkdirSync(emptySquadDir, { recursive: true });
      writeFileSync(
        join(emptySquadDir, 'SQUAD.md'),
        `---
name: empty
status: active
---

## Mission
An empty squad.
`
      );

      const { goalListCommand } = await import('../../src/commands/goal.js');
      await goalListCommand('empty');
    });

    it('shows completed goals with --all flag', async () => {
      const { goalListCommand } = await import('../../src/commands/goal.js');
      // Should not throw — the completed goal "Set up analytics tracking" should appear
      await goalListCommand('marketing', { all: true });
    });
  });

  describe('goalCompleteCommand', () => {
    it('marks a goal as completed', async () => {
      const { goalCompleteCommand } = await import('../../src/commands/goal.js');
      await goalCompleteCommand('marketing', '1');

      const content = readFileSync(
        join(testDir, '.agents', 'squads', 'marketing', 'SQUAD.md'),
        'utf-8'
      );
      // Goal 1 should now be marked as completed
      expect(content).toContain('[x] Publish 5 blog posts this quarter');
    });

    it('rejects invalid goal index', async () => {
      const { goalCompleteCommand } = await import('../../src/commands/goal.js');
      // Should not throw — just prints error
      await goalCompleteCommand('marketing', '99');
    });

    it('rejects non-numeric goal index', async () => {
      const { goalCompleteCommand } = await import('../../src/commands/goal.js');
      await goalCompleteCommand('marketing', 'abc');
    });

    it('handles non-existent squad', async () => {
      const { goalCompleteCommand } = await import('../../src/commands/goal.js');
      await goalCompleteCommand('nonexistent', '1');
    });
  });

  describe('goalProgressCommand', () => {
    it('updates progress on a goal', async () => {
      const { goalProgressCommand } = await import('../../src/commands/goal.js');
      await goalProgressCommand('marketing', '1', '3 of 5 posts published');

      const content = readFileSync(
        join(testDir, '.agents', 'squads', 'marketing', 'SQUAD.md'),
        'utf-8'
      );
      expect(content).toContain('3 of 5 posts published');
    });

    it('rejects invalid goal index', async () => {
      const { goalProgressCommand } = await import('../../src/commands/goal.js');
      await goalProgressCommand('marketing', '0', 'some progress');
    });

    it('handles non-existent squad', async () => {
      const { goalProgressCommand } = await import('../../src/commands/goal.js');
      await goalProgressCommand('nonexistent', '1', 'some progress');
    });
  });
});
