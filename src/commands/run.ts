import ora from 'ora';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  loadAgentDefinition,
  parseAgentProvider,
  EffortLevel,
  Squad,
} from '../lib/squad-parser.js';
import { resolveMcpConfigPath } from '../lib/mcp-config.js';
import {
  buildContextFromSquad,
  validateExecution,
  formatViolations,
  ExecutionRequest
} from '../lib/permissions.js';
import { findMemoryDir } from '../lib/memory.js';
import { track, Events, flushEvents } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';
import {
  getCLIConfig,
  isProviderCLIAvailable,
} from '../lib/llm-clis.js';
import { detectProviderFromModel } from '../lib/providers.js';

interface RunOptions {
  verbose?: boolean;
  dryRun?: boolean;
  agent?: string;
  timeout?: number; // minutes, default 30
  execute?: boolean;
  parallel?: boolean; // Run all agents in parallel
  lead?: boolean; // Run as lead session using Task tool for parallelization
  foreground?: boolean; // Run in foreground (deprecated, now default)
  background?: boolean; // Run in background (detached process)
  watch?: boolean; // Run in background but tail the log
  useApi?: boolean; // Use API credits instead of subscription
  effort?: EffortLevel; // Effort level: high, medium, low
  skills?: string[]; // Skills to load (skill IDs or local paths)
  trigger?: 'manual' | 'scheduled' | 'event' | 'smart'; // Trigger source for telemetry
  provider?: string; // LLM provider: anthropic, google, openai, mistral, xai, aider, ollama
  model?: 'opus' | 'sonnet' | 'haiku'; // Claude model - route by task difficulty
}

/**
 * Execution context for telemetry tagging
 * Passed to Claude via environment variables for per-agent cost tracking
 */
interface ExecutionContext {
  squad: string;
  agent: string;
  taskType: 'evaluation' | 'execution' | 'research' | 'lead';
  trigger: 'manual' | 'scheduled' | 'event' | 'smart';
  executionId: string;
}

/**
 * Register execution context with the squads-bridge for telemetry
 * This allows the bridge to tag incoming OTel data with correct squad/agent info
 */
async function registerContextWithBridge(ctx: ExecutionContext): Promise<boolean> {
  const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';

  try {
    const response = await fetch(`${bridgeUrl}/api/context/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        execution_id: ctx.executionId,
        squad: ctx.squad,
        agent: ctx.agent,
        task_type: ctx.taskType,
        trigger: ctx.trigger,
      }),
    });

    if (!response.ok) {
      // Non-fatal - continue even if bridge is unavailable
      return false;
    }
    return true;
  } catch {
    // Bridge not available - continue anyway
    return false;
  }
}

/**
 * Pre-execution gate check via bridge API.
 * Checks quota (monthly spend) and cooldown before running an agent.
 * Fails open (allows execution) if bridge is unavailable.
 */
interface PreflightResult {
  allowed: boolean;
  gates: {
    quota?: { ok: boolean; used: number; limit: number; remaining: number; period: string };
    cooldown?: { ok: boolean; elapsed_sec: number | null; min_gap_sec: number };
  };
  error?: string;
}

async function checkPreflightGates(squad: string, agent: string): Promise<PreflightResult> {
  const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';

  try {
    const response = await fetch(`${bridgeUrl}/api/execution/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ squad, agent }),
    });

    if (!response.ok) {
      // Fail open if bridge returns error
      return { allowed: true, gates: {} };
    }

    return await response.json() as PreflightResult;
  } catch {
    // Fail open if bridge is unavailable
    return { allowed: true, gates: {} };
  }
}

/**
 * Fetch relevant learnings from bridge for prompt injection.
 * Returns empty array if bridge is unavailable.
 */
interface Learning {
  content: string;
  importance: string;
  created_at: string;
}

async function fetchLearnings(squad: string, limit = 5): Promise<Learning[]> {
  const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';

  try {
    const response = await fetch(
      `${bridgeUrl}/api/learnings/relevant?squad=${encodeURIComponent(squad)}&limit=${limit}`
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as { learnings: Learning[] };
    return data.learnings || [];
  } catch {
    return [];
  }
}

/**
 * Load approval/escalation instructions from config file.
 * Returns the instructions content or empty string if not found.
 */
function loadApprovalInstructions(): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return '';

  // Try .agents/config/approval-instructions.md
  const instructionsPath = join(dirname(squadsDir), 'config', 'approval-instructions.md');

  if (existsSync(instructionsPath)) {
    try {
      return readFileSync(instructionsPath, 'utf-8');
    } catch {
      return '';
    }
  }

  return '';
}

/**
 * Gather squad context for prompt injection.
 * Includes SQUAD.md mission/goals, agent's existing state, and relevant briefs.
 * This ensures agents build on existing knowledge rather than starting from scratch.
 */
