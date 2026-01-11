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
    it('lists known servers', () => {
      const servers = listKnownServers();
      expect(servers).toContain('x-mcp');
      expect(servers).toContain('nano-banana');
      expect(servers.length).toBe(2);
    });

    it('checks if server is known', () => {
      expect(isKnownServer('x-mcp')).toBe(true);
      expect(isKnownServer('nano-banana')).toBe(true);
      expect(isKnownServer('unknown-server')).toBe(false);
    });

    it('gets server definition', () => {
      const xDef = getServerDef('x-mcp');
      expect(xDef).toBeDefined();
      expect(xDef?.type).toBe('stdio');
      expect(xDef?.command).toBe('python3');
    });

    it('returns undefined for unknown server', () => {
      expect(getServerDef('unknown-server')).toBeUndefined();
    });
  });

  describe('generateMcpConfig', () => {
    it('generates config from known servers', () => {
      const config = generateMcpConfig(['x-mcp', 'nano-banana']);

      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers['x-mcp']).toBeDefined();
      expect(config.mcpServers['nano-banana']).toBeDefined();
      expect(Object.keys(config.mcpServers)).toHaveLength(2);
    });

    it('skips unknown servers silently', () => {
      const config = generateMcpConfig(['x-mcp', 'unknown-server', 'nano-banana']);

      expect(Object.keys(config.mcpServers)).toHaveLength(2);
      expect(config.mcpServers['unknown-server']).toBeUndefined();
    });

    it('returns empty config for empty input', () => {
      const config = generateMcpConfig([]);
      expect(Object.keys(config.mcpServers)).toHaveLength(0);
    });

    it('preserves server definition structure', () => {
      const config = generateMcpConfig(['nano-banana']);
      const nanoBanana = config.mcpServers['nano-banana'];

      expect(nanoBanana.type).toBe('stdio');
      expect(nanoBanana.command).toBe('npx');
      expect(nanoBanana.args).toContain('nano-banana-mcp');
      expect(nanoBanana.env).toBeDefined();
      expect(nanoBanana.env?.OPENAI_API_KEY).toBe('${OPENAI_API_KEY}');
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

    it('generates config from context.mcp', () => {
      const result = resolveMcpConfig('test-squad', ['x-mcp', 'nano-banana']);

      expect(result.source).toBe('generated');
      expect(result.servers).toContain('x-mcp');
      expect(result.servers).toContain('nano-banana');
      expect(result.generated).toBe(true);
      expect(result.path).toContain('test-squad.mcp.json');

      // Verify file was created
      expect(existsSync(result.path)).toBe(true);
    });

    it('returns user-override when squad config exists', () => {
      // Create user override file
      const userConfig = join(testHome, '.claude', 'mcp-configs', 'test-squad.json');
      writeMcpConfig({ mcpServers: { custom: { type: 'stdio', command: 'test', args: [] } } }, userConfig);

      const result = resolveMcpConfig('test-squad', ['x-mcp']);

      expect(result.source).toBe('user-override');
      expect(result.path).toBe(userConfig);
      expect(result.servers).toContain('custom');
    });

    it('uses existing generated config without regenerating', () => {
      // First call generates
      const first = resolveMcpConfig('test-squad', ['x-mcp']);
      expect(first.generated).toBe(true);

      // Second call uses existing
      const second = resolveMcpConfig('test-squad', ['x-mcp']);
      expect(second.generated).toBe(false);
      expect(second.path).toBe(first.path);
    });

    it('regenerates when force flag is set', () => {
      // First call generates
      resolveMcpConfig('test-squad', ['x-mcp']);

      // Second call with force regenerates
      const result = resolveMcpConfig('test-squad', ['nano-banana'], true);
      expect(result.generated).toBe(true);
      expect(result.servers).toContain('nano-banana');
    });
  });

  describe('resolveMcpConfigPath', () => {
    it('returns path string directly', () => {
      const originalHome = process.env.HOME;
      const testHome = join(tmpdir(), 'mcp-path-test-' + Date.now());

      try {
        process.env.HOME = testHome;
        mkdirSync(join(testHome, '.claude', 'contexts'), { recursive: true });

        const path = resolveMcpConfigPath('test-squad', ['x-mcp']);

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
