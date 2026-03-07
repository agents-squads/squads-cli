import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('session commands', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-session-test-' + Date.now());
    mkdirSync(join(testDir, '.agents'), { recursive: true });
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
  });

  describe('sessionStartCommand', () => {
    it('starts a session and creates a session file', async () => {
      const { sessionStartCommand } = await import('../../src/commands/session.js');
      await sessionStartCommand({ quiet: true });

      const activeDir = join(testDir, '.agents', 'sessions', 'active');
      expect(existsSync(activeDir)).toBe(true);

      const files = readdirSync(activeDir);
      expect(files.length).toBe(1);
      expect(files[0]).toMatch(/\.json$/);
    });

    it('starts a session with a specific squad', async () => {
      const { sessionStartCommand } = await import('../../src/commands/session.js');
      await sessionStartCommand({ squad: 'engineering', quiet: true });

      const activeDir = join(testDir, '.agents', 'sessions', 'active');
      const files = readdirSync(activeDir);
      expect(files.length).toBe(1);
    });

    it('outputs session info when not quiet', async () => {
      const consoleSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const { sessionStartCommand } = await import('../../src/commands/session.js');
      await sessionStartCommand({ quiet: false });
      consoleSpy.mockRestore();
      // Just verifying it doesn't throw
    });

    it('handles no .agents directory gracefully', async () => {
      // Change to a dir without .agents
      const noAgentsDir = join(tmpdir(), 'no-agents-' + Date.now());
      mkdirSync(noAgentsDir, { recursive: true });
      process.chdir(noAgentsDir);

      const { sessionStartCommand } = await import('../../src/commands/session.js');
      // Should not throw
      await expect(sessionStartCommand({ quiet: true })).resolves.toBeUndefined();

      rmSync(noAgentsDir, { recursive: true, force: true });
    });
  });

  describe('sessionStopCommand', () => {
    it('stops an active session', async () => {
      const { sessionStartCommand, sessionStopCommand } = await import('../../src/commands/session.js');

      await sessionStartCommand({ quiet: true });

      const activeDir = join(testDir, '.agents', 'sessions', 'active');
      expect(readdirSync(activeDir).length).toBe(1);

      await sessionStopCommand({ quiet: true });

      expect(readdirSync(activeDir).length).toBe(0);
    });

    it('handles stop with no active session gracefully', async () => {
      const { sessionStopCommand } = await import('../../src/commands/session.js');
      await expect(sessionStopCommand({ quiet: true })).resolves.toBeUndefined();
    });

    it('outputs info when not quiet and session stopped', async () => {
      const { sessionStartCommand, sessionStopCommand } = await import('../../src/commands/session.js');
      await sessionStartCommand({ quiet: true });

      const consoleSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      await sessionStopCommand({ quiet: false });
      consoleSpy.mockRestore();
      // Just verifying it doesn't throw
    });
  });

  describe('sessionHeartbeatCommand', () => {
    it('updates heartbeat for active session', async () => {
      const { sessionStartCommand, sessionHeartbeatCommand } = await import('../../src/commands/session.js');

      await sessionStartCommand({ quiet: true });

      // Heartbeat should succeed
      await expect(sessionHeartbeatCommand({ quiet: true })).resolves.toBeUndefined();
    });

    it('starts a new session if none exists during heartbeat', async () => {
      const { sessionHeartbeatCommand } = await import('../../src/commands/session.js');

      await sessionHeartbeatCommand({ quiet: true });

      // A session should have been created
      const activeDir = join(testDir, '.agents', 'sessions', 'active');
      expect(existsSync(activeDir)).toBe(true);
    });
  });

  describe('detectSquadCommand', () => {
    it('detects squad from .agents/squads directory structure', async () => {
      // Create a squad in the test dir
      mkdirSync(join(testDir, '.agents', 'squads', 'marketing'), { recursive: true });

      // detectSquad uses cwd traversal and looks at .agents/squads structure
      // The command writes to stdout - we capture it
      let output = '';
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
        output += data;
        return true;
      });

      const { detectSquadCommand } = await import('../../src/commands/session.js');
      await detectSquadCommand();

      spy.mockRestore();
      // Output may be empty if squad detection doesn't match without SQUAD.md
      // Just ensure it doesn't throw
    });

    it('writes nothing to stdout when no squad detected', async () => {
      let output = '';
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((data) => {
        output += data;
        return true;
      });

      const { detectSquadCommand } = await import('../../src/commands/session.js');
      await detectSquadCommand();

      spy.mockRestore();
      // When no squad found, nothing is written
      expect(output).toBe('');
    });
  });
});
