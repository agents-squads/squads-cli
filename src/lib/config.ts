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
  daily_budget_usd: number;
  monthly_budget_usd: number;
  company_name: string;
  compose_file: string | null;
  telemetry: boolean;
}

// ── Defaults ────────────────────────────────────────────────────────

const DEFAULTS: ProjectConfig = {
  agent_timeout_minutes: DEFAULT_TIMEOUT_MINUTES,
  token_budget: 50000,
  cost_ceiling: 25,
  daily_budget_usd: 0,     // 0 = no company-level daily cap
  monthly_budget_usd: 0,   // 0 = no company-level monthly cap
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
    const match = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s+(.*)/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    let value = match[2];
    // Strip inline comments — handle both unquoted and quoted values
    // For quoted: strip comment after closing quote. For unquoted: strip at #
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const closeIdx = value.indexOf(quote, 1);
      if (closeIdx > 0) {
        value = value.slice(1, closeIdx);
      }
    } else {
      const commentIdx = value.indexOf('#');
      if (commentIdx >= 0) {
        value = value.slice(0, commentIdx).trim();
      }
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
    daily_budget_usd: toNumber(
      process.env.SQUADS_DAILY_BUDGET_USD ?? fileValues.daily_budget_usd,
      DEFAULTS.daily_budget_usd,
    ),
    monthly_budget_usd: toNumber(
      process.env.SQUADS_MONTHLY_BUDGET_USD ?? fileValues.monthly_budget_usd,
      DEFAULTS.monthly_budget_usd,
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

// ── Fleet-Level Budget Enforcement ──────────────────────────────────

export interface BudgetCheckResult {
  allowed: boolean;
  message: string;
  /** Current spend in the window, USD. */
  currentSpend: number;
  /** Configured cap (0 = unlimited). */
  cap: number;
}

/**
 * Check whether dispatching another squad run would exceed the company-level
 * daily or monthly budget. Reads local executions.jsonl (same source as
 * `squads usage` — local-first, no API dependency).
 *
 * Returns { allowed: true } when no cap is configured (cap = 0).
 * Caps are SOFT: the caller decides whether to block, warn, or override.
 */
export function checkFleetBudget(obsRoot: string): { daily: BudgetCheckResult; monthly: BudgetCheckResult } {
  const config = loadProjectConfig();
  const dailyCap = config.daily_budget_usd;
  const monthlyCap = config.monthly_budget_usd;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const dayStart = now - (now % dayMs);
  // UTC month boundary — dayStart above is UTC-based; mixing in the local
  // timezone here would shift monthly totals by up to a month at boundaries.
  const nowDate = new Date(now);
  const monthStart = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1);
  let dailySpend = 0;
  let monthlySpend = 0;

  try {
    const execFile = join(obsRoot, '.agents', 'observability', 'executions.jsonl');
    if (existsSync(execFile)) {
      for (const line of readFileSync(execFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          const ts = e.started_at;
          if (!ts) continue;
          const epochMs = typeof ts === 'number' ? (ts > 1e12 ? ts : ts * 1000) : Date.parse(ts);
          if (isNaN(epochMs)) continue;
          const cost = parseFloat(e.cost_usd) || 0;
          if (epochMs >= dayStart) dailySpend += cost;
          if (epochMs >= monthStart) monthlySpend += cost;
        } catch { /* corrupt line */ }
      }
    }
  } catch { /* file unavailable */ }

  const dailyResult: BudgetCheckResult = {
    allowed: dailyCap === 0 || dailySpend < dailyCap,
    message: dailyCap === 0 ? 'no daily cap configured'
      : dailySpend >= dailyCap ? `daily budget exceeded: $${dailySpend.toFixed(2)} / $${dailyCap}`
      : `daily spend: $${dailySpend.toFixed(2)} / $${dailyCap} (${((dailySpend / dailyCap) * 100).toFixed(0)}%)`,
    currentSpend: dailySpend,
    cap: dailyCap,
  };

  const monthlyResult: BudgetCheckResult = {
    allowed: monthlyCap === 0 || monthlySpend < monthlyCap,
    message: monthlyCap === 0 ? 'no monthly cap configured'
      : monthlySpend >= monthlyCap ? `monthly budget exceeded: $${monthlySpend.toFixed(2)} / $${monthlyCap}`
      : `monthly spend: $${monthlySpend.toFixed(2)} / $${monthlyCap} (${((monthlySpend / monthlyCap) * 100).toFixed(0)}%)`,
    currentSpend: monthlySpend,
    cap: monthlyCap,
  };

  return { daily: dailyResult, monthly: monthlyResult };
}
