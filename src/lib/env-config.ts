/**
 * Environment configuration — single source of truth for all service URLs.
 *
 * Usage:
 *   squads config use <env>       Switch to a named environment
 *   squads config show            Show current config
 *
 * The only built-in environment is `local` (all URLs empty unless set via
 * SQUADS_API_URL etc.). Point at a hosted API by setting SQUADS_API_URL, or
 * define your own named environment in ~/.squads/config.json.
 *
 * Config stored at ~/.squads/config.json
 * Env vars override config values (for CI/CD and one-off overrides).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvironmentConfig {
  api_url: string;
  admin_api_url: string;
  console_url: string;
  bridge_url: string;
  database_url: string;
  redis_url: string;
  execution: 'local' | 'cloud';
}

export interface SquadsConfig {
  current: string;
  environments: Record<string, EnvironmentConfig>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.squads');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: SquadsConfig = {
  // Local-first product: a fresh install talks to nothing hosted until the
  // user sets SQUADS_API_URL (or defines their own environment) (#959).
  current: 'local',
  environments: {
    local: {
      api_url: process.env.SQUADS_API_URL || '',
      admin_api_url: process.env.SQUADS_ADMIN_API_URL || '',
      console_url: process.env.SQUADS_CONSOLE_URL || '',
      bridge_url: process.env.SQUADS_BRIDGE_URL || '',
      database_url: process.env.SQUADS_DATABASE_URL || '',
      redis_url: process.env.REDIS_URL || '',
      execution: 'local',
    },
  },
};

/**
 * Built-in presets that used to ship (pointing at one company's hosted
 * instance, which no longer resolves). Rejected by `switchEnv` with a clear
 * message, and stripped from older config files on load.
 */
const REMOVED_PRESETS: Record<string, string> = {
  staging: 'https://api-staging.agents-squads.com',
  prod: 'https://api.agents-squads.com',
};

function removedPresetMessage(name: string): string {
  return (
    `The "${name}" environment preset was removed (it pointed at hosts that no longer exist). ` +
    `Set SQUADS_API_URL to your API, or define a custom environment in ~/.squads/config.json.`
  );
}

/** Drop stale copies of the removed presets that older versions wrote to disk. */
function stripRemovedPresets(
  envs: Record<string, EnvironmentConfig>,
): Record<string, EnvironmentConfig> {
  const out: Record<string, EnvironmentConfig> = {};
  for (const [name, env] of Object.entries(envs)) {
    if (REMOVED_PRESETS[name] && env?.api_url === REMOVED_PRESETS[name]) continue;
    out[name] = env;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export function loadConfig(): SquadsConfig {
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return DEFAULT_CONFIG;
  }

  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const environments = {
      ...DEFAULT_CONFIG.environments,
      ...stripRemovedPresets((parsed.environments as Record<string, EnvironmentConfig>) || {}),
    };
    const current = (parsed.current as string) || 'local';
    return {
      // Spread everything from disk first so unknown/extra fields
      // survive a load → save cycle.
      ...(parsed as unknown as SquadsConfig),
      // A stale pointer at a removed preset falls back to local.
      current: REMOVED_PRESETS[current] && !environments[current] ? 'local' : current,
      environments,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function saveConfig(config: SquadsConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Resolve — env vars override config
// ---------------------------------------------------------------------------

export function getEnv(): EnvironmentConfig {
  const config = loadConfig();
  const envName = process.env.SQUADS_ENV || config.current;
  const env = config.environments[envName] || config.environments.local;

  return {
    api_url: process.env.SQUADS_API_URL || env.api_url,
    admin_api_url: process.env.SQUADS_ADMIN_API_URL || env.admin_api_url,
    console_url: process.env.SQUADS_CONSOLE_URL || env.console_url,
    bridge_url: process.env.SQUADS_BRIDGE_URL || env.bridge_url,
    database_url: process.env.SQUADS_DATABASE_URL || env.database_url,
    redis_url: process.env.REDIS_URL || env.redis_url,
    execution: env.execution,
  };
}

export function getEnvName(): string {
  const config = loadConfig();
  return process.env.SQUADS_ENV || config.current;
}

/**
 * Switch the active environment. Validates that the name is a known key in
 * the environments map. Returns `true` on success, throws on invalid name.
 */
export function switchEnv(name: string): SquadsConfig {
  const config = loadConfig();
  if (!config.environments[name]) {
    if (REMOVED_PRESETS[name]) throw new Error(removedPresetMessage(name));
    const valid = Object.keys(config.environments).join(', ');
    throw new Error(
      `Unknown environment "${name}". Valid environments: ${valid}`,
    );
  }
  config.current = name;
  saveConfig(config);
  return config;
}

export function getApiUrl(): string {
  return getEnv().api_url;
}

// Bridge = the HTTP gateway fronting Postgres; clients speak HTTP, never touch the DB directly.
export function getBridgeUrl(): string {
  return getEnv().bridge_url;
}

export function getConsoleUrl(): string {
  return getEnv().console_url;
}
