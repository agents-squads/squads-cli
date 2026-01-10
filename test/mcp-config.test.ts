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
      expect(servers).toContain('chrome-devtools');
      expect(servers).toContain('firecrawl');
      expect(servers).toContain('supabase');
      expect(servers).toContain('x-mcp');
      expect(servers.length).toBeGreaterThan(5);
    });

    it('checks if server is known', () => {
      expect(isKnownServer('chrome-devtools')).toBe(true);
      expect(isKnownServer('firecrawl')).toBe(true);
      expect(isKnownServer('unknown-server')).toBe(false);
    });

    it('gets server definition', () => {
      const chromeDef = getServerDef('chrome-devtools');
      expect(chromeDef).toBeDefined();
      expect(chromeDef?.type).toBe('stdio');
      expect(chromeDef?.command).toBe('npx');
      expect(chromeDef?.args).toContain('chrome-devtools-mcp');
    });

    it('returns undefined for unknown server', () => {
      expect(getServerDef('unknown-server')).toBeUndefined();
    });
  });

  describe('generateMcpConfig', () => {
    it('generates config from known servers', () => {
      const config = generateMcpConfig(['chrome-devtools', 'firecrawl']);

      expect(config.mcpServers).toBeDefined();
      expect(config.mcpServers['chrome-devtools']).toBeDefined();
      expect(config.mcpServers['firecrawl']).toBeDefined();
      expect(Object.keys(config.mcpServers)).toHaveLength(2);
    });

    it('skips unknown servers silently', () => {
      const config = generateMcpConfig(['chrome-devtools', 'unknown-server', 'firecrawl']);

      expect(Object.keys(config.mcpServers)).toHaveLength(2);
      expect(config.mcpServers['unknown-server']).toBeUndefined();
    });

    it('returns empty config for empty input', () => {
      const config = generateMcpConfig([]);
      expect(Object.keys(config.mcpServers)).toHaveLength(0);
    });

    it('preserves server definition structure', () => {
      const config = generateMcpConfig(['supabase']);
      const supabase = config.mcpServers['supabase'];

      expect(supabase.type).toBe('stdio');
      expect(supabase.command).toBe('npx');
      expect(supabase.args).toContain('@supabase/mcp-server-supabase@latest');
      expect(supabase.env).toBeDefined();
      expect(supabase.env?.SUPABASE_ACCESS_TOKEN).toBe('${SUPABASE_ACCESS_TOKEN}');
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
      const result = resolveMcpConfig('test-squad', ['chrome-devtools', 'firecrawl']);

      expect(result.source).toBe('generated');
      expect(result.servers).toContain('chrome-devtools');
      expect(result.servers).toContain('firecrawl');
      expect(result.generated).toBe(true);
      expect(result.path).toContain('test-squad.mcp.json');

      // Verify file was created
      expect(existsSync(result.path)).toBe(true);
    });

    it('returns user-override when squad config exists', () => {
      // Create user override file
      const userConfig = join(testHome, '.claude', 'mcp-configs', 'test-squad.json');
      writeMcpConfig({ mcpServers: { custom: { type: 'stdio', command: 'test', args: [] } } }, userConfig);

      const result = resolveMcpConfig('test-squad', ['chrome-devtools']);

      expect(result.source).toBe('user-override');
      expect(result.path).toBe(userConfig);
      expect(result.servers).toContain('custom');
    });

    it('uses existing generated config without regenerating', () => {
      // First call generates
      const first = resolveMcpConfig('test-squad', ['chrome-devtools']);
      expect(first.generated).toBe(true);

      // Second call uses existing
      const second = resolveMcpConfig('test-squad', ['chrome-devtools']);
      expect(second.generated).toBe(false);
      expect(second.path).toBe(first.path);
    });

    it('regenerates when force flag is set', () => {
      // First call generates
      resolveMcpConfig('test-squad', ['chrome-devtools']);

      // Second call with force regenerates
      const result = resolveMcpConfig('test-squad', ['firecrawl'], true);
      expect(result.generated).toBe(true);
      expect(result.servers).toContain('firecrawl');
    });
  });

  describe('resolveMcpConfigPath', () => {
    it('returns path string directly', () => {
      const originalHome = process.env.HOME;
      const testHome = join(tmpdir(), 'mcp-path-test-' + Date.now());

      try {
        process.env.HOME = testHome;
        mkdirSync(join(testHome, '.claude', 'contexts'), { recursive: true });

        const path = resolveMcpConfigPath('test-squad', ['chrome-devtools']);

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
