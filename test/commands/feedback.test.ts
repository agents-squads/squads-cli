import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('feedback command', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-feedback-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    // Create squad with lead agent
    const squadDir = join(testDir, '.agents', 'squads', 'engineering');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(
      join(squadDir, 'SQUAD.md'),
      `---
name: engineering
status: active
lead: lead
---

## Mission
Build great software.

## Agents

| agent | role | trigger | status |
|-------|------|---------|--------|
| lead | Squad lead | manual | active |
`
    );
    writeFileSync(
      join(squadDir, 'lead.md'),
      `---
name: lead
role: Squad lead
status: active
---
`
    );

    // Create memory directory
    // Note: getFeedbackPath uses squad.agents[0]?.name || `${squadName}-lead`
    // Since parseSquadFile may not find agents in table format, it falls back
    const memoryDir = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead');
    mkdirSync(memoryDir, { recursive: true });

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

  describe('feedbackAddCommand', () => {
    it('creates feedback file with rating and text', async () => {
      const { feedbackAddCommand } = await import('../../src/commands/feedback.js');
      await feedbackAddCommand('engineering', '4', 'Good execution, clean output', {});

      const feedbackPath = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead', 'feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);

      const content = readFileSync(feedbackPath, 'utf-8');
      expect(content).toContain('engineering');
      expect(content).toContain('4/5');
      expect(content).toContain('Good execution, clean output');
      expect(content).toContain('★★★★☆');
    });

    it('rejects rating below 1', async () => {
      const { feedbackAddCommand } = await import('../../src/commands/feedback.js');
      await feedbackAddCommand('engineering', '0', 'Bad', {});

      const feedbackPath = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead', 'feedback.md');
      expect(existsSync(feedbackPath)).toBe(false);
    });

    it('rejects rating above 5', async () => {
      const { feedbackAddCommand } = await import('../../src/commands/feedback.js');
      await feedbackAddCommand('engineering', '6', 'Too much', {});

      const feedbackPath = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead', 'feedback.md');
      expect(existsSync(feedbackPath)).toBe(false);
    });

    it('rejects non-numeric rating', async () => {
      const { feedbackAddCommand } = await import('../../src/commands/feedback.js');
      await feedbackAddCommand('engineering', 'abc', 'Invalid', {});

      const feedbackPath = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead', 'feedback.md');
      expect(existsSync(feedbackPath)).toBe(false);
    });

    it('appends multiple feedback entries to same file', async () => {
      const { feedbackAddCommand } = await import('../../src/commands/feedback.js');
      await feedbackAddCommand('engineering', '3', 'Decent work', {});
      await feedbackAddCommand('engineering', '5', 'Excellent output', {});

      const feedbackPath = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead', 'feedback.md');
      const content = readFileSync(feedbackPath, 'utf-8');
      expect(content).toContain('3/5');
      expect(content).toContain('5/5');
      expect(content).toContain('Decent work');
      expect(content).toContain('Excellent output');
    });

    it('includes learnings when provided', async () => {
      const { feedbackAddCommand } = await import('../../src/commands/feedback.js');
      await feedbackAddCommand('engineering', '4', 'Good work', {
        learning: ['Always test edge cases', 'Use descriptive names'],
      });

      const feedbackPath = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead', 'feedback.md');
      const content = readFileSync(feedbackPath, 'utf-8');
      expect(content).toContain('Always test edge cases');
      expect(content).toContain('Use descriptive names');
      expect(content).toContain('**Learnings**');
    });
  });

  describe('feedbackShowCommand', () => {
    it('handles squad with no feedback gracefully', async () => {
      const { feedbackShowCommand } = await import('../../src/commands/feedback.js');
      // Should not throw
      await feedbackShowCommand('engineering', {});
    });

    it('shows feedback entries when they exist', async () => {
      // Create a feedback file
      const feedbackPath = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead', 'feedback.md');
      writeFileSync(feedbackPath, `# engineering - Feedback Log

> Execution feedback and learnings

---
_Date: 2026-03-05_

**Execution**: Manual feedback
**Rating**: 4/5 ★★★★☆
**Feedback**: Solid work on the API
`);

      const { feedbackShowCommand } = await import('../../src/commands/feedback.js');
      // Should not throw
      await feedbackShowCommand('engineering', {});
    });

    it('respects limit option', async () => {
      const { feedbackShowCommand } = await import('../../src/commands/feedback.js');
      // Should not throw with limit
      await feedbackShowCommand('engineering', { limit: '1' });
    });
  });

  describe('parseFeedbackHistory (via feedbackShowCommand)', () => {
    it('parses multiple feedback entries from markdown', async () => {
      const feedbackPath = join(testDir, '.agents', 'memory', 'engineering', 'engineering-lead', 'feedback.md');
      writeFileSync(feedbackPath, `# engineering - Feedback Log

> Execution feedback and learnings

---
_Date: 2026-03-04_

**Execution**: Daily run
**Rating**: 3/5 ★★★☆☆
**Feedback**: Average performance

---
_Date: 2026-03-05_

**Execution**: Sprint work
**Rating**: 5/5 ★★★★★
**Feedback**: Outstanding results
**Learnings**:
- Ship early, iterate fast
- Always validate input
`);

      const { feedbackShowCommand } = await import('../../src/commands/feedback.js');
      // Should parse and display both entries without throwing
      await feedbackShowCommand('engineering', {});
    });
  });
});
