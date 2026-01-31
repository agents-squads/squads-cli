/**
 * User configuration management
 *
 * Manages ~/.squads/config.json for CLI configuration.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface SquadsConfig {
  version?: number;
  user?: {
    name?: string;
    email?: string;
  };
  models?: {
    default?: string;
    reasoning?: string;
    fast?: string;
  };
  daemon?: {
    port?: number;
    squad?: string;
    agent?: string;
  };
  api?: {
    base_url?: string;
    scheduler_url?: string;
  };
  channels?: {
    slack?: {
      enabled?: boolean;
    };
    telegram?: {
      enabled?: boolean;
    };
  };
  [key: string]: any; // Allow arbitrary config values
}

/**
 * Get the config directory path (~/.squads)
 */
export function getConfigDir(): string {
  return join(homedir(), '.squads');
}

/**
 * Get the config file path (~/.squads/config.json)
 */
export function getConfigPath(): string {
  return join(getConfigDir(), 'config.json');
}

/**
 * Load config from ~/.squads/config.json
 * Returns empty object if file doesn't exist
 */
export function loadConfig(): SquadsConfig {
  const configPath = getConfigPath();

  if (!existsSync(configPath)) {
    return {};
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    return JSON.parse(content) || {};
  } catch (error) {
    throw new Error(`Failed to parse config file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Save config to ~/.squads/config.json
 */
export function saveConfig(config: SquadsConfig): void {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }

  try {
    const json = JSON.stringify(config, null, 2);
    writeFileSync(configPath, json + '\n', 'utf-8');
  } catch (error) {
    throw new Error(`Failed to save config file: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get a nested config value using dot notation
 * Example: get(config, 'user.name') returns config.user?.name
 */
export function get(config: SquadsConfig, key: string): any {
  const parts = key.split('.');
  let value: any = config;

  for (const part of parts) {
    if (value === undefined || value === null) {
      return undefined;
    }
    value = value[part];
  }

  return value;
}

/**
 * Set a nested config value using dot notation
 * Example: set(config, 'user.name', 'John') sets config.user.name = 'John'
 */
export function set(config: SquadsConfig, key: string, value: any): void {
  const parts = key.split('.');
  const lastKey = parts.pop();

  if (!lastKey) {
    throw new Error('Invalid key: cannot be empty');
  }

  let current: any = config;
  for (const part of parts) {
    if (!(part in current) || typeof current[part] !== 'object') {
      current[part] = {};
    }
    current = current[part];
  }

  current[lastKey] = value;
}

/**
 * Unset a nested config value using dot notation
 * Example: unset(config, 'user.name') deletes config.user.name
 */
export function unset(config: SquadsConfig, key: string): void {
  const parts = key.split('.');
  const lastKey = parts.pop();

  if (!lastKey) {
    throw new Error('Invalid key: cannot be empty');
  }

  let current: any = config;
  for (const part of parts) {
    if (!(part in current)) {
      return; // Key doesn't exist, nothing to unset
    }
    current = current[part];
  }

  delete current[lastKey];
}

/**
 * Parse a string value to the appropriate type
 * Supports: boolean, number, JSON objects/arrays, strings
 */
export function parseValue(value: string): any {
  // Boolean
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Number
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return parseFloat(value);
  }

  // JSON object or array
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {
      // If JSON parse fails, treat as string
    }
  }

  // Default to string
  return value;
}

/**
 * Create default config with common settings
 */
export function createDefaultConfig(): SquadsConfig {
  return {
    version: 1,
    models: {
      default: 'claude-sonnet-4',
      reasoning: 'claude-opus-4-5',
      fast: 'claude-haiku-4-5',
    },
    daemon: {
      port: 18789,
      squad: 'company',
      agent: 'coo',
    },
    api: {
      base_url: 'https://api.agents-squads.com',
      scheduler_url: 'https://scheduler.agents-squads.com',
    },
    channels: {
      slack: {
        enabled: false,
      },
      telegram: {
        enabled: false,
      },
    },
  };
}
