/**
 * Environment configuration — single source of truth for all service URLs.
 *
 * Usage:
 *   squads config use local       Switch to local environment
 *   squads config use staging     Switch to staging
 *   squads config use prod        Switch to production
 *   squads config show            Show current config
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
  /** User email — captured opt-in during `squads init` for founder outreach */
  email?: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const CONFIG_DIR = join(homedir(), '.squads');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: SquadsConfig = {
  current: 'prod',
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
    staging: {
      api_url: 'https://api-staging.agents-squads.com',
      admin_api_url: 'https://api-staging.agents-squads.com',
      console_url: 'https://console-staging.agents-squads.com',
      bridge_url: '',
      database_url: '',
      redis_url: '',
      execution: 'cloud',
    },
    prod: {
      api_url: 'https://api.agents-squads.com',
      admin_api_url: 'https://api.agents-squads.com',
      console_url: 'https://console.agents-squads.com',
      bridge_url: '',
      database_url: '',
      redis_url: '',
      execution: 'cloud',
    },
  },
};

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
    const parsed = JSON.parse(raw) as Partial<SquadsConfig>;
    return {
      current: parsed.current || 'local',
      environments: {
        ...DEFAULT_CONFIG.environments,
        ...parsed.environments,
      },
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

/**
 * Persist the user's email address in ~/.squads/config.json.
 * Used for opt-in founder outreach captured during `squads init`.
 */
export function saveEmail(email: string): void {
  const config = loadConfig();
  config.email = email;
  saveConfig(config);
}

/**
 * Retrieve the stored user email, if any.
 */
export function getEmail(): string | undefined {
  return loadConfig().email;
}
