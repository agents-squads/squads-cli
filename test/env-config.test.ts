import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs to avoid reading/writing ~/.squads/config.json in tests
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

// Mock os.homedir() so loadConfig doesn't touch real home dir
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: vi.fn().mockReturnValue('/fake/home'),
  };
});

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  loadConfig,
  saveConfig,
  getEnv,
  getEnvName,
  getApiUrl,
  getBridgeUrl,
  getConsoleUrl,
} from '../src/lib/env-config.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

describe('env-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env overrides before each test
    delete process.env.SQUADS_API_URL;
    delete process.env.SQUADS_ADMIN_API_URL;
    delete process.env.SQUADS_CONSOLE_URL;
    delete process.env.SQUADS_BRIDGE_URL;
    delete process.env.SQUADS_DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.SQUADS_ENV;
  });

  // ---------------------------------------------------------------------------
  // loadConfig
  // ---------------------------------------------------------------------------
  describe('loadConfig()', () => {
    it('returns default config and saves it when config file does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      const config = loadConfig();
      expect(config.current).toBe('local'); // local-first default (#959)
      expect(config.environments).toHaveProperty('local');
      expect(config.environments).toHaveProperty('staging');
      expect(config.environments).toHaveProperty('prod');
      // Should have saved the default config
      expect(mockWriteFileSync).toHaveBeenCalled();
    });

    it('reads and parses existing config file', () => {
      mockExistsSync.mockReturnValue(true);
      const stored = {
        current: 'staging',
        environments: {
          staging: {
            api_url: 'https://custom-staging.example.com',
            admin_api_url: 'https://custom-staging.example.com',
            console_url: 'https://console-staging.example.com',
            bridge_url: '',
            database_url: '',
            redis_url: '',
            execution: 'cloud',
          },
        },
      };
      mockReadFileSync.mockReturnValue(JSON.stringify(stored));
      const config = loadConfig();
      expect(config.current).toBe('staging');
      expect(config.environments.staging.api_url).toBe('https://custom-staging.example.com');
    });

    it('merges stored environments with defaults', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ current: 'local', environments: {} }));
      const config = loadConfig();
      // Should still have default environments from DEFAULT_CONFIG
      expect(config.environments).toHaveProperty('local');
      expect(config.environments).toHaveProperty('prod');
    });

    it('falls back to default config when JSON is invalid', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{ invalid json }');
      const config = loadConfig();
      expect(config.current).toBe('local'); // local-first default (#959)
    });

    it('falls back to current=local when stored config has no current field', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ environments: {} }));
      const config = loadConfig();
      expect(config.current).toBe('local');
    });
  });

  // ---------------------------------------------------------------------------
  // saveConfig
  // ---------------------------------------------------------------------------
  describe('saveConfig()', () => {
    it('creates config directory when it does not exist', () => {
      mockExistsSync.mockReturnValue(false);
      saveConfig({ current: 'local', environments: {} });
      expect(mockMkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.squads'),
        { recursive: true }
      );
    });

    it('does not create directory if it already exists', () => {
      mockExistsSync.mockReturnValue(true);
      saveConfig({ current: 'local', environments: {} });
      expect(mockMkdirSync).not.toHaveBeenCalled();
    });

    it('writes valid JSON with trailing newline', () => {
      mockExistsSync.mockReturnValue(true);
      const config = { current: 'prod', environments: {} };
      saveConfig(config);
      const written = (mockWriteFileSync.mock.calls[0][1] as string);
      expect(() => JSON.parse(written)).not.toThrow();
      expect(written).toMatch(/\n$/);
    });

    it('round-trips with loadConfig — written data is readable', () => {
      let savedContent = '';
      mockWriteFileSync.mockImplementation((_path, data) => {
        savedContent = data as string;
      });
      mockExistsSync.mockReturnValueOnce(false); // saveConfig: dir check
      mockExistsSync.mockReturnValueOnce(true);  // loadConfig: file check
      mockReadFileSync.mockImplementation(() => savedContent);

      const original = { current: 'staging', environments: {} };
      saveConfig(original);
      const loaded = loadConfig();
      expect(loaded.current).toBe('staging');
    });

    it('preserves email field through load→save cycle (#1184)', () => {
      // Simulate a config with email on disk
      const onDisk = {
        current: 'staging',
        environments: {
          staging: {
            api_url: 'https://staging.example.com',
            admin_api_url: '',
            console_url: '',
            bridge_url: '',
            database_url: '',
            redis_url: '',
            execution: 'cloud',
          },
        },
        email: 'user@example.com',
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(onDisk));

      // loadConfig should preserve email
      const config = loadConfig();
      expect(config.email).toBe('user@example.com');

      // saveConfig should write it back
      saveConfig(config);
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.email).toBe('user@example.com');
    });

    it('preserves unknown extra fields through load→save cycle (#1184)', () => {
      const onDisk = {
        current: 'staging',
        environments: {},
        someFutureField: 'should-survive',
      };
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify(onDisk));

      const config = loadConfig() as Record<string, unknown>;
      expect(config.someFutureField).toBe('should-survive');

      saveConfig(config as Parameters<typeof saveConfig>[0]);
      const written = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(written.someFutureField).toBe('should-survive');
    });
  });

  // ---------------------------------------------------------------------------
  // getEnv — env var overrides
  // ---------------------------------------------------------------------------
  describe('getEnv() — env var overrides', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(false); // Use default config
    });

    it('SQUADS_API_URL overrides api_url', () => {
      process.env.SQUADS_API_URL = 'http://custom-api:9999';
      const env = getEnv();
      expect(env.api_url).toBe('http://custom-api:9999');
    });

    it('SQUADS_BRIDGE_URL overrides bridge_url independently', () => {
      process.env.SQUADS_API_URL = 'http://custom-api:9999';
      process.env.SQUADS_BRIDGE_URL = 'http://custom-bridge:8888';
      const env = getEnv();
      expect(env.api_url).toBe('http://custom-api:9999');
      expect(env.bridge_url).toBe('http://custom-bridge:8888');
    });

    it('SQUADS_CONSOLE_URL overrides console_url', () => {
      process.env.SQUADS_CONSOLE_URL = 'http://custom-console:7777';
      const env = getEnv();
      expect(env.console_url).toBe('http://custom-console:7777');
    });

    it('REDIS_URL overrides redis_url', () => {
      process.env.REDIS_URL = 'redis://custom-redis:6380';
      const env = getEnv();
      expect(env.redis_url).toBe('redis://custom-redis:6380');
    });

    it('SQUADS_ENV=prod selects prod environment (non-localhost URLs)', () => {
      process.env.SQUADS_ENV = 'prod';
      const env = getEnv();
      expect(env.api_url).not.toContain('localhost');
      expect(env.execution).toBe('cloud');
    });

    it('local environment defaults to empty URLs and local execution', () => {
      process.env.SQUADS_ENV = 'local';
      const env = getEnv();
      expect(env.api_url).toBe('');
      expect(env.execution).toBe('local');
    });

    it('unknown SQUADS_ENV falls back to local with empty URLs', () => {
      process.env.SQUADS_ENV = 'nonexistent';
      const env = getEnv();
      expect(env.api_url).toBe('');
    });

    it('env object has all required fields', () => {
      const env = getEnv();
      expect(env).toHaveProperty('api_url');
      expect(env).toHaveProperty('admin_api_url');
      expect(env).toHaveProperty('console_url');
      expect(env).toHaveProperty('bridge_url');
      expect(env).toHaveProperty('database_url');
      expect(env).toHaveProperty('redis_url');
      expect(env).toHaveProperty('execution');
    });

    it('execution is always local or cloud', () => {
      const env = getEnv();
      expect(['local', 'cloud']).toContain(env.execution);
    });
  });

  // ---------------------------------------------------------------------------
  // getEnvName
  // ---------------------------------------------------------------------------
  describe('getEnvName()', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(false); // Use default config
    });

    it('returns SQUADS_ENV when set', () => {
      process.env.SQUADS_ENV = 'staging';
      expect(getEnvName()).toBe('staging');
    });

    it('returns current from config when SQUADS_ENV not set', () => {
      delete process.env.SQUADS_ENV;
      expect(getEnvName()).toBe('local'); // DEFAULT_CONFIG.current = 'local' (#959)
    });
  });

  // ---------------------------------------------------------------------------
  // URL accessors
  // ---------------------------------------------------------------------------
  describe('URL accessors', () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(false);
      process.env.SQUADS_ENV = 'local';
    });

    it('getApiUrl() returns a string', () => {
      expect(typeof getApiUrl()).toBe('string');
    });

    it('getApiUrl() returns SQUADS_API_URL override', () => {
      process.env.SQUADS_API_URL = 'http://override:1234';
      expect(getApiUrl()).toBe('http://override:1234');
    });

    it('getBridgeUrl() returns a string', () => {
      expect(typeof getBridgeUrl()).toBe('string');
    });

    it('getBridgeUrl() returns SQUADS_BRIDGE_URL override', () => {
      process.env.SQUADS_BRIDGE_URL = 'http://bridge-override:5678';
      expect(getBridgeUrl()).toBe('http://bridge-override:5678');
    });

    it('getConsoleUrl() returns a string', () => {
      expect(typeof getConsoleUrl()).toBe('string');
    });

    it('getConsoleUrl() returns SQUADS_CONSOLE_URL override', () => {
      process.env.SQUADS_CONSOLE_URL = 'http://console-override:9012';
      expect(getConsoleUrl()).toBe('http://console-override:9012');
    });
  });
});
