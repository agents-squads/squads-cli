import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs to avoid touching ~/.squads/config.json
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue('/fake/home'),
  };
});

vi.mock('../../src/lib/terminal.js', () => ({
  colors: { dim: '', cyan: '', green: '', red: '', yellow: '', white: '' },
  RESET: '',
  gradient: (s: string) => s,
  icons: { success: '✓', error: '✗' },
  writeLine: vi.fn(),
  bold: (s: string) => s,
}));

import { existsSync, readFileSync, writeFileSync } from 'fs';
import {
  loadConfig,
  saveConfig,
  switchEnv,
  getEnv,
  getEnvName,
} from '../../src/lib/env-config.js';
import {
  configShowCommand,
  configUseCommand,
} from '../../src/commands/config.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe('config commands', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SQUADS_ENV;
    delete process.env.SQUADS_API_URL;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // switchEnv (used by config use)
  // ---------------------------------------------------------------------------
  describe('switchEnv()', () => {
    it('switches to a known environment', () => {
      mockExistsSync.mockReturnValue(false); // Use default config
      const config = switchEnv('staging');
      expect(config.current).toBe('staging');
      expect(config.environments.staging.api_url).toBe(
        'https://api-staging.agents-squads.com',
      );
    });

    it('persists the change via saveConfig', () => {
      mockExistsSync.mockReturnValue(false);
      switchEnv('prod');
      const written = mockWriteFileSync.mock.calls.map(
        (c) => JSON.parse(c[1] as string),
      );
      const lastWrite = written[written.length - 1];
      expect(lastWrite.current).toBe('prod');
    });

    it('throws on unknown environment name', () => {
      mockExistsSync.mockReturnValue(false);
      expect(() => switchEnv('nonexistent')).toThrow(
        /Unknown environment "nonexistent"/,
      );
    });

    it('error message lists valid environment names', () => {
      mockExistsSync.mockReturnValue(false);
      try {
        switchEnv('bogus');
        expect.unreachable('should have thrown');
      } catch (e: unknown) {
        const msg = (e as Error).message;
        expect(msg).toContain('local');
        expect(msg).toContain('staging');
        expect(msg).toContain('prod');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // config use <env>
  // ---------------------------------------------------------------------------
  describe('configUseCommand', () => {
    it('switches to valid env and completes without error', async () => {
      mockExistsSync.mockReturnValue(false); // Default config
      await expect(configUseCommand('local')).resolves.toBeUndefined();
    });

    it('outputs JSON with --json flag', async () => {
      mockExistsSync.mockReturnValue(false);
      await configUseCommand('prod', { json: true });
      expect(logSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.current).toBe('prod');
      expect(output.api_url).toBe('https://api.agents-squads.com');
    });

    it('throws on invalid env name', async () => {
      mockExistsSync.mockReturnValue(false);
      await expect(configUseCommand('invalid-env')).rejects.toThrow(
        /Unknown environment/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // config show
  // ---------------------------------------------------------------------------
  describe('configShowCommand', () => {
    it('shows current env without override', async () => {
      mockExistsSync.mockReturnValue(false); // Default config — local
      await expect(configShowCommand({})).resolves.toBeUndefined();
    });

    it('notes SQUADS_ENV override when set', async () => {
      mockExistsSync.mockReturnValue(false);
      process.env.SQUADS_ENV = 'staging';
      await expect(configShowCommand({})).resolves.toBeUndefined();
    });

    it('outputs JSON with --json flag', async () => {
      mockExistsSync.mockReturnValue(false);
      process.env.SQUADS_ENV = 'prod';
      await configShowCommand({ json: true });
      expect(logSpy).toHaveBeenCalledOnce();
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output.current).toBe('prod');
      expect(output.overridden).toBe(true);
      expect(output.resolved).toHaveProperty('api_url');
      expect(output.resolved).toHaveProperty('execution');
    });

    it('JSON output includes overridden field', async () => {
      mockExistsSync.mockReturnValue(false);
      await configShowCommand({ json: true });
      const output = JSON.parse(logSpy.mock.calls[0][0] as string);
      expect(output).toHaveProperty('overridden');
      expect(output.overridden).toBe(false);
    });
  });
});