function gatherSquadContext(
  squadName: string,
  agentName: string,
  options: { verbose?: boolean; maxTokens?: number } = {}
): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return '';

  const memoryDir = findMemoryDir();
  const maxTokens = options.maxTokens || 8000; // ~8k tokens of context by default
  const sections: string[] = [];
  let estimatedTokens = 0;

  // Helper to estimate tokens (rough: ~4 chars per token)
  const estimateTokens = (text: string) => Math.ceil(text.length / 4);

  // 1. SQUAD.md - mission, goals, and key context
  const squadFile = join(squadsDir, squadName, 'SQUAD.md');
  if (existsSync(squadFile)) {
    try {
      const squadContent = readFileSync(squadFile, 'utf-8');
      // Extract key sections (skip frontmatter YAML, focus on mission/goals/output)
      const missionMatch = squadContent.match(/## Mission[\s\S]*?(?=\n## |$)/i);
      const goalsMatch = squadContent.match(/## (?:Goals|Objectives)[\s\S]*?(?=\n## |$)/i);
      const outputMatch = squadContent.match(/## Output[\s\S]*?(?=\n## |$)/i);
      const contextMatch = squadContent.match(/## Context[\s\S]*?(?=\n## |$)/i);

      let squadContext = '';
      if (missionMatch) squadContext += missionMatch[0] + '\n';
      if (goalsMatch) squadContext += goalsMatch[0] + '\n';
      if (outputMatch) squadContext += outputMatch[0] + '\n';
      if (contextMatch) squadContext += contextMatch[0] + '\n';

      // If no structured sections found, include first 2000 chars
      if (!squadContext && squadContent.length > 0) {
        squadContext = squadContent.substring(0, 2000);
      }

      if (squadContext) {
        const tokens = estimateTokens(squadContext);
        if (estimatedTokens + tokens < maxTokens) {
          sections.push(`## Squad Context (${squadName})\n${squadContext.trim()}`);
          estimatedTokens += tokens;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // 2. Agent's existing state (state.md) - what the agent knows
  if (memoryDir) {
    const stateFile = join(memoryDir, squadName, agentName, 'state.md');
    if (existsSync(stateFile)) {
      try {
        const stateContent = readFileSync(stateFile, 'utf-8');
        const tokens = estimateTokens(stateContent);

        if (estimatedTokens + tokens < maxTokens && stateContent.trim()) {
          sections.push(`## Your Previous State\nThis is your memory from your last execution:\n\n${stateContent.trim()}`);
          estimatedTokens += tokens;
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // 3. Related briefs (if any exist in memory/squad/agent/briefs/)
  if (memoryDir) {
    const briefsDir = join(memoryDir, squadName, agentName, 'briefs');
    if (existsSync(briefsDir)) {
      try {
        const briefFiles = readdirSync(briefsDir)
          .filter(f => f.endsWith('.md'))
          .slice(0, 3); // Max 3 briefs

        for (const briefFile of briefFiles) {
          const briefPath = join(briefsDir, briefFile);
          const briefContent = readFileSync(briefPath, 'utf-8');
          const tokens = estimateTokens(briefContent);

          if (estimatedTokens + tokens < maxTokens) {
            sections.push(`## Brief: ${briefFile.replace('.md', '')}\n${briefContent.trim()}`);
            estimatedTokens += tokens;
          } else {
            break; // Stop adding briefs if we're over budget
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  // 4. Squad-level briefs (shared context for all agents in squad)
  if (memoryDir) {
    const squadBriefsDir = join(memoryDir, squadName, '_briefs');
    if (existsSync(squadBriefsDir)) {
      try {
        const squadBriefs = readdirSync(squadBriefsDir)
          .filter(f => f.endsWith('.md'))
          .slice(0, 2); // Max 2 squad briefs

        for (const briefFile of squadBriefs) {
          const briefPath = join(squadBriefsDir, briefFile);
          const briefContent = readFileSync(briefPath, 'utf-8');
          const tokens = estimateTokens(briefContent);

          if (estimatedTokens + tokens < maxTokens) {
            sections.push(`## Squad Brief: ${briefFile.replace('.md', '')}\n${briefContent.trim()}`);
            estimatedTokens += tokens;
          } else {
            break;
          }
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  if (sections.length === 0) {
    return '';
  }

  if (options.verbose) {
    writeLine(`  ${colors.dim}Context: ${sections.length} sections (~${estimatedTokens} tokens)${RESET}`);
  }

  return `\n# EXISTING CONTEXT\nBuild on this existing knowledge - do NOT start from scratch:\n\n${sections.join('\n\n')}\n`;
}

/**
 * Generate a unique execution ID for telemetry tracking
 */
function generateExecutionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `exec_${timestamp}_${random}`;
}

/**
 * Select MCP config based on squad name and context
 * Uses three-tier resolution:
 * 1. Squad context.mcp from SQUAD.md frontmatter (dynamic)
 * 2. User override at ~/.claude/mcp-configs/{squad}.json
 * 3. Legacy hardcoded mapping (backward compatibility)
 * 4. Fallback to ~/.claude.json
 */
function selectMcpConfig(squadName: string, squad?: Squad | null): string {
  // Tier 1 & 2: Use new context-based resolution if squad has context.mcp
  if (squad?.context?.mcp && squad.context.mcp.length > 0) {
    return resolveMcpConfigPath(squadName, squad.context.mcp);
  }

  // Tier 3: Legacy hardcoded mapping (for squads without context block)
  const home = process.env.HOME || '';
  const configsDir = join(home, '.claude', 'mcp-configs');

  const squadConfigs: Record<string, string> = {
    website: 'website.json',      // chrome-devtools, nano-banana
    research: 'research.json',    // x-mcp
    intelligence: 'research.json', // x-mcp
    analytics: 'data.json',       // supabase, grafana, ga4-admin
    engineering: 'data.json',     // supabase, grafana
  };

  const configFile = squadConfigs[squadName.toLowerCase()];
  if (configFile) {
    const configPath = join(configsDir, configFile);
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  // Tier 4: Fallback to default user config
  return join(home, '.claude.json');
}

/**
 * Detect task type from agent name patterns
 * - *-eval, *-critic, *-review → evaluation
 * - *-lead, *-orchestrator → lead
 * - *-research, *-analyst → research
 * - everything else → execution
 */
function detectTaskType(agentName: string): ExecutionContext['taskType'] {
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

/** Claude Code --model flag aliases */
type ClaudeModelAlias = 'opus' | 'sonnet' | 'haiku';

/**
 * Map full model names to Claude Code --model aliases.
 * Claude Code only accepts: opus, sonnet, haiku (not full model IDs)
 */
function getClaudeModelAlias(model: string): ClaudeModelAlias | undefined {
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
function resolveModel(
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

/**
 * Ensure the project directory is trusted in Claude's config.
 * This prevents the workspace trust dialog from blocking autonomous execution.
 */
function ensureProjectTrusted(projectPath: string): void {
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
  } catch {
    // Don't fail execution if we can't update config
    // The dialog will just appear
  }
}

/**
 * Get the project root directory (where .agents/ lives)
 */
function getProjectRoot(): string {
  const squadsDir = findSquadsDir();
  if (squadsDir) {
    // .agents/squads -> .agents -> project root
    return dirname(dirname(squadsDir));
  }
  return process.cwd();
}

interface ExecutionRecord {
  squadName: string;
  agentName: string;
  executionId: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed';
  trigger?: 'manual' | 'scheduled' | 'event' | 'smart';
  taskType?: 'evaluation' | 'execution' | 'research' | 'lead';
  outcome?: string;
  error?: string;
}

function getExecutionLogPath(squadName: string, agentName: string): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;
  return join(memoryDir, squadName, agentName, 'executions.md');
}

function logExecution(record: ExecutionRecord): void {
  const logPath = getExecutionLogPath(record.squadName, record.agentName);
  if (!logPath) return;

  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let content = '';
  if (existsSync(logPath)) {
    content = readFileSync(logPath, 'utf-8').trimEnd();
  } else {
    content = `# ${record.squadName}/${record.agentName} - Execution Log`;
  }

  // Structured entry format for parsing
  const entry = `

---
<!-- exec:${record.executionId} -->
**${record.startTime}** | Status: ${record.status}
- ID: \`${record.executionId}\`
- Trigger: ${record.trigger || 'manual'}
- Task Type: ${record.taskType || 'execution'}
`;

  writeFileSync(logPath, content + entry);
}

function updateExecutionStatus(
  squadName: string,
  agentName: string,
  executionId: string,
  status: 'completed' | 'failed',
  details?: {
    outcome?: string;
    error?: string;
    durationMs?: number;
  }
): void {
  const logPath = getExecutionLogPath(squadName, agentName);
  if (!logPath || !existsSync(logPath)) return;

  let content = readFileSync(logPath, 'utf-8');
  const endTime = new Date().toISOString();

  // Find and update the specific execution by ID
  const execMarker = `<!-- exec:${executionId} -->`;
  const markerIndex = content.indexOf(execMarker);

  if (markerIndex === -1) return;

  // Find the next entry marker or end of file
  const nextEntryIndex = content.indexOf('\n---\n', markerIndex + 1);
  const entryEnd = nextEntryIndex === -1 ? content.length : nextEntryIndex;

  // Extract and update the entry
  const entryStart = content.lastIndexOf('\n---\n', markerIndex);
  const currentEntry = content.slice(entryStart, entryEnd);

  // Build completion details
  const durationStr = details?.durationMs
    ? `${(details.durationMs / 1000).toFixed(1)}s`
    : 'unknown';

  let updatedEntry = currentEntry
    .replace(/Status: running/, `Status: ${status}`)
    + `- Completed: ${endTime}
- Duration: ${durationStr}`;

  if (details?.outcome) {
    updatedEntry += `\n- Outcome: ${details.outcome}`;
  }
  if (details?.error) {
    updatedEntry += `\n- Error: ${details.error}`;
  }

  // Replace the entry in content
  content = content.slice(0, entryStart) + updatedEntry + content.slice(entryEnd);
  writeFileSync(logPath, content);
}

/**
 * Auto-commit agent work after execution completes.
 * Commits any uncommitted changes made by the agent.
 */
async function autoCommitAgentWork(
  squadName: string,
  agentName: string,
  executionId: string
): Promise<{ committed: boolean; message?: string; error?: string }> {
  const { execSync } = await import('child_process');
  const projectRoot = getProjectRoot();

  try {
    // Check for uncommitted changes
    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      cwd: projectRoot,
    }).trim();

    if (!status) {
      return { committed: false };
    }

    // Stage all changes (agent work should be committed)
    execSync('git add -A', { cwd: projectRoot });

    // Build commit message
    const shortExecId = executionId.slice(0, 12);
    const message = `feat(${squadName}/${agentName}): execution ${shortExecId}\n\nCo-Authored-By: Claude <noreply@anthropic.com>`;

    // Commit
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: projectRoot });

    // Push to origin
    try {
      execSync('git push origin HEAD', { cwd: projectRoot, stdio: 'pipe' });
    } catch {
      // Push failed - continue, the commit is still local
    }

    return { committed: true, message: `Committed changes from ${agentName}` };
  } catch (error) {
    return { committed: false, error: String(error) };
  }
}

/**
 * Get the timestamp of the last execution from executions.md
 */
function getLastExecutionTime(squadName: string, agentName: string): Date | null {
  const logPath = getExecutionLogPath(squadName, agentName);
  if (!logPath || !existsSync(logPath)) return null;

  const content = readFileSync(logPath, 'utf-8');

  // Find all timestamps in the format **2026-01-21T14:00:02.358Z**
  const timestamps = content.match(/\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\*\*/g);
  if (!timestamps || timestamps.length === 0) return null;

  // Get the last (most recent) timestamp
  const lastTimestamp = timestamps[timestamps.length - 1].replace(/\*\*/g, '');
  return new Date(lastTimestamp);
}

/**
 * Local cooldown check - works without bridge
 * Returns { ok: true } if allowed, { ok: false, ... } if blocked
 */
function checkLocalCooldown(
  squadName: string,
  agentName: string,
  cooldownMs: number
): { ok: boolean; elapsedMs?: number; cooldownMs: number } {
  const lastExec = getLastExecutionTime(squadName, agentName);
  if (!lastExec) return { ok: true, cooldownMs };

  const elapsedMs = Date.now() - lastExec.getTime();
  if (elapsedMs < cooldownMs) {
    return { ok: false, elapsedMs, cooldownMs };
  }

  return { ok: true, elapsedMs, cooldownMs };
}

/**
 * Format milliseconds as human-readable duration
 */
function formatDuration(ms: number): string {
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

/**
 * Extract MCP servers mentioned in an agent definition
 * Looks for patterns like: mcp-server-name, chrome-devtools, firecrawl, etc.
 */
function extractMcpServersFromDefinition(definition: string): string[] {
  const servers: Set<string> = new Set();

  // Common MCP server patterns
  const knownServers = [
    'chrome-devtools',
    'firecrawl',
    'supabase',
    'grafana',
    'context7',
    'huggingface',
    'nano-banana'
  ];

  // Check for known servers in the definition
  for (const server of knownServers) {
    if (definition.toLowerCase().includes(server)) {
      servers.add(server);
    }
  }

  // Look for mcp: blocks in YAML
  const mcpMatch = definition.match(/mcp:\s*\n((?:\s*-\s*\S+\s*\n?)+)/i);
  if (mcpMatch) {
    const lines = mcpMatch[1].split('\n');
    for (const line of lines) {
      const serverMatch = line.match(/^\s*-\s*(\S+)/);
      if (serverMatch) {
        servers.add(serverMatch[1]);
      }
    }
  }

  return Array.from(servers);
}

export async function runCommand(
  target: string,
  options: RunOptions
): Promise<void> {
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  // Check if target uses squad/agent syntax (e.g., "demo/researcher")
  let squadName = target;
  let agentFromSlash: string | undefined;

  if (target.includes('/')) {
    const parts = target.split('/');
    squadName = parts[0];
    agentFromSlash = parts[1];
    if (!options.agent) {
      options.agent = agentFromSlash;
    }
  }

  // Check if target is a squad or an agent
  const squad = loadSquad(squadName);

  if (squad) {
    await track(Events.CLI_RUN, { type: 'squad', target: squad.name });
    await flushEvents(); // Ensure telemetry is sent before potential exit
    await runSquad(squad, squadsDir, options);
  } else {
    // Try to find as an agent
    const agents = listAgents(squadsDir);
    const agent = agents.find(a => a.name === target);

    if (agent && agent.filePath) {
      // Extract squad name from path
      const pathParts = agent.filePath.split('/');
      const squadIdx = pathParts.indexOf('squads');
      const squadName = squadIdx >= 0 ? pathParts[squadIdx + 1] : 'unknown';
      await runAgent(agent.name, agent.filePath, squadName, options);
    } else {
      writeLine(`  ${colors.red}Squad or agent "${target}" not found${RESET}`);
      writeLine(`  ${colors.dim}Run \`squads list\` to see available squads and agents.${RESET}`);
      process.exit(1);
    }
  }
}

async function runSquad(
  squad: ReturnType<typeof loadSquad>,
  squadsDir: string,
  options: RunOptions
): Promise<void> {
  if (!squad) return;

  // Inherit effort from squad config if not provided via CLI
  if (!options.effort && squad.effort) {
    options.effort = squad.effort;
  }

  const startTime = new Date().toISOString();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}run${RESET} ${colors.cyan}${squad.name}${RESET}`);
  writeLine();
  if (squad.mission) {
    writeLine(`  ${colors.dim}${squad.mission}${RESET}`);
    writeLine();
  }
  writeLine(`  ${colors.dim}Started: ${startTime}${RESET}`);
  writeLine();

  // LEAD MODE: Single orchestrator session using Task tool for parallelization
  if (options.lead) {
    await runLeadMode(squad, squadsDir, options);
    return;
  }

  // PARALLEL EXECUTION: --parallel --execute runs all agents simultaneously
  if (options.parallel) {
    const agentFiles = squad.agents
      .map(a => ({
        name: a.name,
        path: join(squadsDir, squad.dir, `${a.name}.md`)
      }))
      .filter(a => existsSync(a.path));

    if (agentFiles.length === 0) {
      writeLine(`  ${icons.error} ${colors.red}No agent files found${RESET}`);
      return;
    }

    writeLine(`  ${bold}Parallel execution${RESET} ${colors.dim}${agentFiles.length} agents${RESET}`);
    writeLine();

    if (!options.execute) {
      // Preview mode
      for (const agent of agentFiles) {
        writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET}`);
      }
      writeLine();
      writeLine(`  ${colors.dim}Launch all agents in parallel:${RESET}`);
      writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --parallel --execute`);
      writeLine();
      return;
    }

    // Execute all in parallel
    writeLine(`  ${gradient('Launching')} ${agentFiles.length} agents in parallel...`);
    writeLine();

    const launches = agentFiles.map(agent =>
      runAgent(agent.name, agent.path, squad.dir, options)
    );

    await Promise.all(launches);

    writeLine();
    writeLine(`  ${icons.success} All ${agentFiles.length} agents launched`);
    writeLine(`  ${colors.dim}Monitor: tmux ls | grep squads-${squad.name}${RESET}`);
    writeLine(`  ${colors.dim}Attach:  tmux attach -t <session>${RESET}`);
    writeLine();
    return;
  }

  // If there's a pipeline, run agents in order
  if (squad.pipelines.length > 0) {
    const pipeline = squad.pipelines[0];
    writeLine(`  ${bold}Pipeline${RESET} ${colors.dim}${pipeline.agents.join(' → ')}${RESET}`);
    writeLine();

    for (let i = 0; i < pipeline.agents.length; i++) {
      const agentName = pipeline.agents[i];
      const agentPath = join(squadsDir, squad.dir, `${agentName}.md`);

      if (existsSync(agentPath)) {
        writeLine(`  ${colors.dim}[${i + 1}/${pipeline.agents.length}]${RESET}`);
        await runAgent(agentName, agentPath, squad.dir, options);
        writeLine();
      } else {
        writeLine(`  ${icons.warning} ${colors.yellow}Agent ${agentName} not found, skipping${RESET}`);
      }
    }
  } else {
    // If specific agent requested via -a flag, run that agent
    if (options.agent) {
      const agentPath = join(squadsDir, squad.dir, `${options.agent}.md`);
      if (existsSync(agentPath)) {
        await runAgent(options.agent, agentPath, squad.dir, options);
      } else {
        writeLine(`  ${icons.error} ${colors.red}Agent ${options.agent} not found${RESET}`);
        return;
      }
    } else {
      // Run orchestrator if exists, otherwise list agents
      const orchestrator = squad.agents.find(a =>
        a.name.includes('lead') || a.trigger === 'Manual'
      );

      if (orchestrator) {
        const agentPath = join(squadsDir, squad.dir, `${orchestrator.name}.md`);
        if (existsSync(agentPath)) {
          await runAgent(orchestrator.name, agentPath, squad.dir, options);
        }
      } else {
        writeLine(`  ${colors.dim}No pipeline defined. Available agents:${RESET}`);
        for (const agent of squad.agents) {
          writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
        }
        writeLine();
        writeLine(`  ${colors.dim}Run a specific agent:${RESET}`);
        writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --agent ${colors.cyan}<name>${RESET}`);
        writeLine();
        writeLine(`  ${colors.dim}Run all agents in parallel:${RESET}`);
        writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --parallel --execute`);
      }
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}After execution, record outcome:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads feedback add ${colors.cyan}${squad.name}${RESET} ${colors.cyan}<1-5>${RESET} ${colors.cyan}"<feedback>"${RESET}`);
  writeLine();
}

/**
 * Lead mode: Single orchestrator session that uses Task tool for parallel work.
 * Benefits over --parallel:
 * - Single session overhead vs N sessions
 * - Lead coordinates and routes work intelligently
 * - Task agents share context when needed
 * - Better parallelization (Claude's native Task tool)
 */
async function runLeadMode(
  squad: ReturnType<typeof loadSquad>,
  squadsDir: string,
  options: RunOptions
): Promise<void> {
  if (!squad) return;

  const agentFiles = squad.agents
    .map(a => ({
      name: a.name,
      path: join(squadsDir, squad.dir, `${a.name}.md`),
      role: a.role || '',
    }))
    .filter(a => existsSync(a.path));

  if (agentFiles.length === 0) {
    writeLine(`  ${icons.error} ${colors.red}No agent files found${RESET}`);
    return;
  }

  writeLine(`  ${bold}Lead mode${RESET} ${colors.dim}orchestrating ${agentFiles.length} agents${RESET}`);
  writeLine();

  // List available agents
  for (const agent of agentFiles) {
    writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
  }
  writeLine();

  if (!options.execute) {
    writeLine(`  ${colors.dim}Launch lead session:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --lead --execute`);
    writeLine();
    return;
  }

  // Build the lead prompt
  const timeoutMins = options.timeout || 30;
  const agentList = agentFiles.map(a => `- ${a.name}: ${a.role}`).join('\n');
  const agentPaths = agentFiles.map(a => `- ${a.name}: ${a.path}`).join('\n');

  const prompt = `You are the Lead of the ${squad.name} squad.

## Mission
${squad.mission || 'Execute squad operations efficiently.'}

## Available Agents
${agentList}

## Agent Definition Files
${agentPaths}

## Your Role as Lead

1. **Assess the situation**: Check for pending work:
   - Run \`gh issue list --repo agents-squads/hq --label squad:${squad.name}\` for assigned issues
   - Check .agents/memory/${squad.dir}/ for squad state and pending tasks
   - Review recent activity with \`git log --oneline -10\`

2. **Delegate work using Task tool**: For each piece of work:
   - Use the Task tool with subagent_type="general-purpose"
   - Include the agent definition file path in the prompt
   - Spawn multiple Task agents IN PARALLEL when work is independent
   - Example: "Read ${agentFiles[0]?.path || 'agent.md'} and execute its instructions for [specific task]"

3. **Coordinate parallel execution**:
   - Independent tasks → spawn Task agents in parallel (single message, multiple tool calls)
   - Dependent tasks → run sequentially
   - Monitor progress and handle failures

4. **Report and update memory**:
   - Update .agents/memory/${squad.dir}/state.md with completed work
   - Log learnings to learnings.md
   - Create issues for follow-up work if needed

## Time Budget
You have ${timeoutMins} minutes. Prioritize high-impact work.

## Critical Instructions
- Use Task tool for delegation, NOT direct execution of agent work
- Spawn parallel Task agents when work is independent
- When done, type /exit to end the session
- Do NOT wait for user input - work autonomously

## Async Mode (CRITICAL)
This is ASYNC execution - Task agents must be fully autonomous:
- **Findings** → Create GitHub issues (gh issue create)
- **Code changes** → Create PRs (gh pr create)
- **Analysis results** → Write to .agents/outputs/ or memory files
- **NEVER wait for human review** - complete the work and move on
- **NEVER ask clarifying questions** - make reasonable decisions

Instruct each Task agent: "Work autonomously. Output findings to GitHub issues. Output code changes as PRs. Do not wait for review."

Begin by assessing pending work, then delegate to agents via Task tool.`;

  // Execute via Claude
  const claudeAvailable = await checkClaudeCliAvailable();
  if (!claudeAvailable) {
    writeLine(`  ${colors.yellow}Claude CLI not found${RESET}`);
    writeLine(`  ${colors.dim}Install: npm install -g @anthropic-ai/claude-code${RESET}`);
    return;
  }

  // Determine execution mode (foreground is default, background is opt-in)
  const isBackground = options.background === true && !options.watch;
  const isWatch = options.watch === true;
  const isForeground = !isBackground && !isWatch;

  const modeText = isBackground ? ' (background)' : isWatch ? ' (watch)' : '';
  writeLine(`  ${gradient('Launching')} lead session${modeText}...`);
  writeLine();

  try {
    // Find lead agent name from agent files or use default
    const leadAgentName = agentFiles.find(a => a.name.includes('lead'))?.name || `${squad.dir}-lead`;

    const result = await executeWithClaude(prompt, {
      verbose: options.verbose,
      timeoutMinutes: timeoutMins,
      foreground: options.foreground,
      background: options.background,
      watch: options.watch,
      useApi: options.useApi,
      effort: options.effort,
      skills: options.skills,
      trigger: options.trigger || 'manual',
      squadName: squad.dir,
      agentName: leadAgentName,
      model: options.model,
    });

    if (isForeground || isWatch) {
      writeLine();
      writeLine(`  ${icons.success} Lead session completed`);
    } else {
      writeLine(`  ${icons.success} Lead session launched in background`);
      writeLine(`  ${colors.dim}${result}${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}The lead will:${RESET}`);
      writeLine(`  ${colors.dim}  1. Assess pending work (issues, memory)${RESET}`);
      writeLine(`  ${colors.dim}  2. Spawn Task agents for parallel execution${RESET}`);
      writeLine(`  ${colors.dim}  3. Coordinate and report results${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}Monitor: squads workers${RESET}`);
    }
  } catch (error) {
    writeLine(`  ${icons.error} ${colors.red}Failed to launch: ${error}${RESET}`);
  }
}

async function runAgent(
  agentName: string,
  agentPath: string,
  squadName: string,
  options: RunOptions & { execute?: boolean }
): Promise<void> {
  const spinner = ora(`Running agent: ${agentName}`).start();
  const startMs = Date.now();
  const startTime = new Date(startMs).toISOString();
  const executionId = generateExecutionId();
  const taskType = detectTaskType(agentName);

  const definition = loadAgentDefinition(agentPath);

  if (options.dryRun) {
    spinner.info(`[DRY RUN] Would run ${agentName}`);
    // Show context that would be injected
    const dryRunContext = gatherSquadContext(squadName, agentName, { verbose: options.verbose });
    if (options.verbose) {
      writeLine(`  ${colors.dim}Agent definition:${RESET}`);
      writeLine(`  ${colors.dim}${definition.slice(0, 500)}...${RESET}`);
      if (dryRunContext) {
        writeLine();
        writeLine(`  ${colors.cyan}Context to inject (${Math.ceil(dryRunContext.length / 4)} tokens):${RESET}`);
        writeLine(`  ${colors.dim}${dryRunContext.slice(0, 800)}...${RESET}`);
      }
    }
    return;
  }

  // Pre-execution permission validation (Phase 3)
  const squadsDir = findSquadsDir();
  if (squadsDir) {
    const squadFilePath = join(squadsDir, squadName, 'SQUAD.md');
    if (existsSync(squadFilePath)) {
      const squadContent = readFileSync(squadFilePath, 'utf-8');
      const permContext = buildContextFromSquad(squadName, squadContent, agentName);

      // Build execution request from agent definition
      // For now, we validate MCP servers mentioned in the agent definition
      const mcpServers = extractMcpServersFromDefinition(definition);
      const execRequest: ExecutionRequest = {
        mcpServers
      };

      const permResult = validateExecution(permContext, execRequest);

      if (permResult.violations.length > 0) {
        spinner.stop();
        const violationLines = formatViolations(permResult);
        for (const line of violationLines) {
          writeLine(`  ${line}`);
        }
        writeLine();

        if (!permResult.allowed) {
          writeLine(`  ${colors.red}Execution blocked due to permission violations.${RESET}`);
          writeLine(`  ${colors.dim}Configure permissions in ${squadFilePath}${RESET}`);
          return;
        }
      }
    }
  }

  // Preflight gate check (quota, cooldown) via bridge API
  const preflight = await checkPreflightGates(squadName, agentName);

  if (!preflight.allowed) {
    spinner.stop();
    writeLine();
    writeLine(`  ${colors.red}${icons.error} Execution blocked by preflight gates${RESET}`);

    if (preflight.gates.quota && !preflight.gates.quota.ok) {
      writeLine(`  ${colors.dim}Quota: $${preflight.gates.quota.used.toFixed(2)}/$${preflight.gates.quota.limit}/mo limit exceeded${RESET}`);
    }

    if (preflight.gates.cooldown && !preflight.gates.cooldown.ok) {
      const elapsed = preflight.gates.cooldown.elapsed_sec;
      const minGap = preflight.gates.cooldown.min_gap_sec;
      writeLine(`  ${colors.dim}Cooldown: ${elapsed}s since last run (min: ${minGap}s)${RESET}`);
    }

    writeLine();
    return;
  }

  // Show preflight status in verbose mode
  if (options.verbose && Object.keys(preflight.gates).length > 0) {
    writeLine(`  ${colors.dim}Preflight: quota ${preflight.gates.quota?.ok ? '✓' : '✗'} cooldown ${preflight.gates.cooldown?.ok ? '✓' : '✗'}${RESET}`);
  }

  // Local cooldown check (when bridge is unavailable or has no execution history)
  // Skip for manual triggers - only enforce for scheduled/cron runs
  const isScheduledRun = options.trigger === 'scheduled' || options.trigger === 'smart';
  const bridgeHasNoHistory = preflight.gates.cooldown?.elapsed_sec === null;
  if (isScheduledRun && (!preflight.gates.cooldown || bridgeHasNoHistory)) {
    // Default cooldown: 6 hours for scheduled runs
    const defaultCooldownMs = 6 * 60 * 60 * 1000;
    const localCooldown = checkLocalCooldown(squadName, agentName, defaultCooldownMs);

    if (!localCooldown.ok) {
      spinner.stop();
      writeLine();
      writeLine(`  ${colors.yellow}${icons.warning} Skipping: cooldown not elapsed${RESET}`);
      writeLine(`  ${colors.dim}Last run: ${formatDuration(localCooldown.elapsedMs!)} ago (cooldown: ${formatDuration(localCooldown.cooldownMs)})${RESET}`);
      writeLine();
      return;
    }

    if (options.verbose) {
      writeLine(`  ${colors.dim}Local cooldown: ✓ (${formatDuration(localCooldown.elapsedMs || 0)} since last run)${RESET}`);
    }
  }

  // Log execution start
  logExecution({
    squadName,
    agentName,
    executionId,
    startTime,
    status: 'running',
    trigger: options.trigger || 'manual',
    taskType,
  });

  // Fetch learnings from bridge for prompt injection
  const learnings = await fetchLearnings(squadName);
  const learningContext = learnings.length > 0
    ? `\n## Learnings from Previous Runs\n${learnings.map(l => `- ${l.content}`).join('\n')}\n`
    : '';

  if (options.verbose && learnings.length > 0) {
    writeLine(`  ${colors.dim}Injecting ${learnings.length} learnings${RESET}`);
  }

  // Load approval/escalation instructions
  const approvalInstructions = loadApprovalInstructions();
  const approvalContext = approvalInstructions
    ? `\n${approvalInstructions}\n`
    : '';

  // Gather squad context (SQUAD.md, agent state, briefs)
  const squadContext = gatherSquadContext(squadName, agentName, { verbose: options.verbose });

  // Generate the Claude Code prompt with timeout awareness
  const timeoutMins = options.timeout || 30;
  const prompt = `Execute the ${agentName} agent from squad ${squadName}.

Read the agent definition at ${agentPath} and follow its instructions exactly.

The agent definition contains:
- Purpose/role
- Tools it can use (MCP servers, skills)
- Step-by-step instructions
- Expected output format

TOOL PREFERENCE: Always prefer CLI tools over MCP servers when both can accomplish the task:
- Use \`squads\` CLI for squad operations (run, memory, status, feedback)
- Use \`gh\` CLI for GitHub (issues, PRs, repos)
- Use \`git\` CLI for version control
- Use Bash for file operations, builds, tests
- Only use MCP tools when CLI cannot do it or MCP is significantly better
${squadContext}${learningContext}${approvalContext}
TIME LIMIT: You have ${timeoutMins} minutes. Work efficiently:
- Focus on the most important tasks first
- If a task is taking too long, move on and note it for next run
- Aim to complete within ${Math.floor(timeoutMins * 0.7)} minutes

After completion:

## 1. Update Memory (commit directly to main - auto-merged)
Update your memory files in .agents/memory/${squadName}/${agentName}/:
- state.md - Your working state
- learnings.md - What you learned
- executions.md - Log this execution

Use ISO timestamps (e.g., 2026-01-23T14:30:00Z).

\`\`\`bash
git add .agents/memory/${squadName}/${agentName}/
git commit -m "memory(${squadName}): ${agentName} state update

Co-Authored-By: Claude <noreply@anthropic.com>"
git push origin main
\`\`\`

## 2. Work Products (PR to correct repo - needs review)
If you created work products (code, content, reports), commit to the CORRECT repo:
- Code changes → squads-cli, engineering repos
- Web content → agents-squads-web
- Research/reports → intelligence, research repos
- Outreach drafts → customer repo

Create a PR in that repo for human review. Do NOT put work products in hq.

## 3. Summarize what was accomplished

CRITICAL: When you have completed your tasks OR reached the time limit:
- Type /exit immediately to end this session
- Do NOT wait for user input
- Do NOT ask follow-up questions
- Just /exit when done`;

  // Resolve provider with full chain:
  // 1. Agent config (from agent file frontmatter/header)
  // 2. CLI option (--provider flag)
  // 3. Squad default (from SQUAD.md providers.default)
  // 4. Fallback to 'anthropic'
  const agentProvider = parseAgentProvider(agentPath);
  const squad = loadSquad(squadName);
  const squadDefaultProvider = squad?.providers?.default;

  const provider = agentProvider || options.provider || squadDefaultProvider || 'anthropic';
  const isAnthropic = provider === 'anthropic';

  if (options.verbose && (agentProvider || squadDefaultProvider)) {
    writeLine(`  ${colors.dim}Provider resolution:${RESET}`);
    if (agentProvider) writeLine(`    ${colors.dim}Agent: ${agentProvider}${RESET}`);
    if (options.provider) writeLine(`    ${colors.dim}CLI: ${options.provider}${RESET}`);
    if (squadDefaultProvider) writeLine(`    ${colors.dim}Squad: ${squadDefaultProvider}${RESET}`);
    writeLine(`    ${colors.dim}→ Using: ${provider}${RESET}`);
  }

  // Check CLI availability
  const cliAvailable = isAnthropic
    ? await checkClaudeCliAvailable()
    : isProviderCLIAvailable(provider);

  if (options.execute && cliAvailable) {
    const cliConfig = getCLIConfig(provider);
    const cliName = cliConfig?.displayName || provider;

    // Determine execution mode (foreground is default, background is opt-in)
    const isBackground = options.background === true && !options.watch;
    const isWatch = options.watch === true;
    const isForeground = !isBackground && !isWatch;

    spinner.text = isBackground
      ? `Launching ${agentName} with ${cliName} in background...`
      : isWatch
        ? `Starting ${agentName} with ${cliName} (watch mode)...`
        : `Running ${agentName} with ${cliName}...`;

    try {
      let result: string;

      if (isAnthropic) {
        // Use full Claude execution with MCP, permissions, etc.
        result = await executeWithClaude(prompt, {
          verbose: options.verbose,
          timeoutMinutes: options.timeout || 30,
          foreground: options.foreground,
          background: options.background,
          watch: options.watch,
          useApi: options.useApi,
          effort: options.effort,
          skills: options.skills,
          trigger: options.trigger || 'manual',
          squadName,
          agentName,
          model: options.model,
        });
      } else {
        // Use simplified provider execution
        result = await executeWithProvider(provider, prompt, {
          verbose: options.verbose,
          foreground: !isBackground,
          squadName,
          agentName,
        });
      }

      if (isForeground || isWatch) {
        spinner.succeed(`Agent ${agentName} completed (${cliName})`);
      } else {
        spinner.succeed(`Agent ${agentName} launched in background (${cliName})`);
        writeLine(`  ${colors.dim}${result}${RESET}`);
        writeLine();
        writeLine(`  ${colors.dim}Monitor:${RESET} squads workers`);
        writeLine(`  ${colors.dim}Memory:${RESET}  squads memory show ${squadName}`);
      }
    } catch (error) {
      spinner.fail(`Agent ${agentName} failed to launch`);
      updateExecutionStatus(squadName, agentName, executionId, 'failed', {
        error: String(error),
        durationMs: Date.now() - startMs,
      });
      writeLine(`  ${colors.red}${String(error)}${RESET}`);
    }
  } else {
    // Show instructions for manual execution
    spinner.succeed(`Agent ${agentName} ready`);
    writeLine(`  ${colors.dim}Execution logged: ${startTime}${RESET}`);

    if (!cliAvailable) {
      const cliConfig = getCLIConfig(provider);
      writeLine();
      writeLine(`  ${colors.yellow}${cliConfig?.command || provider} CLI not found${RESET}`);
      writeLine(`  ${colors.dim}Install: ${cliConfig?.install || 'squads providers'}${RESET}`);
    }

    writeLine();
    writeLine(`  ${colors.dim}To launch as background task:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET} -a ${colors.cyan}${agentName}${RESET} --execute`);
    if (provider !== 'anthropic') {
      writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET} -a ${colors.cyan}${agentName}${RESET} --execute --provider=${provider}`);
    }
    writeLine();
    writeLine(`  ${colors.dim}Or run interactively:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} Run the ${colors.cyan}${agentName}${RESET} agent from ${agentPath}`);
  }
}

async function checkClaudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn('which', ['claude'], { stdio: 'pipe' });
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });
}

interface ExecuteWithClaudeOptions {
  verbose?: boolean;
  timeoutMinutes?: number;
  foreground?: boolean; // Deprecated, now default
  background?: boolean; // Opt-in background mode
  watch?: boolean; // Background but tail log
  useApi?: boolean;
  effort?: EffortLevel;
  skills?: string[];
  trigger?: ExecutionContext['trigger'];
  squadName: string;
  agentName: string;
  model?: 'opus' | 'sonnet' | 'haiku'; // Route by task difficulty
}

async function executeWithClaude(
  prompt: string,
  options: ExecuteWithClaudeOptions
): Promise<string> {
  const {
    verbose,
    timeoutMinutes: _timeoutMinutes = 30,
    foreground,
    background,
    watch,
    useApi,
    effort,
    skills,
    trigger = 'manual',
    squadName,
    agentName,
    model,
  } = options;

  // Determine execution mode:
  // - Default is foreground (visible output)
  // - --background (-b) runs detached
  // - --watch (-w) runs detached but tails log
  // - --foreground (-f) is deprecated (now default)
  const runInBackground = background === true && !watch;
  const runInWatch = watch === true;
  const runInForeground = !runInBackground && !runInWatch;

  // Track start time for status updates
  const startMs = Date.now();

  // Ensure the project is trusted (prevents workspace trust dialog)
  const projectRoot = getProjectRoot();
  ensureProjectTrusted(projectRoot);

  // Load squad for context-based MCP config resolution
  const squad = squadName !== 'unknown' ? loadSquad(squadName) : null;

  // Select MCP config based on squad context (dynamic) or legacy mapping (fallback)
  const mcpConfigPath = selectMcpConfig(squadName, squad);

  // Detect task type for telemetry and model routing
  const taskType = detectTaskType(agentName);

  // Resolve model: explicit --model > squad context routing > undefined (provider default)
  const resolvedModel = resolveModel(model, squad, taskType);

  // Detect provider from model (defaults to anthropic if no model specified)
  const detectedProvider = resolvedModel ? detectProviderFromModel(resolvedModel) : 'anthropic';

  // For non-Anthropic providers, delegate to executeWithProvider
  if (detectedProvider !== 'anthropic' && detectedProvider !== 'unknown') {
    if (verbose) {
      const source = model ? 'explicit' : 'auto-routed';
      writeLine(`  ${colors.dim}Model: ${resolvedModel} (${source})${RESET}`);
      writeLine(`  ${colors.dim}Provider: ${detectedProvider}${RESET}`);
    }

    return executeWithProvider(detectedProvider, prompt, {
      verbose,
      foreground,
      cwd: getProjectRoot(),
      squadName,
      agentName,
    });
  }

  // For Anthropic, convert full model name to Claude Code alias
  const claudeModelAlias = resolvedModel ? getClaudeModelAlias(resolvedModel) : undefined;

  // Build execution context for telemetry
  const execContext: ExecutionContext = {
    squad: squadName,
    agent: agentName,
    taskType,
    trigger,
    executionId: generateExecutionId(),
  };

  // Build env: remove ANTHROPIC_API_KEY unless --use-api is set
  // This ensures Claude uses OAuth subscription by default
  const { ANTHROPIC_API_KEY: _apiKey, ...envWithoutApiKey } = process.env;
  const spawnEnv = useApi ? process.env : envWithoutApiKey;

  // Escape prompt for shell
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Register context with bridge for telemetry (non-blocking)
  await registerContextWithBridge(execContext);

  // Foreground mode: run Claude directly in the terminal (default)
  if (runInForeground) {
    if (verbose) {
      writeLine(`  ${colors.dim}Project: ${projectRoot}${RESET}`);
      writeLine(`  ${colors.dim}Mode: foreground${RESET}`);
      writeLine(`  ${colors.dim}Auth: ${useApi ? 'API credits' : 'subscription'}${RESET}`);
      writeLine(`  ${colors.dim}Execution: ${execContext.executionId}${RESET}`);
      writeLine(`  ${colors.dim}Task type: ${execContext.taskType}${RESET}`);
      writeLine(`  ${colors.dim}Trigger: ${execContext.trigger}${RESET}`);
      if (effort) {
        writeLine(`  ${colors.dim}Effort: ${effort}${RESET}`);
      }
      if (skills && skills.length > 0) {
        writeLine(`  ${colors.dim}Skills: ${skills.join(', ')}${RESET}`);
      }
      if (resolvedModel || claudeModelAlias) {
        const source = model ? 'explicit' : 'auto-routed';
        const displayModel = resolvedModel || claudeModelAlias;
        writeLine(`  ${colors.dim}Model: ${displayModel} (${source})${RESET}`);
      }
    }

    // Build args array with optional model flag (Claude Code only accepts aliases)
    const claudeArgs = [
      '--dangerously-skip-permissions',
      '--mcp-config', mcpConfigPath,
      ...(claudeModelAlias ? ['--model', claudeModelAlias] : []),
      '--',
      prompt
    ];

    return new Promise((resolve, reject) => {
      const claude = spawn('claude', claudeArgs, {
        stdio: 'inherit',
        shell: true,  // Required for Node 22+ symlink resolution
        cwd: projectRoot,
        env: {
          ...spawnEnv,
          // Telemetry context for per-agent cost tracking
          SQUADS_SQUAD: execContext.squad,
          SQUADS_AGENT: execContext.agent,
          SQUADS_TASK_TYPE: execContext.taskType,
          SQUADS_TRIGGER: execContext.trigger,
          SQUADS_EXECUTION_ID: execContext.executionId,
          // Bridge API for approvals and escalations
          BRIDGE_API: process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088',
          // OTel resource attributes for telemetry pipeline
          OTEL_RESOURCE_ATTRIBUTES: `squads.squad=${execContext.squad},squads.agent=${execContext.agent},squads.task_type=${execContext.taskType},squads.trigger=${execContext.trigger},squads.execution_id=${execContext.executionId}`,
          // Claude-specific options
          ...(effort && { CLAUDE_EFFORT: effort }),
          ...(skills && skills.length > 0 && { CLAUDE_SKILLS: skills.join(',') }),
        },
      });

      claude.on('close', async (code) => {
        const durationMs = Date.now() - startMs;

        if (code === 0) {
          // Update execution status to completed
          updateExecutionStatus(squadName, agentName, execContext.executionId, 'completed', {
            outcome: 'Session completed successfully',
            durationMs,
          });

          // Auto-commit any changes made by the agent
          const commitResult = await autoCommitAgentWork(squadName, agentName, execContext.executionId);
          if (commitResult.committed) {
            writeLine();
            writeLine(`  ${colors.green}Auto-committed agent work${RESET}`);
          }

          resolve('Session completed');
        } else {
          // Update execution status to failed
          updateExecutionStatus(squadName, agentName, execContext.executionId, 'failed', {
            error: `Claude exited with code ${code}`,
            durationMs,
          });
          reject(new Error(`Claude exited with code ${code}`));
        }
      });

      claude.on('error', (err) => {
        const durationMs = Date.now() - startMs;
        updateExecutionStatus(squadName, agentName, execContext.executionId, 'failed', {
          error: String(err),
          durationMs,
        });
        reject(err);
      });
    });
  }

  // Watch mode: run in background but tail the log
  if (runInWatch) {
    const timestamp = Date.now();
    const logDir = join(projectRoot, '.agents', 'logs', squadName);
    const logFile = join(logDir, `${agentName}-${timestamp}.log`);
    const pidFile = join(logDir, `${agentName}-${timestamp}.pid`);

    // Ensure log directory exists
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    if (verbose) {
      writeLine(`  ${colors.dim}Project: ${projectRoot}${RESET}`);
      writeLine(`  ${colors.dim}Mode: watch (background + tail)${RESET}`);
      writeLine(`  ${colors.dim}Log: ${logFile}${RESET}`);
    }

    // Build environment exports
    const envExports = [
      `export SQUADS_SQUAD='${execContext.squad}'`,
      `export SQUADS_AGENT='${execContext.agent}'`,
      `export SQUADS_TASK_TYPE='${execContext.taskType}'`,
      `export SQUADS_TRIGGER='${execContext.trigger}'`,
      `export SQUADS_EXECUTION_ID='${execContext.executionId}'`,
      `export BRIDGE_API='${process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088'}'`,
    ].join('; ');

    const modelFlag = claudeModelAlias ? `--model ${claudeModelAlias}` : '';
    const shellScript = `cd '${projectRoot}'; ${envExports}; exec claude --print --dangerously-skip-permissions ${modelFlag} -- '${escapedPrompt}' > '${logFile}' 2>&1`;
    const wrapperScript = `echo $$ > '${pidFile}'; ${shellScript}`;

    // Spawn background process
    const child = spawn('sh', ['-c', wrapperScript], {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      env: spawnEnv,
    });
    child.unref();

    // Wait a moment for the log file to be created
    await new Promise(resolve => setTimeout(resolve, 500));

    // Tail the log file
    writeLine(`  ${colors.dim}Tailing log (Ctrl+C to stop watching, agent continues)...${RESET}`);
    writeLine();

    const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });

    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
      tail.kill();
      writeLine();
      writeLine(`  ${colors.dim}Stopped watching. Agent continues in background.${RESET}`);
      writeLine(`  ${colors.dim}Resume: tail -f ${logFile}${RESET}`);
      process.exit(0);
    });

    // Wait for tail to exit (which won't happen unless killed)
    return new Promise((resolve) => {
      tail.on('close', () => {
        resolve(`Agent running in background. Log: ${logFile}`);
      });
    });
  }

  // Background mode (--background): run detached with log file
  // This is now opt-in behavior, not default
  const timestamp = Date.now();
  const logDir = join(projectRoot, '.agents', 'logs', squadName);
  const logFile = join(logDir, `${agentName}-${timestamp}.log`);
  const pidFile = join(logDir, `${agentName}-${timestamp}.pid`);

  // Ensure log directory exists
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  if (verbose) {
    writeLine(`  ${colors.dim}Project: ${projectRoot}${RESET}`);
    writeLine(`  ${colors.dim}Log: ${logFile}${RESET}`);
    writeLine(`  ${colors.dim}MCP config: ${mcpConfigPath}${RESET}`);
    writeLine(`  ${colors.dim}Auth: ${useApi ? 'API credits' : 'subscription'}${RESET}`);
    writeLine(`  ${colors.dim}Execution: ${execContext.executionId}${RESET}`);
    writeLine(`  ${colors.dim}Task type: ${execContext.taskType}${RESET}`);
    writeLine(`  ${colors.dim}Trigger: ${execContext.trigger}${RESET}`);
    if (effort) {
      writeLine(`  ${colors.dim}Effort: ${effort}${RESET}`);
    }
    if (skills && skills.length > 0) {
      writeLine(`  ${colors.dim}Skills: ${skills.join(', ')}${RESET}`);
    }
    if (resolvedModel || claudeModelAlias) {
      const source = model ? 'explicit' : 'auto-routed';
      const displayModel = resolvedModel || claudeModelAlias;
      writeLine(`  ${colors.dim}Model: ${displayModel} (${source})${RESET}`);
    }
  }

  // Build Claude command with all permissions bypassed for autonomous execution
  // --print ensures non-interactive mode (exits after completion, no REPL)
  // Use shell 'exec' to replace shell with claude while keeping file redirect
  // This ensures output goes to log even after parent exits
  const envExports = [
    `export SQUADS_SQUAD='${execContext.squad}'`,
    `export SQUADS_AGENT='${execContext.agent}'`,
    `export SQUADS_TASK_TYPE='${execContext.taskType}'`,
    `export SQUADS_TRIGGER='${execContext.trigger}'`,
    `export SQUADS_EXECUTION_ID='${execContext.executionId}'`,
    `export BRIDGE_API='${process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088'}'`,
    `export OTEL_RESOURCE_ATTRIBUTES='squads.squad=${execContext.squad},squads.agent=${execContext.agent},squads.task_type=${execContext.taskType},squads.trigger=${execContext.trigger},squads.execution_id=${execContext.executionId}'`,
    ...(effort ? [`export CLAUDE_EFFORT='${effort}'`] : []),
    ...(skills && skills.length > 0 ? [`export CLAUDE_SKILLS='${skills.join(',')}'`] : []),
  ].join('; ');

  // Build shell command:
  // 1. cd to project root
  // 2. export env vars
  // 3. exec claude (replaces shell, keeps file descriptors)
  // The redirect to logfile happens before exec, so it persists
  // Note: MCP config removed - causes blocking issues in background execution
  const modelFlag = claudeModelAlias ? `--model ${claudeModelAlias}` : '';
  const shellScript = `cd '${projectRoot}'; ${envExports}; exec claude --print --dangerously-skip-permissions ${modelFlag} -- '${escapedPrompt}' > '${logFile}' 2>&1`;


  // Get child PID by using a wrapper that writes PID then execs
  const wrapperScript = `echo $$ > '${pidFile}'; ${shellScript}`;

  const child = spawn('sh', ['-c', wrapperScript], {
    cwd: projectRoot,
    detached: true,
    stdio: 'ignore',
    env: spawnEnv,
  });

  child.unref();

  if (verbose) {
    writeLine(`  ${colors.dim}Monitor: tail -f ${logFile}${RESET}`);
  }

  return `Log: ${logFile}. Monitor: tail -f ${logFile}`;
}

/**
 * Execute agent with a non-Anthropic LLM CLI provider.
 *
 * Supports: google (gemini), openai (codex), mistral (vibe), xai (grok), aider, ollama
 *
 * Unlike executeWithClaude which has full session management,
 * other CLIs run in simpler non-interactive mode.
 */
async function executeWithProvider(
  provider: string,
  prompt: string,
  options: {
    verbose?: boolean;
    foreground?: boolean;
    cwd?: string;
    squadName?: string;
    agentName?: string;
  }
): Promise<string> {
  const cliConfig = getCLIConfig(provider);

  if (!cliConfig) {
    throw new Error(`Unknown provider: ${provider}. Run 'squads providers' to see available providers.`);
  }

  if (!isProviderCLIAvailable(provider)) {
    throw new Error(`CLI '${cliConfig.command}' not found. Install: ${cliConfig.install}`);
  }

  const projectRoot = options.cwd || getProjectRoot();
  const args = cliConfig.buildArgs(prompt);

  if (options.verbose) {
    writeLine(`  ${colors.dim}Provider: ${cliConfig.displayName}${RESET}`);
    writeLine(`  ${colors.dim}Command: ${cliConfig.command} ${args.join(' ').slice(0, 50)}...${RESET}`);
    writeLine(`  ${colors.dim}CWD: ${projectRoot}${RESET}`);
  }

  // Foreground mode: run directly in terminal
  if (options.foreground) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cliConfig.command, args, {
        stdio: 'inherit',
        cwd: projectRoot,
        env: {
          ...process.env,
          SQUADS_SQUAD: options.squadName || 'unknown',
          SQUADS_AGENT: options.agentName || 'unknown',
          SQUADS_PROVIDER: provider,
        },
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve('Session completed');
        } else {
          reject(new Error(`${cliConfig.command} exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  // Background mode: run via tmux
  const sessionName = `squads-${options.squadName || 'run'}-${options.agentName || 'agent'}-${Date.now()}`;
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const shellCmd = `cd '${projectRoot}' && ${cliConfig.command} ${cliConfig.buildArgs(escapedPrompt).map(a => `'${a}'`).join(' ')}; tmux kill-session -t ${sessionName} 2>/dev/null`;

  const tmux = spawn('tmux', [
    'new-session',
    '-d',
    '-s', sessionName,
    '-x', '200',
    '-y', '50',
    '/bin/sh', '-c', shellCmd
  ], {
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      SQUADS_SQUAD: options.squadName || 'unknown',
      SQUADS_AGENT: options.agentName || 'unknown',
      SQUADS_PROVIDER: provider,
    },
  });

  tmux.unref();

  if (options.verbose) {
    writeLine(`  ${colors.dim}Session: ${sessionName}${RESET}`);
  }

  return `tmux session: ${sessionName}. Attach: tmux attach -t ${sessionName}`;
}

export async function runSquadCommand(
  squadName: string,
  options: RunOptions
): Promise<void> {
  return runCommand(squadName, options);
}
