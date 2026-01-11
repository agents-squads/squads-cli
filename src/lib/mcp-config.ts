/**
 * MCP Config Generation and Resolution
 *
 * Provides dynamic MCP config generation based on squad context.
 * Three-tier resolution:
 * 1. User override: ~/.claude/mcp-configs/{squad}.json
 * 2. Generated from context.mcp: ~/.claude/contexts/{squad}.mcp.json
 * 3. Fallback: ~/.claude.json
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

/**
 * MCP server definition structure (matches Claude's .mcp.json format)
 */
export interface McpServerDef {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/**
 * Full MCP config structure
 */
export interface McpConfig {
  mcpServers: Record<string, McpServerDef>;
}

/**
 * Registry of known MCP servers with their configurations.
 * These can be referenced by name in SQUAD.md context.mcp arrays.
 *
 * NOTE: We prefer CLI tools over MCP when possible (less complexity).
 * MCP is reserved for APIs that don't have good CLI alternatives.
 */
const SERVER_REGISTRY: Record<string, McpServerDef> = {
  // Social APIs (no good CLI alternative)
  'x-mcp': {
    type: 'stdio',
    command: 'python3',
    args: ['~/.claude/mcps/x-mcp/server.py'],
    env: {
      X_BEARER_TOKEN: '${X_BEARER_TOKEN}',
    },
  },

  // Multi-model image generation (Grok, Gemini, GPT, etc.)
  'nano-banana': {
    type: 'stdio',
    command: 'npx',
    args: ['nano-banana-mcp'],
    env: {
      // Supports multiple providers - configure as needed
      OPENAI_API_KEY: '${OPENAI_API_KEY}',
      GEMINI_API_KEY: '${GEMINI_API_KEY}',
      XAI_API_KEY: '${XAI_API_KEY}',
    },
  },
};

/**
 * Get the home directory path.
 */
function getHome(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

/**
 * Get the path to generated contexts directory.
 */
export function getContextsDir(): string {
  return join(getHome(), '.claude', 'contexts');
}

/**
 * Get the path to user MCP configs directory.
 */
export function getMcpConfigsDir(): string {
  return join(getHome(), '.claude', 'mcp-configs');
}

/**
 * Check if a server is in the registry.
 */
export function isKnownServer(serverName: string): boolean {
  return serverName in SERVER_REGISTRY;
}

/**
 * Get server definition from registry.
 */
export function getServerDef(serverName: string): McpServerDef | undefined {
  return SERVER_REGISTRY[serverName];
}

/**
 * List all known servers in the registry.
 */
export function listKnownServers(): string[] {
  return Object.keys(SERVER_REGISTRY);
}

/**
 * Generate an MCP config from a list of server names.
 *
 * @param mcpServers - Array of server names to include
 * @returns Generated MCP config object
 */
export function generateMcpConfig(mcpServers: string[]): McpConfig {
  const config: McpConfig = { mcpServers: {} };

  for (const server of mcpServers) {
    const def = SERVER_REGISTRY[server];
    if (def) {
      config.mcpServers[server] = def;
    }
    // Unknown servers are silently skipped - they may be custom user servers
  }

  return config;
}

/**
 * Write an MCP config to a file.
 *
 * @param config - MCP config to write
 * @param path - Destination path
 */
export function writeMcpConfig(config: McpConfig, path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2));
}

/**
 * Read an existing MCP config file.
 *
 * @param path - Path to config file
 * @returns Parsed config or null if not found
 */
export function readMcpConfig(path: string): McpConfig | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content) as McpConfig;
  } catch {
    return null;
  }
}

/**
 * Resolution result with metadata.
 */
export interface McpResolution {
  /** Path to the MCP config to use */
  path: string;
  /** How the config was resolved */
  source: 'user-override' | 'generated' | 'fallback';
  /** Servers included (if generated or read) */
  servers?: string[];
  /** Whether config was freshly generated */
  generated?: boolean;
}

/**
 * Resolve the MCP config path for a squad using three-tier resolution:
 *
 * 1. User override: ~/.claude/mcp-configs/{squad}.json
 * 2. Generated from context.mcp: ~/.claude/contexts/{squad}.mcp.json
 * 3. Fallback: ~/.claude.json
 *
 * @param squadName - Name of the squad
 * @param mcpServers - Array of MCP server names from squad context (optional)
 * @param forceRegenerate - Force regeneration even if file exists
 * @returns Resolution result with path and metadata
 */
export function resolveMcpConfig(
  squadName: string,
  mcpServers?: string[],
  forceRegenerate = false
): McpResolution {
  const home = getHome();

  // Tier 1: User override
  const userOverride = join(getMcpConfigsDir(), `${squadName}.json`);
  if (existsSync(userOverride)) {
    const config = readMcpConfig(userOverride);
    return {
      path: userOverride,
      source: 'user-override',
      servers: config ? Object.keys(config.mcpServers) : undefined,
    };
  }

  // Tier 2: Generate from context.mcp
  if (mcpServers && mcpServers.length > 0) {
    const generatedPath = join(getContextsDir(), `${squadName}.mcp.json`);

    // Check if we need to regenerate
    const shouldGenerate = forceRegenerate || !existsSync(generatedPath);

    if (shouldGenerate) {
      const config = generateMcpConfig(mcpServers);
      writeMcpConfig(config, generatedPath);

      return {
        path: generatedPath,
        source: 'generated',
        servers: Object.keys(config.mcpServers),
        generated: true,
      };
    }

    // Use existing generated config
    const config = readMcpConfig(generatedPath);
    return {
      path: generatedPath,
      source: 'generated',
      servers: config ? Object.keys(config.mcpServers) : mcpServers,
      generated: false,
    };
  }

  // Tier 3: Fallback to default
  return {
    path: join(home, '.claude.json'),
    source: 'fallback',
  };
}

/**
 * Convenience function to just get the path (for backward compatibility).
 */
export function resolveMcpConfigPath(
  squadName: string,
  mcpServers?: string[]
): string {
  return resolveMcpConfig(squadName, mcpServers).path;
}
