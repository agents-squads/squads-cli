import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  generateMcpConfig,
  resolveMcpConfig,
  resolveMcpConfigPath,
  isKnownServer,
  listKnownServers,
  getServerDef,
  writeMcpConfig,
  readMcpConfig,
  McpConfig,
} from '../src/lib/mcp-config.js';

describe('MCP Config', () => {
  describe('Server Registry', () => {
    it('lists known servers (empty - we use CLI tools)', () => {
      const servers = listKnownServers();
      expect(servers.length).toBe(0);
    });

    it('checks if server is known', () => {
      expect(isKnownServer('img-gen')).toBe(false);
      expect(isKnownServer('web-fetch')).toBe(false);
      expect(isKnownServer('unknown-server')).toBe(false);
    });

    it('returns undefined for any server (registry empty)', () => {
      expect(getServerDef('img-gen')).toBeUndefined();
      expect(getServerDef('unknown-server')).toBeUndefined();
    });
  });

  describe('generateMcpConfig', () => {
    it('returns empty config (no servers in registry)', () => {
      const config = generateMcpConfig(['img-gen', 'web-fetch']);

      expect(config.mcpServers).toBeDefined();
      expect(Object.keys(config.mcpServers)).toHaveLength(0);
    });

    it('returns empty config for empty input', () => {
      const config = generateMcpConfig([]);
      expect(Object.keys(config.mcpServers)).toHaveLength(0);
    });
  });

  describe('writeMcpConfig and readMcpConfig', () => {
    const testDir = join(tmpdir(), 'mcp-config-test-' + Date.now());
    const testPath = join(testDir, 'test.mcp.json');

    beforeEach(() => {
      if (!existsSync(testDir)) {
        mkdirSync(testDir, { recursive: true });
      }
    });

    afterEach(() => {
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('writes and reads config correctly', () => {
      const config: McpConfig = {
        mcpServers: {
          test: {
            type: 'stdio',
            command: 'echo',
            args: ['hello'],
          },
        },
      };

      writeMcpConfig(config, testPath);
      expect(existsSync(testPath)).toBe(true);

      const readBack = readMcpConfig(testPath);
      expect(readBack).toEqual(config);
    });

    it('creates parent directories if needed', () => {
      const deepPath = join(testDir, 'deep', 'nested', 'config.json');

      writeMcpConfig({ mcpServers: {} }, deepPath);
      expect(existsSync(deepPath)).toBe(true);
    });

    it('returns null for non-existent file', () => {
      expect(readMcpConfig('/nonexistent/path.json')).toBeNull();
    });
  });

  describe('resolveMcpConfig', () => {
    // These tests mock the HOME directory to avoid touching real config
    const originalHome = process.env.HOME;
    const testHome = join(tmpdir(), 'mcp-resolve-test-' + Date.now());

    beforeEach(() => {
      process.env.HOME = testHome;
      mkdirSync(join(testHome, '.claude', 'mcp-configs'), { recursive: true });
      mkdirSync(join(testHome, '.claude', 'contexts'), { recursive: true });
    });

    afterEach(() => {
      process.env.HOME = originalHome;
      if (existsSync(testHome)) {
        rmSync(testHome, { recursive: true, force: true });
      }
    });

    it('returns fallback when no context provided', () => {
      const result = resolveMcpConfig('test-squad');

      expect(result.source).toBe('fallback');
      expect(result.path).toContain('.claude.json');
    });

    it('generates empty config when registry is empty', () => {
      const result = resolveMcpConfig('test-squad', ['img-gen']);

      expect(result.source).toBe('generated');
      expect(result.servers).toEqual([]);
      expect(result.generated).toBe(true);
      expect(result.path).toContain('test-squad.mcp.json');

      // Verify file was created
      expect(existsSync(result.path)).toBe(true);
    });

    it('returns user-override when squad config exists', () => {
      // Create user override file
      const userConfig = join(testHome, '.claude', 'mcp-configs', 'test-squad.json');
      writeMcpConfig({ mcpServers: { custom: { type: 'stdio', command: 'test', args: [] } } }, userConfig);

      const result = resolveMcpConfig('test-squad', ['img-gen']);

      expect(result.source).toBe('user-override');
      expect(result.path).toBe(userConfig);
      expect(result.servers).toContain('custom');
    });

    it('uses existing generated config without regenerating', () => {
      // First call generates
      const first = resolveMcpConfig('test-squad', ['some-server']);
      expect(first.generated).toBe(true);

      // Second call uses existing
      const second = resolveMcpConfig('test-squad', ['some-server']);
      expect(second.generated).toBe(false);
      expect(second.path).toBe(first.path);
    });

    it('regenerates when force flag is set', () => {
      // First call generates
      resolveMcpConfig('test-squad', ['some-server']);

      // Second call with force regenerates
      const result = resolveMcpConfig('test-squad', ['other-server'], true);
      expect(result.generated).toBe(true);
    });
  });

  describe('resolveMcpConfigPath', () => {
    it('returns path string directly', () => {
      const originalHome = process.env.HOME;
      const testHome = join(tmpdir(), 'mcp-path-test-' + Date.now());

      try {
        process.env.HOME = testHome;
        mkdirSync(join(testHome, '.claude', 'contexts'), { recursive: true });

        const path = resolveMcpConfigPath('test-squad', ['some-server']);

        expect(typeof path).toBe('string');
        expect(path).toContain('test-squad.mcp.json');
      } finally {
        process.env.HOME = originalHome;
        if (existsSync(testHome)) {
          rmSync(testHome, { recursive: true, force: true });
        }
      }
    });
  });
});
