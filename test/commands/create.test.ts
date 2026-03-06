import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock child_process for --repo tests
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn((cmd: string) => {
      if (cmd.startsWith('gh --version')) return 'gh version 2.0.0';
      if (cmd.startsWith('gh repo view')) throw new Error('Not found');
      if (cmd.startsWith('gh repo create')) return 'https://github.com/test-org/my-squad\n';
      if (cmd.startsWith('git remote get-url')) return 'git@github.com:test-org/other-repo.git\n';
      return actual.execSync(cmd);
    }),
  };
});

describe('create command', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-create-test-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    // Create .agents/squads to simulate initialized project
    mkdirSync(join(testDir, '.agents', 'squads'), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('directory structure creation', () => {
    it('creates squad directory with SQUAD.md', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('my-squad', { yes: true });

      const squadDir = join(testDir, '.agents', 'squads', 'my-squad');
      expect(existsSync(squadDir)).toBe(true);
      expect(existsSync(join(squadDir, 'SQUAD.md'))).toBe(true);
    });

    it('creates lead agent file', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('my-squad', { yes: true });

      const leadFile = join(testDir, '.agents', 'squads', 'my-squad', 'lead.md');
      expect(existsSync(leadFile)).toBe(true);
    });

    it('creates memory directory for lead agent', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('my-squad', { yes: true });

      const memoryDir = join(testDir, '.agents', 'memory', 'my-squad', 'lead');
      expect(existsSync(memoryDir)).toBe(true);
    });
  });

  describe('SQUAD.md content', () => {
    it('uses squad name in title', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('marketing', { yes: true, description: 'Drive growth' });

      const content = readFileSync(
        join(testDir, '.agents', 'squads', 'marketing', 'SQUAD.md'),
        'utf-8'
      );
      expect(content).toContain('Marketing');
    });

    it('includes custom description', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('marketing', { yes: true, description: 'Drive organic growth through content' });

      const content = readFileSync(
        join(testDir, '.agents', 'squads', 'marketing', 'SQUAD.md'),
        'utf-8'
      );
      expect(content).toContain('Drive organic growth through content');
    });

    it('includes custom goal', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('marketing', { yes: true, goal: 'Publish 10 blog posts' });

      const content = readFileSync(
        join(testDir, '.agents', 'squads', 'marketing', 'SQUAD.md'),
        'utf-8'
      );
      expect(content).toContain('Publish 10 blog posts');
    });
  });

  describe('name handling', () => {
    it('converts names to kebab-case', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('My Cool Squad', { yes: true });

      expect(existsSync(join(testDir, '.agents', 'squads', 'my-cool-squad', 'SQUAD.md'))).toBe(true);
    });

    it('rejects empty names', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      try {
        await createCommand('!!!', { yes: true });
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });
  });

  describe('overwrite protection', () => {
    it('refuses to overwrite existing squad without --force', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      // Create squad first
      await createCommand('existing', { yes: true });

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });

      try {
        await createCommand('existing', { yes: true });
      } catch {
        // Expected
      }

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('overwrites existing squad with --force', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('existing', { yes: true, description: 'Original' });
      await createCommand('existing', { yes: true, force: true, description: 'Updated' });

      const content = readFileSync(
        join(testDir, '.agents', 'squads', 'existing', 'SQUAD.md'),
        'utf-8'
      );
      expect(content).toContain('Updated');
    });
  });

  describe('squad discoverability', () => {
    it('new squad appears in listSquads', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      const { listSquads } = await import('../../src/lib/squad-parser.js');

      await createCommand('new-squad', { yes: true });

      const squadsDir = join(testDir, '.agents', 'squads');
      const squads = listSquads(squadsDir);
      expect(squads).toContain('new-squad');
    });
  });

  describe('--repo flag', () => {
    it('creates local squad files even with --repo', async () => {
      const { createCommand } = await import('../../src/commands/create.js');
      await createCommand('my-squad', { yes: true, repo: true, org: 'test-org' });

      const squadDir = join(testDir, '.agents', 'squads', 'my-squad');
      expect(existsSync(join(squadDir, 'SQUAD.md'))).toBe(true);
      expect(existsSync(join(squadDir, 'lead.md'))).toBe(true);
    });

    it('calls createGitHubRepo with correct org and name', async () => {
      const { execSync } = await import('child_process');
      const { createCommand } = await import('../../src/commands/create.js');

      await createCommand('my-squad', { yes: true, repo: true, org: 'test-org' });

      const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
      const createCall = calls.find(c => c.startsWith('gh repo create'));
      expect(createCall).toBeDefined();
      expect(createCall).toContain('test-org/my-squad');
    });

    it('creates private repo by default', async () => {
      const { execSync } = await import('child_process');
      const { createCommand } = await import('../../src/commands/create.js');

      await createCommand('my-squad', { yes: true, repo: true, org: 'test-org' });

      const calls = vi.mocked(execSync).mock.calls.map(c => c[0] as string);
      const createCall = calls.find(c => c.startsWith('gh repo create'));
      expect(createCall).toContain('--private');
    });

    it('continues gracefully if GitHub repo creation fails', async () => {
      const { execSync } = await import('child_process');
      vi.mocked(execSync).mockImplementationOnce((cmd: string) => {
        if ((cmd as string).startsWith('gh --version')) return 'gh version 2.0.0';
        throw new Error('API error');
      });

      const { createCommand } = await import('../../src/commands/create.js');

      // Should not throw — creates local squad even if GitHub fails
      await expect(createCommand('my-squad', { yes: true, repo: true, org: 'test-org' })).resolves.toBeUndefined();

      // Local files still exist
      const squadDir = join(testDir, '.agents', 'squads', 'my-squad');
      expect(existsSync(join(squadDir, 'SQUAD.md'))).toBe(true);
    });
  });
});
