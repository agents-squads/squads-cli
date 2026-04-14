/**
 * Project-level configuration loader.
 *
 * Resolution order (highest wins):
 *   1. Environment variable (SQUADS_* prefix)
 *   2. .squads/config.yml in project root
 *   3. Named constant defaults (from run-types.ts and here)
 *
 * The YAML parser is intentionally minimal — flat key: value only,
 * no nesting, no external dependencies. Comments (#) and empty lines
 * are skipped.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findProjectRoot } from './squad-parser.js';
import { DEFAULT_TIMEOUT_MINUTES } from './run-types.js';

// ── Interface ───────────────────────────────────────────────────────

export interface ProjectConfig {
  agent_timeout_minutes: number;
  token_budget: number;
  cost_ceiling: number;
  company_name: string;
  compose_file: string | null;
  telemetry: boolean;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULTS: ProjectConfig = {
  agent_timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
  token_budget: 50000,
  cost_ceiling: 25,
  company_name: '',
  compose_file: null,
  telemetry: true,
};

// ── Cache ───────────────────────────────────────────────────────────

let cachedConfig: ProjectConfig | null = null;

// ── Minimal YAML parser ─────────────────────────────────────────────

/**
 * Parse a flat YAML file into a Record<string, string>.
 * Handles comments (#), empty lines, and simple `key: value` pairs.
 * Strips surrounding quotes from values.
 */
function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    // Skip empty lines, comments, and comment-only lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Match `key: value` — colon must be followed by a space (YAML spec)
    const match = trimmed.match(/^([a-z_][a-z0-9_]*):\s+(.*)/);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    // Strip inline comments (but not inside quoted strings)
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf('#');
      if (commentIdx > 0) {
        value = value.slice(0, commentIdx).trim();
      }
    }
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

// ── Config file discovery ───────────────────────────────────────────

/**
 * Search for .squads/config.yml starting from findProjectRoot().
 * Returns the file path if found, null otherwise.
 */
function findConfigFile(): string | null {
  const root = findProjectRoot();
  if (root) {
    const candidate = join(root, '.squads', 'config.yml');
    if (existsSync(candidate)) return candidate;
  }
  // Also check cwd in case findProjectRoot returns null
  const cwdCandidate = join(process.cwd(), '.squads', 'config.yml');
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return null;
}

// ── Helpers ─────────────────────────────────────────────────────────

function toNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const lower = value.toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return fallback;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Load project configuration with the resolution chain:
 *   env var > .squads/config.yml > default constant
 *
 * Result is cached for the lifetime of the process.
 */
export function loadProjectConfig(): ProjectConfig {
  if (cachedConfig) return cachedConfig;

  // Load file values (may be empty if no config file)
  let fileValues: Record<string, string> = {};
  const configPath = findConfigFile();
  if (configPath) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      fileValues = parseSimpleYaml(content);
    } catch {
      // Unreadable config file — fall through to defaults
    }
  }

  cachedConfig = {
    agent_timeout_minutes: toNumber(
      process.env.SQUADS_AGENT_TIMEOUT_MINUTES ?? fileValues.agent_timeout_minutes,
      DEFAULTS.agent_timeout_minutes,
    ),
    token_budget: toNumber(
      process.env.SQUADS_TOKEN_BUDGET ?? fileValues.token_budget,
      DEFAULTS.token_budget,
    ),
    cost_ceiling: toNumber(
      process.env.SQUADS_COST_CEILING ?? fileValues.cost_ceiling,
      DEFAULTS.cost_ceiling,
    ),
    company_name:
      process.env.SQUADS_COMPANY_NAME ?? fileValues.company_name ?? DEFAULTS.company_name,
    compose_file:
      process.env.SQUADS_COMPOSE_FILE ?? fileValues.compose_file ?? DEFAULTS.compose_file,
    telemetry: toBoolean(
      process.env.SQUADS_TELEMETRY ?? fileValues.telemetry,
      DEFAULTS.telemetry,
    ),
  };

  return cachedConfig;
}

/**
 * Reset the cached config. Useful for tests.
 */
export function resetConfigCache(): void {
  cachedConfig = null;
}
