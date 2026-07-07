import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '',
    red: '',
    green: '',
    yellow: '',
    purple: '',
    cyan: '',
    white: '',
  },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  icons: {
    success: '✓',
    error: '✗',
    warning: '!',
    progress: '›',
    empty: '○',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findProjectRoot: vi.fn(() => null),
}));

import { doctorCommand } from '../../src/commands/doctor.js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);

describe('doctorCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves without error when all tools are missing', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    mockExistsSync.mockReturnValue(false);
    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves without error when all tools are installed', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('--version')) return 'version 1.0.0';
      if (typeof cmd === 'string' && cmd.includes('gh auth status')) return 'Logged in to github.com';
      if (typeof cmd === 'string' && cmd.includes('claude --version')) return 'claude 1.2.3';
      return 'ok';
    });
    mockExistsSync.mockReturnValue(true);
    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves with verbose option', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    await expect(doctorCommand({ verbose: true })).resolves.toBeUndefined();
  });

  it('resolves with json option', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    await expect(doctorCommand({ json: true })).resolves.toBeUndefined();
  });

  it('resolves with fix option', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    await expect(doctorCommand({ fix: true })).resolves.toBeUndefined();
  });

  it('shows installed tools when they are found', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('claude')) return '1.2.3';
      if (typeof cmd === 'string' && cmd.includes('git')) return 'git version 2.40.0';
      throw new Error('not found');
    });
    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('handles mix of installed and missing tools', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === 'string' && cmd.includes('git')) return 'git version 2.40.0';
      throw new Error('not found');
    });
    mockExistsSync.mockReturnValue(false);
    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('handles execSync timeout gracefully', async () => {
    mockExecSync.mockImplementation(() => {
      const err = new Error('Command timed out');
      (err as Error & { code: string }).code = 'ETIMEDOUT';
      throw err;
    });
    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('detects initialized project when root is found', async () => {
    const { findProjectRoot } = await import('../../src/lib/squad-parser.js');
    vi.mocked(findProjectRoot).mockReturnValue('/path/to/project');
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue('1.0.0' as unknown as ReturnType<typeof execSync>);
    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  describe('exit code', () => {
    const originalExitCode = process.exitCode;

    beforeEach(() => {
      process.exitCode = undefined;
    });

    afterEach(() => {
      process.exitCode = originalExitCode;
    });

    it('sets a nonzero exit code when a core tool is missing', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });
      mockExistsSync.mockReturnValue(false);
      await doctorCommand();
      expect(process.exitCode).toBe(1);
    });

    it('does not set an exit code when all core tools are present', async () => {
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('--version')) return 'version 1.0.0';
        if (typeof cmd === 'string' && cmd.includes('gh auth status')) return 'Logged in to github.com';
        if (typeof cmd === 'string' && cmd.includes('claude whoami')) return 'user@example.com';
        return 'ok';
      });
      mockExistsSync.mockReturnValue(true);
      await doctorCommand();
      expect(process.exitCode).toBeUndefined();
    });
  });

  describe('Claude auth check', () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;

    afterEach(() => {
      if (originalApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      }
    });

    it('does not report Claude as authenticated when no API key is set and no session can be verified', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('claude whoami')) {
          throw new Error('unknown command');
        }
        if (typeof cmd === 'string' && cmd.includes('claude -p')) {
          return 'Not logged in · Please run /login';
        }
        if (typeof cmd === 'string' && cmd.includes('--version')) return 'version 1.0.0';
        throw new Error('not found');
      });
      const { writeLine } = await import('../../src/lib/terminal.js');
      await doctorCommand();
      const output = vi.mocked(writeLine).mock.calls.map(c => String(c[0] ?? '')).join('\n');
      expect(output).toContain('✗ Claude');
      expect(output).not.toContain('✓ Claude');
    });

    it('reports Claude as authenticated when claude whoami confirms a real session', async () => {
      delete process.env.ANTHROPIC_API_KEY;
      mockExecSync.mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('claude whoami')) return 'user@example.com';
        if (typeof cmd === 'string' && cmd.includes('--version')) return 'version 1.0.0';
        throw new Error('not found');
      });
      const { writeLine } = await import('../../src/lib/terminal.js');
      await doctorCommand();
      const output = vi.mocked(writeLine).mock.calls.map(c => String(c[0] ?? '')).join('\n');
      expect(output).toContain('✓ Claude');
    });
  });
});
