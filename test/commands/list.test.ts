import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('list command', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-list-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    originalCwd = process.cwd();

    // Create two squads with agents
    const engineeringDir = join(testDir, '.agents', 'squads', 'engineering');
    mkdirSync(engineeringDir, { recursive: true });
    writeFileSync(
      join(engineeringDir, 'SQUAD.md'),
      `---
name: engineering
status: active
lead: lead
---

## Mission
Build and maintain infrastructure.
`
    );
    writeFileSync(
      join(engineeringDir, 'lead.md'),
      `---
name: lead
role: Squad lead
status: active
---
`
    );
    writeFileSync(
      join(engineeringDir, 'issue-solver.md'),
      `---
name: issue-solver
role: Solve GitHub issues
status: active
---
`
    );

    const marketingDir = join(testDir, '.agents', 'squads', 'marketing');
    mkdirSync(marketingDir, { recursive: true });
    writeFileSync(
      join(marketingDir, 'SQUAD.md'),
      `---
name: marketing
status: active
lead: lead
---

## Mission
Drive growth.
`
    );
    writeFileSync(
      join(marketingDir, 'lead.md'),
      `---
name: lead
role: Content strategist
status: active
---
`
    );

    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  describe('JSON output', () => {
    it('outputs valid JSON with squad data', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { listCommand } = await import('../../src/commands/list.js');
      await listCommand({ json: true });

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = JSON.parse(consoleSpy.mock.calls[0][0]);

      expect(output.ok).toBe(true);
      expect(output.command).toBe('list');
      expect(output.data.totalSquads).toBe(2);
      expect(output.data.squads).toHaveLength(2);
    });

    it('includes agent counts per squad', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { listCommand } = await import('../../src/commands/list.js');
      await listCommand({ json: true });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      const engineering = output.data.squads.find((s: { name: string }) => s.name === 'engineering');
      expect(engineering.agentCount).toBe(2); // lead + issue-solver
    });

    it('includes agent details with name, role, status', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { listCommand } = await import('../../src/commands/list.js');
      await listCommand({ json: true });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      const engineering = output.data.squads.find((s: { name: string }) => s.name === 'engineering');
      const solver = engineering.agents.find((a: { name: string }) => a.name === 'issue-solver');
      expect(solver).toBeDefined();
      expect(solver.role).toBeTruthy();
      expect(solver.status).toBe('active');
    });

    it('reports correct total agents across all squads', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { listCommand } = await import('../../src/commands/list.js');
      await listCommand({ json: true });

      const output = JSON.parse(consoleSpy.mock.calls[0][0]);
      expect(output.data.totalAgents).toBe(3); // 2 engineering + 1 marketing
    });
  });

  describe('no project', () => {
    it('exits with code 1 when no .agents directory', async () => {
      const emptyDir = join(tmpdir(), 'squads-list-empty-' + Date.now());
      mkdirSync(emptyDir, { recursive: true });
      process.chdir(emptyDir);

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('exit');
      });

      const { listCommand } = await import('../../src/commands/list.js');

      try {
        await listCommand({});
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
      rmSync(emptyDir, { recursive: true, force: true });
    });
  });

  describe('table output', () => {
    it('runs without throwing for default (squads table) view', async () => {
      const { listCommand } = await import('../../src/commands/list.js');
      // Should not throw
      await listCommand({});
    });

    it('runs without throwing for agents view', async () => {
      const { listCommand } = await import('../../src/commands/list.js');
      await listCommand({ agents: true });
    });
  });
});
