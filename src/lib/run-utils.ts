/**
 * Pure utility functions for the `squads run` command.
 * Extracted from commands/run.ts — no side effects, no state.
 */
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { findSquadsDir, type Squad } from './squad-parser.js';
import { resolveMcpConfigPath } from './mcp-config.js';
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
 * Select MCP config based on squad name and context
 * Uses three-tier resolution:
 * 1. Squad context.mcp from SQUAD.md frontmatter (dynamic)
 * 2. User override at ~/.claude/mcp-configs/{squad}.json
 * 3. Legacy hardcoded mapping (backward compatibility)
 * 4. Fallback to ~/.claude.json
 */
export function selectMcpConfig(squadName: string, squad?: Squad | null): string {
  // Tier 1 & 2: Use new context-based resolution if squad has context.mcp
  if (squad?.context?.mcp && squad.context.mcp.length > 0) {
    return resolveMcpConfigPath(squadName, squad.context.mcp);
  }

  // Tier 3: Legacy hardcoded mapping (for squads without context block)
  const home = process.env.HOME || '';
  const configsDir = join(home, '.claude', 'mcp-configs');

  const squadConfigs: Record<string, string> = {
    website: 'website.json',
    research: 'research.json',
    intelligence: 'research.json',
    analytics: 'data.json',
    engineering: 'data.json',
  };

  const configFile = squadConfigs[squadName.toLowerCase()];
  if (configFile) {
    const configPath = join(configsDir, configFile);
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  // Tier 4: No MCP config — return empty string to skip --mcp-config flag.
  // Previously fell back to ~/.claude.json but that's Claude's settings file,
  // not an MCP config, and causes claude to exit silently with no output.
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

/**
 * Ensure the project directory is trusted in Claude's config.
 * This prevents the workspace trust dialog from blocking autonomous execution.
 */
export function ensureProjectTrusted(projectPath: string): void {
  const configPath = join(process.env.HOME || '', '.claude.json');

  if (!existsSync(configPath)) {
    // No Claude config yet - will be created on first interactive run
    return;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    if (!config.projects) {
      config.projects = {};
    }

    if (!config.projects[projectPath]) {
      config.projects[projectPath] = {};
    }

    // Mark as trusted for autonomous execution
    if (!config.projects[projectPath].hasTrustDialogAccepted) {
      config.projects[projectPath].hasTrustDialogAccepted = true;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } catch (e) {
    // Don't fail execution if we can't update config — the trust dialog will just appear
    writeLine(`  ${colors.dim}warn: config update failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
  }
}

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
