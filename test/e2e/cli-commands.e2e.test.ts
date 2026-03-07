import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

// Clear git env vars set by pre-commit hook to prevent GIT_DIR pollution
beforeAll(() => {
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLI_PATH = path.resolve(__dirname, '../../dist/cli.js');

describe('E2E: Core CLI Commands', () => {
  it('shows version without errors', () => {
    const output = execSync(`node ${CLI_PATH} --version`, {
      encoding: 'utf-8',
    });

    expect(output).toMatch(/\d+\.\d+\.\d+/);
  });

  it('shows help without errors', () => {
    const output = execSync(`node ${CLI_PATH} --help`, {
      encoding: 'utf-8',
    });

    expect(output).toContain('Commands:');
    expect(output).toContain('Options:');
  });

  it('lists available commands in help', () => {
    const output = execSync(`node ${CLI_PATH} --help`, {
      encoding: 'utf-8',
    });

    // Verify key commands are listed
    expect(output).toContain('init');
    expect(output).toContain('run');
    expect(output).toContain('status');
    expect(output).toContain('dashboard');
  });

  it('shows command-specific help', () => {
    const output = execSync(`node ${CLI_PATH} init --help`, {
      encoding: 'utf-8',
    });

    expect(output).toMatch(/Plant the seed|Initialize a new squad project/);
    expect(output).toContain('Options:');
  });

  it('handles unknown commands gracefully', () => {
    expect(() => {
      execSync(`node ${CLI_PATH} nonexistent-command`, {
        stdio: 'pipe',
      });
    }).toThrow();
  });

  it('providers command lists available providers', () => {
    const output = execSync(`node ${CLI_PATH} providers`, {
      encoding: 'utf-8',
    });

    // Should mention Claude or other providers
    expect(output.length).toBeGreaterThan(0);
  });
});
