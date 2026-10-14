/**
 * Pure utility functions for the `squads run` command.
 * Extracted from commands/run.ts — no side effects, no state.
 */
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { findSquadsDir, type Squad } from './squad-parser.js';
import { getMcpConfigsDir, resolveMcpConfigPath } from './mcp-config.js';
import { colors, RESET, writeLine } from './terminal.js';
import type { ExecutionContext } from './run-types.js';

// ── Execution ID ─────────────────────────────────────────────────────

/**
 * Generate a unique execution ID for telemetry tracking
 */
export function generateExecutionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `exec_${timestamp}_${random}`;
}

// ── MCP config resolution ────────────────────────────────────────────

/**
 * Select MCP config based on squad name and context:
 * 1. Squad context.mcp from SQUAD.md frontmatter (generated config, or the
 *    user override at ~/.claude/mcp-configs/{squad}.json)
 * 2. User override at ~/.claude/mcp-configs/{squad}.json for squads without
 *    a context block
 * 3. None — empty string skips the --mcp-config flag
 */
export function selectMcpConfig(squadName: string, squad?: Squad | null): string {
  if (squad?.context?.mcp && squad.context.mcp.length > 0) {
    return resolveMcpConfigPath(squadName, squad.context.mcp);
  }

  const userConfig = join(getMcpConfigsDir(), `${squadName}.json`);
  if (existsSync(userConfig)) {
    return userConfig;
  }

  // No MCP config — empty string skips --mcp-config. (~/.claude.json is
  // Claude's settings file, not an MCP config: passing it makes claude exit
  // silently with no output.)
  return '';
}

// ── Task type detection ──────────────────────────────────────────────

/**
 * Detect task type from agent name patterns
 * - *-eval, *-critic, *-review → evaluation
 * - *-lead, *-orchestrator → lead
 * - *-research, *-analyst → research
 * - everything else → execution
 */
export function detectTaskType(agentName: string): ExecutionContext['taskType'] {
  const name = agentName.toLowerCase();
  if (name.includes('eval') || name.includes('critic') || name.includes('review') || name.includes('test')) {
    return 'evaluation';
  }
  if (name.includes('lead') || name.includes('orchestrator')) {
    return 'lead';
  }
  if (name.includes('research') || name.includes('analyst') || name.includes('intel')) {
    return 'research';
  }
  return 'execution';
}

// ── Model resolution ─────────────────────────────────────────────────

/** Claude Code --model flag aliases */
export type ClaudeModelAlias = 'opus' | 'sonnet' | 'haiku';

/**
 * Map full model names to Claude Code --model aliases.
 * Claude Code only accepts: opus, sonnet, haiku (not full model IDs)
 */
export function getClaudeModelAlias(model: string): ClaudeModelAlias | undefined {
  const lower = model.toLowerCase();

  // Direct aliases
  if (lower === 'opus' || lower === 'sonnet' || lower === 'haiku') {
    return lower as ClaudeModelAlias;
  }

  // Full model name mapping
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('sonnet')) return 'sonnet';
  if (lower.includes('haiku')) return 'haiku';

  // Unknown Claude model - let Claude Code handle it
  return undefined;
}

/**
 * Resolve model based on squad context and task type.
 * Priority: explicit --model flag > squad context routing > undefined (provider default)
 *
 * Supports multi-provider models:
 * - Anthropic: claude-opus-4-5, claude-sonnet-4, claude-3-5-haiku, opus, sonnet, haiku
 * - Google: gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash
 * - Others: model names passed through to provider CLI
 *
 * Routing logic:
 * - evaluation (critics, tests) → cheap model - simple validation
 * - research (analysts, intel) → default model - balanced
 * - execution (builders, fixers) → default model - balanced
 * - lead (orchestrators) → expensive model - complex coordination
 */
export function resolveModel(
  explicitModel: string | undefined,
  squad: Squad | null,
  taskType: ExecutionContext['taskType']
): string | undefined {
  // Explicit --model flag always wins
  if (explicitModel) {
    return explicitModel;
  }

  // No squad context = let provider decide
  const modelConfig = squad?.context?.model;
  if (!modelConfig) {
    return undefined;
  }

  // Route by task type
  switch (taskType) {
    case 'evaluation':
      // Critics/evals are simple - use cheap model
      return modelConfig.cheap || modelConfig.default;
    case 'lead':
      // Leads need complex reasoning - use expensive model
      return modelConfig.expensive || modelConfig.default;
    case 'research':
    case 'execution':
    default:
      // Default for most tasks
      return modelConfig.default;
  }
}

// ── Project trust ────────────────────────────────────────────────────


// ── Project root ─────────────────────────────────────────────────────

/**
 * Get the project root directory (where .agents/ lives)
 */
export function getProjectRoot(): string {
  const squadsDir = findSquadsDir();
  if (squadsDir) {
    // .agents/squads -> .agents -> project root
    return dirname(dirname(squadsDir));
  }
  return process.cwd();
}

// ── Duration formatting ──────────────────────────────────────────────

/**
 * Format milliseconds as human-readable duration
 */
export function formatDuration(ms: number): string {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

// ── CLI availability check ───────────────────────────────────────────

/**
 * Check if the Claude CLI binary is available on PATH
 */
export async function checkClaudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn('which', ['claude'], { stdio: 'pipe' });
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });
}

export const AUTH_PROBE_TIMEOUT_MS = 10000;
const NOT_LOGGED_IN_PATTERN = /not logged in|please run \/login/i;

/**
 * Probe whether the Claude CLI is authenticated by running a trivial prompt.
 * A stale OAuth/keychain session still answers normally, so this reads the
 * CLI's own error text rather than checking for an API key or credentials
 * file — an env/file-based check produced false positives for OAuth users
 * when it was tried before (#520).
 */
export function checkClaudeAuthenticated(): boolean {
  try {
    const output = execSync(`claude -p 'ok'`, {
      encoding: 'utf-8',
      timeout: AUTH_PROBE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return !NOT_LOGGED_IN_PATTERN.test(output);
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const combined = `${err.stdout ?? ''} ${err.stderr ?? ''} ${err.message ?? ''}`;
    return !NOT_LOGGED_IN_PATTERN.test(combined);
  }
}
