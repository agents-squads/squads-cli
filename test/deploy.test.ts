import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('deploy', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `squads-deploy-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('registerDeployCommand', () => {
    it('registers deploy command with subcommands', async () => {
      const { Command } = await import('commander');
      const { registerDeployCommand } = await import('../src/commands/deploy.js');

      const program = new Command();
      registerDeployCommand(program);

      const deploy = program.commands.find(c => c.name() === 'deploy');
      expect(deploy).toBeDefined();
      expect(deploy!.description()).toBe('Deploy agents to the Squads platform');

      // Check subcommands
      const subcommands = deploy!.commands.map(c => c.name());
      expect(subcommands).toContain('status');
      expect(subcommands).toContain('pull');
    });

    it('deploy has --dry-run option', async () => {
      const { Command } = await import('commander');
      const { registerDeployCommand } = await import('../src/commands/deploy.js');

      const program = new Command();
      registerDeployCommand(program);

      const deploy = program.commands.find(c => c.name() === 'deploy');
      const options = deploy!.options.map(o => o.long);
      expect(options).toContain('--dry-run');
      expect(options).toContain('--squad');
      expect(options).toContain('--verbose');
    });
  });

  describe('deployCommand', () => {
    it('requires active session', async () => {
      const { deployCommand } = await import('../src/commands/deploy.js');

      // Mock loadSession to return null
      const authModule = await import('../src/lib/auth.js');
      const spy = vi.spyOn(authModule, 'loadSession').mockReturnValue(null);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (...args: unknown[]) => logs.push(args.join(' '));

      await deployCommand({ dryRun: true });

      console.log = originalLog;
      spy.mockRestore();

      const output = logs.join('\n');
      expect(output).toContain('Not logged in');
    });

    it('requires squads directory', async () => {
      const { deployCommand } = await import('../src/commands/deploy.js');

      // Mock loadSession to return active session
      const authModule = await import('../src/lib/auth.js');
      const spy = vi.spyOn(authModule, 'loadSession').mockReturnValue({
        email: 'test@company.com',
        domain: 'company.com',
        status: 'active',
        createdAt: new Date().toISOString(),
        accessToken: 'test-token',
      });

      // Mock findSquadsDir to return null
      const parserModule = await import('../src/lib/squad-parser.js');
      const dirSpy = vi.spyOn(parserModule, 'findSquadsDir').mockReturnValue(null);

      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => errors.push(args.join(' '));

      await deployCommand({ dryRun: true });

      console.error = originalError;
      spy.mockRestore();
      dirSpy.mockRestore();

      const output = errors.join('\n');
      expect(output).toContain('No .agents/squads/ directory found');
    });
  });
});
