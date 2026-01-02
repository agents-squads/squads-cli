import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { join } from 'path';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
    };
  }
}

describe('CLI', () => {
  describe('--help', () => {
    it('shows help without error', () => {
      const result = runCli('--help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('squads');
      expect(result.stdout).toContain('CLI for managing AI agent squads');
    });

    it('lists available commands', () => {
      const result = runCli('--help');
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('dashboard');
      expect(result.stdout).toContain('run');
      expect(result.stdout).toContain('memory');
    });
  });

  describe('--version', () => {
    it('shows version', () => {
      const result = runCli('--version');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });
  });

  describe('workers', () => {
    it('shows workers command help', () => {
      const result = runCli('workers --help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('workers');
      expect(result.stdout).toContain('--kill');
    });
  });

  describe('memory', () => {
    it('shows memory subcommands', () => {
      const result = runCli('memory --help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('query');
      expect(result.stdout).toContain('show');
      expect(result.stdout).toContain('update');
      expect(result.stdout).toContain('sync');
    });
  });

  describe('goal', () => {
    it('shows goal subcommands', () => {
      const result = runCli('goal --help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('set');
      expect(result.stdout).toContain('list');
      expect(result.stdout).toContain('complete');
    });
  });
});
