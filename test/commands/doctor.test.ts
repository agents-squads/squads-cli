import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '',
    red: '',
    green: '',
    yellow: '',
    cyan: '',
    white: '',
    purple: '',
  },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  icons: {
    success: '✓',
    error: '✗',
    warning: '!',
    progress: '›',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findProjectRoot: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return actual;
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return actual;
});

import { doctorCommand } from '../../src/commands/doctor.js';
import { findProjectRoot } from '../../src/lib/squad-parser.js';
import { execSync } from 'child_process';
import { existsSync } from 'fs';

const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockFindProjectRoot = findProjectRoot as ReturnType<typeof vi.fn>;

describe('doctorCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindProjectRoot.mockReturnValue(null);
    mockExistsSync.mockReturnValue(false);
    // Default: tools check succeeds with version strings
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('--version') || cmd.includes('--version')) return 'v1.0.0\n';
      if (cmd.includes('ps aux')) return '';
      if (cmd.includes('gcloud')) return 'test@example.com\n';
      if (cmd.includes('gh auth')) return 'Logged in\n';
      if (cmd.includes('claude whoami')) return 'test@example.com\n';
      if (cmd.includes('wc -l')) return '0\n';
      return '';
    });
  });

  it('resolves successfully when all tools are available', async () => {
    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves when tools are missing (execSync throws)', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('ps aux')) return '';
      if (cmd.includes('wc -l')) return '0\n';
      throw new Error('command not found');
    });

    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves with verbose option', async () => {
    await expect(doctorCommand({ verbose: true })).resolves.toBeUndefined();
  });

  it('resolves when project root is found', async () => {
    mockFindProjectRoot.mockReturnValue('/tmp/test-project');
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('ps aux')) return '';
      if (cmd.includes('wc -l')) return '3\n';
      if (cmd.includes('--version')) return 'v1.0.0\n';
      if (cmd.includes('gcloud')) return 'test@example.com\n';
      if (cmd.includes('gh auth')) return 'Logged in\n';
      if (cmd.includes('claude whoami')) return 'user@example.com\n';
      return '';
    });

    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves when ANTHROPIC_API_KEY is set', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    await expect(doctorCommand()).resolves.toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('resolves when running squads are detected', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('ps aux')) {
        return [
          'USER  1234  0.0  0.0 cmd  squads run engineering --task "work on stuff"',
          '',
        ].join('\n');
      }
      if (cmd.includes('--version')) return 'v1.0.0\n';
      if (cmd.includes('gcloud')) return 'test@example.com\n';
      if (cmd.includes('gh auth')) return 'Logged in\n';
      if (cmd.includes('wc -l')) return '0\n';
      return '';
    });

    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves when daemon (squads autonomous) is running', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('ps aux')) {
        return 'USER  5678  0.0  0.0 cmd  squads autonomous\n';
      }
      if (cmd.includes('--version')) return 'v1.0.0\n';
      if (cmd.includes('gcloud')) return 'test@example.com\n';
      if (cmd.includes('gh auth')) return 'Logged in\n';
      if (cmd.includes('wc -l')) return '2\n';
      return '';
    });

    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves when GitHub auth fails', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gh auth')) throw Object.assign(new Error('not logged in'), { stderr: 'not logged in' });
      if (cmd.includes('ps aux')) return '';
      if (cmd.includes('--version')) return 'v1.0.0\n';
      if (cmd.includes('gcloud')) return 'test@example.com\n';
      if (cmd.includes('wc -l')) return '0\n';
      return '';
    });

    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves when gcloud is not installed', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('gcloud')) throw new Error('gcloud not found');
      if (cmd.includes('ps aux')) return '';
      if (cmd.includes('--version')) return 'v1.0.0\n';
      if (cmd.includes('gh auth')) return 'Logged in\n';
      if (cmd.includes('wc -l')) return '0\n';
      return '';
    });

    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('resolves when all core tools are missing and no project', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('ps aux')) return '';
      throw new Error('command not found');
    });
    mockFindProjectRoot.mockReturnValue(null);

    await expect(doctorCommand()).resolves.toBeUndefined();
  });

  it('shows verbose install hints when tools are missing', async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('ps aux')) return '';
      if (cmd.includes('wc -l')) return '0\n';
      throw new Error('not found');
    });

    await expect(doctorCommand({ verbose: true })).resolves.toBeUndefined();
  });
});
