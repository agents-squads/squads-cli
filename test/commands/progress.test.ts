import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('progress command', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-progress-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    // Create minimal .agents structure
    const agentsDir = join(testDir, '.agents', 'memory');
    mkdirSync(agentsDir, { recursive: true });

    // Create squads dir
    const squadsDir = join(testDir, '.agents', 'squads', 'engineering');
    mkdirSync(squadsDir, { recursive: true });
    writeFileSync(
      join(squadsDir, 'SQUAD.md'),
      `---
name: engineering
status: active
---

## Mission
Build things.
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

  describe('progressStartCommand', () => {
    it('creates a new task entry in tasks.json', async () => {
      const { progressStartCommand } = await import('../../src/commands/progress.js');
      await progressStartCommand('engineering', 'Fix auth bug');

      const tasksPath = join(testDir, '.agents', 'tasks.json');
      expect(existsSync(tasksPath)).toBe(true);

      const data = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      expect(data.tasks).toHaveLength(1);
      expect(data.tasks[0].squad).toBe('engineering');
      expect(data.tasks[0].description).toBe('Fix auth bug');
      expect(data.tasks[0].status).toBe('active');
    });

    it('appends to existing tasks', async () => {
      const { progressStartCommand } = await import('../../src/commands/progress.js');
      await progressStartCommand('engineering', 'Task 1');
      await progressStartCommand('marketing', 'Task 2');

      const tasksPath = join(testDir, '.agents', 'tasks.json');
      const data = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      expect(data.tasks).toHaveLength(2);
      expect(data.tasks[0].squad).toBe('engineering');
      expect(data.tasks[1].squad).toBe('marketing');
    });

    it('generates unique task IDs', async () => {
      const { progressStartCommand } = await import('../../src/commands/progress.js');
      await progressStartCommand('engineering', 'Task A');
      await progressStartCommand('engineering', 'Task B');

      const tasksPath = join(testDir, '.agents', 'tasks.json');
      const data = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      expect(data.tasks[0].id).not.toBe(data.tasks[1].id);
    });
  });

  describe('progressCompleteCommand', () => {
    it('marks task as completed', async () => {
      const { progressStartCommand, progressCompleteCommand } = await import('../../src/commands/progress.js');
      await progressStartCommand('engineering', 'Fix bug');

      const tasksPath = join(testDir, '.agents', 'tasks.json');
      const data = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      const taskId = data.tasks[0].id;

      await progressCompleteCommand(taskId);

      const updated = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      expect(updated.tasks[0].status).toBe('completed');
      expect(updated.tasks[0].completedAt).toBeDefined();
    });

    it('marks task as failed with --failed flag', async () => {
      const { progressStartCommand, progressCompleteCommand } = await import('../../src/commands/progress.js');
      await progressStartCommand('engineering', 'Flaky task');

      const tasksPath = join(testDir, '.agents', 'tasks.json');
      const data = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      const taskId = data.tasks[0].id;

      await progressCompleteCommand(taskId, { failed: true });

      const updated = JSON.parse(readFileSync(tasksPath, 'utf-8'));
      expect(updated.tasks[0].status).toBe('failed');
    });

    it('handles non-existent task ID gracefully', async () => {
      const { progressCompleteCommand } = await import('../../src/commands/progress.js');
      // Should not throw
      await progressCompleteCommand('nonexistent-id');
    });
  });

  describe('progressCommand (display)', () => {
    it('runs without throwing when no tasks exist', async () => {
      const { progressCommand } = await import('../../src/commands/progress.js');
      await progressCommand();
    });

    it('displays active tasks', async () => {
      const { progressStartCommand, progressCommand } = await import('../../src/commands/progress.js');
      await progressStartCommand('engineering', 'Active task');

      // Should not throw
      await progressCommand();
    });

    it('runs with verbose flag', async () => {
      const { progressCommand } = await import('../../src/commands/progress.js');
      await progressCommand({ verbose: true });
    });
  });
});
