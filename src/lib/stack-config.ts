/**
 * Stack configuration loading from ~/.squadsrc
 * Extracted from stack.ts for use at CLI startup
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

interface StackConfig {
  SQUADS_DATABASE_URL?: string;
  SQUADS_BRIDGE_URL: string;
  LANGFUSE_HOST: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  REDIS_URL?: string;
}

const DEFAULT_CONFIG: StackConfig = {
  SQUADS_DATABASE_URL: 'postgresql://squads:squads@localhost:5433/squads',
  SQUADS_BRIDGE_URL: 'http://localhost:8088',
  LANGFUSE_HOST: 'http://localhost:3100',
  LANGFUSE_PUBLIC_KEY: '',
  LANGFUSE_SECRET_KEY: '',
  REDIS_URL: 'redis://localhost:6379',
};

const CONFIG_PATH = join(homedir(), '.squadsrc');

/**
 * Load stack configuration from ~/.squadsrc
 */
export function loadStackConfig(): Partial<StackConfig> | null {
  if (!existsSync(CONFIG_PATH)) {
    return null;
  }

  try {
    const content = readFileSync(CONFIG_PATH, 'utf-8');
    const config: Partial<StackConfig> = {};

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^export\s+(\w+)=["']?([^"'\n]*)["']?$/);
      if (match) {
        const [, key, value] = match;
        if (key in DEFAULT_CONFIG) {
          (config as Record<string, string>)[key] = value;
        }
      }
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Apply stack config to current process environment
 */
export function applyStackConfig(): void {
  const config = loadStackConfig();
  if (!config) return;

  for (const [key, value] of Object.entries(config)) {
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
}
