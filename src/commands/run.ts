import ora from 'ora';
import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, unlinkSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  loadAgentDefinition,
  parseAgentProvider,
  listSquads,
  findSimilarSquads,
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
import { parseCooldown } from '../lib/cron.js';
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
import { loadSession, isLoggedIn } from '../lib/auth.js';
import { getApiUrl, getBridgeUrl } from '../lib/env-config.js';
import { runConversation, saveTranscript, type ConversationOptions } from '../lib/workflow.js';
import { reportExecutionStart, reportConversationResult, pushCognitionSignal } from '../lib/api-client.js';
import { getBotGitEnv, getBotPushUrl, getBotGhEnv, getCoAuthorTrailer } from '../lib/github.js';
import {
  type LoopState,
  loadLoopState,
  saveLoopState,
  getSquadRepos,
  scoreSquads,
  checkCooldown,
  classifyRunOutcome,
  pushMemorySignals,
  slackNotify,
  computePhases,
  scoreSquadsForPhase,
} from '../lib/squad-loop.js';
import {
  loadCognitionState,
  saveCognitionState,
  seedBeliefsIfEmpty,
  runCognitionCycle,

} from '../lib/cognition.js';
import {
  type AgentFrontmatter,
  type ContextRole,
  parseAgentFrontmatter,
  extractMcpServersFromDefinition,
  loadSystemProtocol,
  gatherSquadContext,
} from '../lib/run-context.js';
import { classifyAgent } from '../lib/conversation.js';

// ── Operational constants (no magic numbers) ──────────────────────────
const CLOUD_POLL_INTERVAL_MS = 3000;
const CLOUD_POLL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max poll
const DEFAULT_LEARNINGS_LIMIT = 5;
const EXECUTION_EVENT_TIMEOUT_MS = 5000;
const VERIFICATION_STATE_MAX_CHARS = 2000;
const VERIFICATION_EXEC_TIMEOUT_MS = 30000;
const DRYRUN_DEF_MAX_CHARS = 500;
const DRYRUN_CONTEXT_MAX_CHARS = 800;
const DEFAULT_SCHEDULED_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_TIMEOUT_MINUTES = 30;
const SOFT_DEADLINE_RATIO = 0.7;
const LOG_FILE_INIT_DELAY_MS = 500;
const VERBOSE_COMMAND_MAX_CHARS = 50;

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
  model?: string; // Model to use (Claude aliases or full model IDs like gemini-2.5-flash)
  verify?: boolean; // Post-execution verification (default true, --no-verify to skip)
  cloud?: boolean; // Dispatch to cloud worker via API instead of local execution
  conversation?: boolean; // Run squad as multi-agent conversation (default for squad runs)
  task?: string; // Founder directive — replaces lead briefing in conversation mode
  maxTurns?: number; // Max conversation turns (default: 20)
  costCeiling?: number; // Cost ceiling in USD (default: 25)
  interval?: number | string; // Autopilot: minutes between cycles
  maxParallel?: number | string; // Autopilot: max parallel squad loops
  budget?: number | string; // Autopilot: daily budget cap ($)
  once?: boolean; // Autopilot: run one cycle then exit
  phased?: boolean; // Autopilot: use dependency-based phase ordering
  eval?: boolean; // Post-run COO evaluation (default: true, --no-eval to skip)
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
 * Register execution context with the API for telemetry
 * This allows the API to tag incoming OTel data with correct squad/agent info
 */
async function registerContextWithBridge(ctx: ExecutionContext): Promise<boolean> {
  const bridgeUrl = getBridgeUrl();

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
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      // Non-fatal - continue even if bridge is unavailable
      return false;
    }
    return true;
  } catch (e) {
    writeLine(`  ${colors.dim}warn: bridge registration failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
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
  const bridgeUrl = getBridgeUrl();

  try {
    const response = await fetch(`${bridgeUrl}/api/execution/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ squad, agent }),
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      // Fail open if bridge returns error
      return { allowed: true, gates: {} };
    }

    return await response.json() as PreflightResult;
  } catch (e) {
    writeLine(`  ${colors.dim}warn: preflight gate check failed (allowing execution): ${e instanceof Error ? e.message : String(e)}${RESET}`);
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

async function fetchLearnings(squad: string, limit = DEFAULT_LEARNINGS_LIMIT): Promise<Learning[]> {
  const bridgeUrl = getBridgeUrl();

  try {
    const response = await fetch(
      `${bridgeUrl}/api/learnings/relevant?squad=${encodeURIComponent(squad)}&limit=${limit}`,
      { signal: AbortSignal.timeout(3000) }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as { learnings: Learning[] };
    return data.learnings || [];
  } catch (e) {
    writeLine(`  ${colors.dim}warn: learnings fetch failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    return [];
  }
}

// loadApprovalInstructions, loadPostExecution → moved to src/lib/run-context.ts

// gatherSquadContext → moved to src/lib/run-context.ts

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
  } catch (e) {
    // Don't fail execution if we can't update config — the trust dialog will just appear
    writeLine(`  ${colors.dim}warn: config update failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
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
 * Commits as the Agents Squads bot (if configured), pushes with bot token.
 * Falls back to user's git identity if bot not configured.
 */
async function autoCommitAgentWork(
  squadName: string,
  agentName: string,
  executionId: string,
  provider?: string,
): Promise<{ committed: boolean; message?: string; error?: string }> {
  const { execSync } = await import('child_process');
  const { detectGitHubRepo } = await import('../lib/github.js');
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

    // Get bot identity for commits
    const botEnv = await getBotGitEnv();
    const execOpts = {
      cwd: projectRoot,
      env: { ...process.env, ...botEnv },
    };

    // Stage all changes (agent work should be committed)
    execSync('git add -A', execOpts);

    // Build commit message with provider-specific co-author
    // Write to temp file to avoid shell injection via squad/agent names
    const shortExecId = executionId.slice(0, 12);
    const coAuthor = getCoAuthorTrailer(provider || 'claude');
    const msgFile = join(projectRoot, '.git', 'SQUADS_COMMIT_MSG');
    writeFileSync(msgFile, `feat(${squadName}/${agentName}): execution ${shortExecId}\n\n${coAuthor}\n`);

    // Commit using --file to avoid shell interpolation
    try {
      execSync(`git commit --file "${msgFile}"`, execOpts);
    } finally {
      try { unlinkSync(msgFile); } catch { /* ignore */ }
    }

    // Push to origin using bot token
    try {
      const { spawnSync } = await import('child_process');
      const repo = detectGitHubRepo(projectRoot);
      // Validate repo format (org/name) to prevent injection
      if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
        const pushUrl = await getBotPushUrl(repo);
        if (pushUrl) {
          // Use spawnSync with args array to avoid shell injection
          spawnSync('git', ['push', pushUrl, 'HEAD'], { ...execOpts, stdio: 'pipe' });
        } else {
          spawnSync('git', ['push', 'origin', 'HEAD'], { ...execOpts, stdio: 'pipe' });
        }
      } else {
        spawnSync('git', ['push', 'origin', 'HEAD'], { ...execOpts, stdio: 'pipe' });
      }
    } catch (e) {
      writeLine(`  ${colors.dim}warn: git push failed (commit is still local): ${e instanceof Error ? e.message : String(e)}${RESET}`);
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

// extractMcpServersFromDefinition, AgentFrontmatter, parseAgentFrontmatter → moved to src/lib/run-context.ts

/**
 * Emit an execution event to the API for tracking and routing.
 * Non-blocking and fail-safe — falls back to file if API unavailable.
 */
async function emitExecutionEvent(
  eventType: 'agent.completed' | 'agent.failed',
  data: { squad: string; agent: string; executionId: string; error?: string }
): Promise<void> {
  const apiUrl = getApiUrl();

  if (apiUrl) {
    try {
      await fetch(`${apiUrl}/events/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'scheduler',
          event_type: eventType,
          data: {
            squad: data.squad,
            agent: data.agent,
            execution_id: data.executionId,
            ...(data.error ? { error: data.error } : {}),
          },
        }),
        signal: AbortSignal.timeout(EXECUTION_EVENT_TIMEOUT_MS),
      });
      return;
    } catch {
      // API unavailable — fall through to file-based event recording
    }
  }

  // Fallback: write event to memory file
  try {
    const memDir = findMemoryDir();
    if (!memDir) return;

    const eventsDir = join(memDir, data.squad, data.agent);
    if (!existsSync(eventsDir)) {
      mkdirSync(eventsDir, { recursive: true });
    }

    const eventsPath = join(eventsDir, 'events.md');
    const timestamp = new Date().toISOString();
    const entry = `\n## ${timestamp}: ${eventType}\n- execution_id: ${data.executionId}\n${data.error ? `- error: ${data.error}\n` : ''}`;

    let existing = '';
    if (existsSync(eventsPath)) {
      existing = readFileSync(eventsPath, 'utf-8');
    }
    writeFileSync(eventsPath, existing + entry);
  } catch {
    // Truly fail-safe — never block execution
  }
}

/**
 * Verify execution against acceptance criteria using a lightweight model.
 * Returns pass/fail with reason. Used by the Ralph verification loop.
 */
async function verifyExecution(
  squadName: string,
  agentName: string,
  criteria: string,
  options: { verbose?: boolean } = {}
): Promise<{ passed: boolean; reason: string }> {
  const { execSync } = await import('child_process');
  const projectRoot = getProjectRoot();

  // Gather evidence: state file + recent commits
  let stateContent = '';
  const memDir = findMemoryDir();
  if (memDir) {
    const statePath = join(memDir, squadName, agentName, 'state.md');
    if (existsSync(statePath)) {
      stateContent = readFileSync(statePath, 'utf-8').slice(0, VERIFICATION_STATE_MAX_CHARS);
    }
  }

  let recentCommits = '';
  try {
    recentCommits = execSync('git log --oneline -5 --no-color', {
      encoding: 'utf-8',
      cwd: projectRoot,
    }).trim();
  } catch (e) {
    if (options.verbose) writeLine(`  ${colors.dim}warn: git log failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    recentCommits = '(no commits found)';
  }

  const verifyPrompt = `You are verifying whether an agent completed its task successfully.

Agent: ${squadName}/${agentName}

## Acceptance Criteria
${criteria}

## Evidence

### Agent State File
${stateContent || '(empty or not found)'}

### Recent Git Commits
${recentCommits}

## Instructions
Evaluate whether the acceptance criteria are met based on the evidence.
Respond with EXACTLY one line:
PASS: <brief reason>
or
FAIL: <brief reason>`;

  try {
    const escapedPrompt = verifyPrompt.replace(/'/g, "'\\''");
    const result = execSync(
      `unset CLAUDECODE; claude --print --model haiku -- '${escapedPrompt}'`,
      { encoding: 'utf-8', cwd: projectRoot, timeout: VERIFICATION_EXEC_TIMEOUT_MS, shell: '/bin/sh' }
    ).trim();

    if (options.verbose) {
      writeLine(`  ${colors.dim}Verification: ${result}${RESET}`);
    }

    if (result.startsWith('PASS')) {
      return { passed: true, reason: result.replace(/^PASS:\s*/, '') };
    }
    return { passed: false, reason: result.replace(/^FAIL:\s*/, '') };
  } catch (error) {
    if (options.verbose) {
      writeLine(`  ${colors.dim}Verification error (defaulting to PASS): ${error}${RESET}`);
    }
    return { passed: true, reason: 'Verification unavailable — defaulting to pass' };
  }
}

// ── Cloud Dispatch ─────────────────────────────────────────────────────

/**
 * Dispatch agent execution to cloud worker via API.
 * Posts to /agent-dispatch, then polls /agent-executions for status.
 */
async function runCloudDispatch(
  squadName: string,
  agentName: string,
  options: RunOptions
): Promise<void> {
  const apiUrl = getApiUrl();

  if (!apiUrl) {
    writeLine(`  ${colors.red}${icons.error} API URL not configured${RESET}`);
    writeLine(`  ${colors.dim}Run: squads config use staging  (or set SQUADS_API_URL)${RESET}`);
    process.exit(1);
  }

  // Require auth session
  if (!isLoggedIn()) {
    writeLine(`  ${colors.red}${icons.error} Not logged in${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads login\` to authenticate before using --cloud${RESET}`);
    process.exit(1);
  }

  const session = loadSession();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Use access token if available, otherwise use API key
  if (session?.accessToken) {
    headers['Authorization'] = `Bearer ${session.accessToken}`;
  }

  const apiKey = process.env.SQUADS_PLATFORM_API_TOKEN || process.env.SCHEDULER_API_KEY;
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const spinner = ora(`Dispatching ${squadName}/${agentName} to cloud...`).start();

  try {
    // 1. Create dispatch request
    const dispatchRes = await fetch(`${apiUrl}/agent-dispatch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        squad: squadName,
        agent: agentName,
        trigger_type: 'manual',
        trigger_data: {
          source: 'cli',
          cloud: true,
          model: options.model,
          provider: options.provider,
          effort: options.effort,
        },
      }),
    });

    if (!dispatchRes.ok) {
      const error = await dispatchRes.text();
      spinner.fail(`Dispatch failed: ${dispatchRes.status}`);
      writeLine(`  ${colors.dim}${error}${RESET}`);
      process.exit(1);
    }

    const dispatch = await dispatchRes.json() as { dispatch_id: number; status: string };
    spinner.succeed(`Dispatched to cloud`);

    writeLine();
    writeLine(`  ${colors.cyan}Dispatch ID${RESET}  ${dispatch.dispatch_id}`);
    writeLine(`  ${colors.cyan}Squad${RESET}        ${squadName}`);
    writeLine(`  ${colors.cyan}Agent${RESET}        ${agentName}`);
    writeLine();

    // 2. Poll for execution status
    const pollSpinner = ora('Waiting for execution to start...').start();
    const pollStart = Date.now();
    let executionId: string | null = null;
    let lastStatus = '';

    while (Date.now() - pollStart < CLOUD_POLL_TIMEOUT_MS) {
      try {
        const execRes = await fetch(
          `${apiUrl}/agent-executions?squad=${encodeURIComponent(squadName)}&agent=${encodeURIComponent(agentName)}&limit=1`,
          { headers },
        );

        if (execRes.ok) {
          const executions = await execRes.json() as Array<{
            execution_id: string;
            status: string;
            summary?: string;
            error?: string;
            duration_seconds?: number;
            cost_usd?: number;
          }>;

          if (executions.length > 0) {
            const exec = executions[0];

            // Only track executions started after our dispatch
            if (!executionId && exec.status === 'running') {
              executionId = exec.execution_id;
              pollSpinner.text = `Running (${exec.execution_id})`;
            }

            if (executionId && exec.execution_id === executionId) {
              if (exec.status !== lastStatus) {
                lastStatus = exec.status;
                pollSpinner.text = `Status: ${exec.status}`;
              }

              if (exec.status === 'completed') {
                pollSpinner.succeed('Execution completed');
                writeLine();
                writeLine(`  ${colors.cyan}Execution${RESET}    ${exec.execution_id}`);
                if (exec.summary) {
                  writeLine(`  ${colors.cyan}Summary${RESET}      ${exec.summary}`);
                }
                if (exec.duration_seconds) {
                  writeLine(`  ${colors.cyan}Duration${RESET}     ${Math.round(exec.duration_seconds)}s`);
                }
                if (exec.cost_usd) {
                  writeLine(`  ${colors.cyan}Cost${RESET}         $${exec.cost_usd.toFixed(4)}`);
                }
                writeLine();
                return;
              }

              if (exec.status === 'failed') {
                pollSpinner.fail('Execution failed');
                writeLine();
                if (exec.error) {
                  writeLine(`  ${colors.red}Error: ${exec.error}${RESET}`);
                }
                writeLine();
                process.exit(1);
              }

              if (exec.status === 'cancelled') {
                pollSpinner.warn('Execution cancelled');
                return;
              }
            }
          }
        }
      } catch (e) {
        if (options.verbose) writeLine(`  ${colors.dim}warn: cloud poll failed (retrying): ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }

      await new Promise(resolve => setTimeout(resolve, CLOUD_POLL_INTERVAL_MS));
    }

    pollSpinner.warn('Poll timeout — execution may still be running');
    writeLine(`  ${colors.dim}Check status: squads trigger status${RESET}`);
    if (executionId) {
      writeLine(`  ${colors.dim}Execution ID: ${executionId}${RESET}`);
    }
  } catch (error) {
    spinner.fail('Cloud dispatch failed');
    writeLine(`  ${colors.red}${error instanceof Error ? error.message : String(error)}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Check your network and SQUADS_API_URL setting${RESET}`);
    process.exit(1);
  }
}

export async function runCommand(
  target: string | null,
  options: RunOptions
): Promise<void> {
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  // Execution is now the default behavior (no --execute flag needed)
  // --dry-run disables execution
  if (!options.dryRun && options.execute === undefined) {
    options.execute = true;
  }

  // MODE 1: Autopilot — no target means run all squads continuously
  if (!target) {
    await runAutopilot(squadsDir, options);
    return;
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

  // Cloud dispatch: skip local execution entirely
  if (options.cloud) {
    const agentName = options.agent || agentFromSlash;
    if (!agentName) {
      writeLine(`  ${colors.red}${icons.error} --cloud requires a specific agent${RESET}`);
      writeLine(`  ${colors.dim}Usage: squads run ${squadName} --cloud -a <agent>${RESET}`);
      writeLine(`  ${colors.dim}   or: squads run ${squadName}/<agent> --cloud${RESET}`);
      process.exit(1);
    }
    await track(Events.CLI_RUN, { type: 'cloud', target: `${squadName}/${agentName}` });
    await flushEvents();
    await runCloudDispatch(squadName, agentName, options);
    return;
  }

  // Check if target is a squad or an agent
  const squad = loadSquad(squadName);

  // Pre-flight executor check: verify CLI and auth before attempting execution
  // Only runs when we're actually going to execute (not dry-run)
  if (options.execute && !options.dryRun) {
    // Resolve the provider early so we check the right CLI
    const provider = options.provider || squad?.providers?.default || 'anthropic';
    const checksOk = await preflightExecutorCheck(provider);
    if (!checksOk) {
      process.exit(1);
    }
  }

  if (squad) {
    await track(Events.CLI_RUN, { type: 'squad', target: squad.name });
    await flushEvents(); // Ensure telemetry is sent before potential exit
    await runSquad(squad, squadsDir, options);
    // Post-run COO evaluation (default on, --no-eval to skip)
    await runPostEvaluation([squad.name], options);
  } else {
    // Try to find as an agent
    const agents = listAgents(squadsDir);
    const agent = agents.find(a => a.name === target);

    if (agent && agent.filePath) {
      // Extract squad name from path
      const pathParts = agent.filePath.split('/');
      const squadIdx = pathParts.indexOf('squads');
      const resolvedSquadName = squadIdx >= 0 ? pathParts[squadIdx + 1] : 'unknown';
      await runAgent(agent.name, agent.filePath, resolvedSquadName, options);
      // Post-run COO evaluation for the squad this agent belongs to
      await runPostEvaluation([resolvedSquadName], options);
    } else {
      writeLine(`  ${colors.red}Squad or agent "${target}" not found${RESET}`);
      const similar = findSimilarSquads(target, listSquads(squadsDir));
      if (similar.length > 0) {
        writeLine(`  ${colors.dim}Did you mean: ${similar.join(', ')}?${RESET}`);
      }
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
      writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --parallel`);
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
      // Default: Run squad as multi-agent conversation
      // Lead briefs → scanners discover → workers execute → lead reviews → converge
      if (options.execute) {
        writeLine(`  ${bold}Conversation mode${RESET} ${colors.dim}(lead → scan → work → review → verify)${RESET}`);
        writeLine();

        const convOptions: ConversationOptions = {
          task: options.task,
          maxTurns: options.maxTurns,
          costCeiling: options.costCeiling,
          verbose: options.verbose,
          model: options.model,
        };

        // Report execution start to API (fire-and-forget on failure)
        const apiExecId = await reportExecutionStart(squad.name, 'conversation', `conv-${Date.now()}`);

        const result = await runConversation(squad, convOptions);

        // Save transcript
        const transcriptPath = saveTranscript(result.transcript);

        // Report conversation result to API (fire-and-forget)
        if (apiExecId) {
          reportConversationResult(apiExecId, {
            turnCount: result.turnCount,
            totalCost: result.totalCost,
            converged: result.converged,
            reason: result.reason,
            agentsInvolved: [...new Set(result.transcript.turns.map(t => t.agent))],
          });
        }

        // Push conversation signal to cognition engine (fire-and-forget)
        pushCognitionSignal({
          source: 'execution',
          signal_type: result.converged ? 'conversation_converged' : 'conversation_stopped',
          value: result.totalCost,
          unit: 'usd',
          data: {
            turn_count: result.turnCount,
            converged: result.converged,
            reason: result.reason,
            agents_involved: [...new Set(result.transcript.turns.map(t => t.agent))],
          },
          entity_type: 'squad',
          entity_id: squad.name,
          confidence: 0.9,
        });

        writeLine();
        writeLine(`  ${result.converged ? icons.success : icons.warning} ${result.converged ? 'Converged' : 'Stopped'}: ${result.reason}`);
        writeLine(`  ${colors.dim}Turns: ${result.turnCount} | Cost: ~$${result.totalCost.toFixed(2)}${RESET}`);
        if (transcriptPath) {
          writeLine(`  ${colors.dim}Transcript: ${transcriptPath}${RESET}`);
        }
        writeLine();
      } else {
        // Dry-run: show what would happen
        writeLine(`  ${colors.dim}Default mode: conversation (lead → scan → work → review → verify)${RESET}`);
        writeLine();
        for (const agent of squad.agents) {
          writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
        }
        writeLine();
        writeLine(`  ${colors.dim}Run conversation:${RESET}`);
        writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET}`);
        writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --task "review and merge open PRs"`);
        writeLine();
        writeLine(`  ${colors.dim}Run single agent:${RESET}`);
        writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} -a ${colors.cyan}<agent>${RESET}`);
      }
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}After execution, record outcome:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads feedback add ${colors.cyan}${squad.name}${RESET} ${colors.cyan}<1-5>${RESET} ${colors.cyan}"<feedback>"${RESET}`);
  writeLine();
}

// ── Post-run evaluation ─────────────────────────────────────────────
// After any squad run, dispatch the COO (company-lead) to evaluate outputs.
// This is the feedback loop that makes the system learn.

const EVAL_TIMEOUT_MINUTES = 15;

/**
 * Run the COO evaluation after squad execution.
 * Dispatches company-lead with a scoped evaluation task for the squads that just ran.
 * Generates feedback.md and active-work.md per squad.
 */
async function runPostEvaluation(
  squadsRun: string[],
  options: RunOptions,
): Promise<void> {
  // Skip if running company squad itself (prevent recursion)
  if (squadsRun.length === 1 && squadsRun[0] === 'company') return;
  // Skip if evaluation disabled
  if (options.eval === false) return;
  // Skip dry-run
  if (options.dryRun) return;
  // Skip background runs — evaluation needs foreground context
  if (options.background) return;

  const squadsDir = findSquadsDir();
  if (!squadsDir) return;

  // Find company-lead agent
  const cooPath = join(squadsDir, 'company', 'company-lead.md');
  if (!existsSync(cooPath)) {
    if (options.verbose) {
      writeLine(`  ${colors.dim}Skipping evaluation: company-lead.md not found${RESET}`);
    }
    return;
  }

  const squadList = squadsRun.join(', ');
  writeLine();
  writeLine(`  ${gradient('eval')} ${colors.dim}COO evaluating: ${squadList}${RESET}`);

  const evalTask = `Post-run evaluation for: ${squadList}.

## Evaluation Process

For each squad (${squadList}):

### 1. Read previous feedback FIRST
Read \`.agents/memory/{squad}/feedback.md\` if it exists. Note the previous grade, identified patterns, and priorities. This is your baseline — you are measuring CHANGE, not just current state.

### 2. Gather current evidence
- PRs (last 7 days): \`gh pr list --state all --limit 20 --json number,title,state,mergedAt,createdAt\`
- Recent commits (last 7 days): \`gh api repos/{owner}/{repo}/commits?since=YYYY-MM-DDT00:00:00Z&per_page=20 --jq '.[].commit.message'\`
- Open issues: \`gh issue list --state open --limit 15 --json number,title,labels\`
- Read \`.agents/memory/{squad}/priorities.md\` and \`.agents/memory/company/directives.md\`
- Read \`.agents/memory/{squad}/active-work.md\` (previous cycle's work tracking)

### 3. Write feedback.md (APPEND history, don't overwrite)
\`\`\`markdown
# Feedback — {squad}

## Current Assessment (YYYY-MM-DD): [A-F]
Merge rate: X% | Noise ratio: Y% | Priority alignment: Z%

## Trajectory: [improving | stable | declining | new]
Previous grade: [grade] → Current: [grade]. [1-line explanation of why]

## Valuable (continue)
- [specific PR/issue that advanced priorities]

## Noise (stop)
- [specific anti-pattern observed]

## Next Cycle Priorities
1. [specific actionable item]

## History
| Date | Grade | Key Signal |
|------|-------|------------|
| YYYY-MM-DD | X | [what drove this grade] |
[keep last 10 entries, append new row]
\`\`\`

### 4. Write active-work.md
\`\`\`markdown
# Active Work — {squad} (YYYY-MM-DD)
## Continue (open PRs)
- #{number}: {title} — {status/next action}
## Backlog (assigned issues)
- #{number}: {title} — {priority}
## Do NOT Create
- {description of known duplicate patterns from feedback history}
\`\`\`

### 5. Commit to hq main
${squadsRun.length > 1 ? `
### 6. Cross-squad assessment
Evaluate how outputs from ${squadList} connect:
- Duplicated efforts across squads?
- Missing handoffs (one squad's output should feed another)?
- Coordination gaps (conflicting PRs, redundant issues)?
- Combined trajectory: is the org getting more effective or more noisy?
Write cross-squad findings to \`.agents/memory/company/cross-squad-review.md\`.
` : ''}
CRITICAL: You are measuring DIRECTION not just position. A C-grade squad improving from F is better than a B-grade squad declining from A. The history table IS the feedback loop — agents read it next cycle.`;

  await runAgent('company-lead', cooPath, 'company', {
    ...options,
    task: evalTask,
    timeout: EVAL_TIMEOUT_MINUTES,
    eval: false, // prevent recursion
    trigger: 'manual',
  });
}

// ── Autopilot mode ──────────────────────────────────────────────────
// When `squads run` is called with no target, it becomes the daemon:
// score all squads, dispatch the full loop (scanner→lead→worker→verifier)
// for top-priority squads, push cognition signals, repeat.

// Default cooldowns per agent role (ms)
const ROLE_COOLDOWNS: Record<string, number> = {
  scanner: 60 * 60 * 1000,         // 1h — fast, cheap
  lead: 4 * 60 * 60 * 1000,        // 4h — orchestration
  worker: 30 * 60 * 1000,          // 30m — if work exists
  verifier: 30 * 60 * 1000,        // 30m — follows workers
  'issue-solver': 30 * 60 * 1000,  // 30m — default worker
};

/**
 * Classify an agent's role from its name.
 * Uses classifyAgent from conversation.ts, falls back to 'worker'.
 */
function classifyAgentRole(name: string): string {
  return classifyAgent(name) ?? 'worker';
}

/**
 * Autopilot: continuous loop that scores squads and dispatches full squad loops.
 * Replaces the daemon command — same state file, same scoring, but dispatches
 * the full agent roster instead of just issue-solver.
 */
async function runAutopilot(
  squadsDir: string,
  options: RunOptions,
): Promise<void> {
  const interval = parseInt(String(options.interval || '30'), 10);
  const maxParallel = parseInt(String(options.maxParallel || '2'), 10);
  const budget = parseFloat(String(options.budget || '0'));
  const once = !!options.once;

  // Seed cognition beliefs on first run
  const cognitionState = loadCognitionState();
  seedBeliefsIfEmpty(cognitionState);
  saveCognitionState(cognitionState);

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}autopilot${RESET}`);
  writeLine(`  ${colors.dim}Interval: ${interval}m | Parallel: ${maxParallel} | Budget: ${budget > 0 ? '$' + budget + '/day' : 'unlimited'}${RESET}`);
  writeLine(`  ${colors.dim}Cognition: ${cognitionState.beliefs.length} beliefs, ${cognitionState.signals.length} signals${RESET}`);
  writeLine();

  let running = true;
  const handleSignal = () => { running = false; };
  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  while (running) {
    const cycleStart = Date.now();
    const state = loadLoopState();

    // Reset daily cost at midnight
    const today = new Date().toISOString().slice(0, 10);
    if (state.dailyCostDate !== today) {
      state.dailyCost = 0;
      state.dailyCostDate = today;
    }

    // Budget check
    if (budget > 0 && state.dailyCost >= budget) {
      writeLine(`  ${icons.warning} ${colors.yellow}Daily budget reached ($${state.dailyCost.toFixed(2)}/$${budget})${RESET}`);
      saveLoopState(state);
      if (once) break;
      await sleep(interval * 60 * 1000);
      continue;
    }

    writeLine(`  ${colors.dim}── Cycle ${new Date().toLocaleTimeString()} ──${RESET}`);

    // Get bot env for GitHub API calls
    let ghEnv: Record<string, string> = {};
    try { ghEnv = await getBotGhEnv(); } catch { /* use default */ }

    // Score squads
    const squadRepos = getSquadRepos();

    let dispatchedSquadNames: string[];
    const failed: string[] = [];
    const completed: string[] = [];

    if (options.phased) {
      // ── Phased dispatch: execute squads in dependency order ──
      const phases = computePhases();
      const phaseCount = phases.size;
      writeLine(`  ${colors.dim}Phased mode: ${phaseCount} phase(s)${RESET}`);

      dispatchedSquadNames = [];

      for (const [phaseNum, phaseSquads] of phases) {
        writeLine(`  ${colors.dim}── Phase ${phaseNum} (${phaseSquads.join(', ')}) ──${RESET}`);

        // Score only squads in this phase
        const phaseSignals = scoreSquadsForPhase(phaseSquads, state, squadRepos, ghEnv);
        const phaseDispatch = phaseSignals
          .filter(s => s.score > 0)
          .slice(0, maxParallel);

        if (phaseDispatch.length === 0) {
          writeLine(`    ${colors.dim}No squads need attention in this phase${RESET}`);
          continue;
        }

        for (const sig of phaseDispatch) {
          writeLine(`    ${colors.cyan}${sig.squad}${RESET} (score: ${sig.score}) — ${sig.reason}`);
        }

        if (options.dryRun) {
          continue;
        }

        // Dispatch phase squads in parallel, wait for all before next phase
        const phaseResults = await Promise.allSettled(
          phaseDispatch.map(sig => {
            const squad = loadSquad(sig.squad);
            if (!squad) return Promise.resolve();
            return runSquadLoop(squad, squadsDir, state, ghEnv, options);
          })
        );

        for (let i = 0; i < phaseResults.length; i++) {
          const name = phaseDispatch[i].squad;
          dispatchedSquadNames.push(name);
          if (phaseResults[i].status === 'rejected') {
            failed.push(name);
            state.failCounts[name] = (state.failCounts[name] || 0) + 1;
          } else {
            completed.push(name);
            delete state.failCounts[name];
          }
        }
      }

      if (options.dryRun) {
        writeLine(`  ${colors.yellow}[DRY RUN] Would dispatch above squads in phase order${RESET}`);
        saveLoopState(state);
        if (once) break;
        await sleep(interval * 60 * 1000);
        continue;
      }
    } else {
      // ── Flat dispatch: score-based, no phase ordering ──
      const signals = scoreSquads(state, squadRepos, ghEnv);

      if (signals.length === 0 || signals.every(s => s.score <= 0)) {
        writeLine(`  ${colors.dim}No squads need attention${RESET}`);
        saveLoopState(state);
        if (once) break;
        await sleep(interval * 60 * 1000);
        continue;
      }

      // Pick top N squads to dispatch
      const toDispatch = signals
        .filter(s => s.score > 0)
        .slice(0, maxParallel);

      writeLine(`  ${colors.dim}Dispatching ${toDispatch.length} squad(s):${RESET}`);
      for (const sig of toDispatch) {
        writeLine(`    ${colors.cyan}${sig.squad}${RESET} (score: ${sig.score}) — ${sig.reason}`);
      }

      if (options.dryRun) {
        writeLine(`  ${colors.yellow}[DRY RUN] Would dispatch above squads${RESET}`);
        saveLoopState(state);
        if (once) break;
        await sleep(interval * 60 * 1000);
        continue;
      }

      // Dispatch squad loops in parallel
      const results = await Promise.allSettled(
        toDispatch.map(sig => {
          const squad = loadSquad(sig.squad);
          if (!squad) return Promise.resolve();
          return runSquadLoop(squad, squadsDir, state, ghEnv, options);
        })
      );

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const name = toDispatch[i].squad;
        if (r.status === 'rejected') {
          failed.push(name);
          state.failCounts[name] = (state.failCounts[name] || 0) + 1;
        } else {
          completed.push(name);
          delete state.failCounts[name];
        }
      }

      dispatchedSquadNames = toDispatch.map(s => s.squad);
    }

    // Estimate cost (rough: $1 per squad loop)
    const cycleCost = dispatchedSquadNames.length * 1.0;
    state.dailyCost += cycleCost;

    // Push memory signals for dispatched squads
    await pushMemorySignals(dispatchedSquadNames, state, !!options.verbose);

    // Trim and save state
    state.recentRuns = state.recentRuns.slice(-100);
    state.lastCycle = new Date().toISOString();
    saveLoopState(state);

    // Slack: only on failures
    if (failed.length > 0) {
      slackNotify([
        `*Autopilot cycle — failures*`,
        `Failed: ${failed.join(', ')}`,
        `Completed: ${completed.join(', ')}`,
        `Daily: $${state.dailyCost.toFixed(2)}${budget > 0 ? '/$' + budget : ''}`,
      ].join('\n'));
    }

    // Escalate persistent failures
    for (const [key, count] of Object.entries(state.failCounts)) {
      if (count >= 3) {
        slackNotify(`🚨 *Escalation*: ${key} has failed ${count} times consecutively.`);
      }
    }

    // ── Post-run COO evaluation ──
    // Evaluate outputs from all dispatched squads (skips if company was the only one)
    if (dispatchedSquadNames.length > 0) {
      await runPostEvaluation(dispatchedSquadNames, options);
    }

    // ── Cognition: learn from this cycle ──
    // Ingest memory → synthesize signals → evaluate decisions → reflect
    writeLine(`  ${colors.dim}Cognition cycle...${RESET}`);
    const cognitionResult = await runCognitionCycle(dispatchedSquadNames, !!options.verbose);
    if (cognitionResult.signalsIngested > 0 || cognitionResult.beliefsUpdated > 0 || cognitionResult.reflected) {
      writeLine(`  ${colors.dim}🧠 ${cognitionResult.signalsIngested} signals → ${cognitionResult.beliefsUpdated} beliefs updated${cognitionResult.reflected ? ' → reflected' : ''}${RESET}`);
    }

    const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(0);
    writeLine(`  ${colors.dim}Cycle done in ${elapsed}s | Daily: $${state.dailyCost.toFixed(2)}${RESET}`);
    writeLine();

    if (once) break;
    await sleep(interval * 60 * 1000);
  }

  process.off('SIGINT', handleSignal);
  process.off('SIGTERM', handleSignal);
}

/**
 * Run the full squad loop: scanner → lead → worker → verifier.
 * Each step checks cooldowns and pushes cognition signals.
 * This is the core intelligence loop.
 */
async function runSquadLoop(
  squad: NonNullable<ReturnType<typeof loadSquad>>,
  squadsDir: string,
  state: LoopState,
  ghEnv: Record<string, string>,
  options: RunOptions,
): Promise<void> {
  writeLine(`  ${gradient('▸')} ${colors.cyan}${squad.name}${RESET} — full loop`);

  // Discover agents and classify by role
  const agentsByRole: Record<string, Array<{ name: string; path: string }>> = {
    scanner: [],
    lead: [],
    worker: [],
    verifier: [],
  };

  for (const agent of squad.agents) {
    const role = classifyAgentRole(agent.name);
    const agentPath = join(squadsDir, squad.dir, `${agent.name}.md`);
    if (existsSync(agentPath)) {
      agentsByRole[role].push({ name: agent.name, path: agentPath });
    }
  }

  const loopSteps: Array<{ role: string; agents: Array<{ name: string; path: string }> }> = [
    { role: 'scanner', agents: agentsByRole.scanner },
    { role: 'lead', agents: agentsByRole.lead },
    { role: 'worker', agents: agentsByRole.worker },
    { role: 'verifier', agents: agentsByRole.verifier },
  ];

  for (const step of loopSteps) {
    if (step.agents.length === 0) continue;

    for (const agent of step.agents) {
      const cooldownMs = ROLE_COOLDOWNS[step.role] || ROLE_COOLDOWNS.worker;
      if (!checkCooldown(state, squad.name, agent.name, cooldownMs)) {
        if (options.verbose) {
          writeLine(`    ${colors.dim}↳ ${agent.name} (${step.role}) — in cooldown, skip${RESET}`);
        }
        continue;
      }

      writeLine(`    ${colors.dim}↳ ${agent.name} (${step.role})${RESET}`);

      const startMs = Date.now();
      try {
        // For workers with no specific agent flag, use conversation mode
        // For scanners/leads/verifiers, run as direct agent
        if (step.role === 'worker' && step.agents.length > 1) {
          // Multiple workers → conversation mode coordinates them
          const convOptions: ConversationOptions = {
            task: options.task,
            maxTurns: options.maxTurns || 20,
            costCeiling: options.costCeiling || 25,
            verbose: options.verbose,
            model: options.model,
          };
          await runConversation(squad, convOptions);
        } else {
          await runAgent(agent.name, agent.path, squad.dir, {
            ...options,
            background: false,
            watch: false,
            execute: true,
          });
        }

        const durationMs = Date.now() - startMs;
        const outcome = classifyRunOutcome(0, durationMs);

        // Update cooldown
        state.cooldowns[`${squad.name}:${agent.name}`] = Date.now();

        // Record run
        state.recentRuns.push({
          squad: squad.name,
          agent: agent.name,
          at: new Date().toISOString(),
          result: outcome === 'skipped' ? 'completed' : outcome,
          durationMs,
        });

        // Push cognition signal
        pushCognitionSignal({
          source: 'execution',
          signal_type: `${step.role}_${outcome}`,
          value: durationMs / 1000,
          unit: 'seconds',
          data: {
            squad: squad.name,
            agent: agent.name,
            role: step.role,
            duration_ms: durationMs,
          },
          entity_type: 'agent',
          entity_id: `${squad.name}/${agent.name}`,
          confidence: 0.9,
        });

        if (outcome === 'skipped') {
          writeLine(`    ${colors.dim}↳ ${agent.name} — phantom (${(durationMs / 1000).toFixed(0)}s), skipped${RESET}`);
        }

        // If this was a worker step, break after first conversation
        if (step.role === 'worker' && step.agents.length > 1) break;

      } catch (err) {
        const durationMs = Date.now() - startMs;
        state.cooldowns[`${squad.name}:${agent.name}`] = Date.now();
        state.recentRuns.push({
          squad: squad.name,
          agent: agent.name,
          at: new Date().toISOString(),
          result: 'failed',
          durationMs,
        });

        writeLine(`    ${colors.red}↳ ${agent.name} failed: ${err instanceof Error ? err.message : 'unknown'}${RESET}`);
      }
    }
  }

  writeLine(`  ${colors.dim}↳ ${squad.name} loop complete${RESET}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --lead`);
    writeLine();
    return;
  }

  // Build the lead prompt
  const timeoutMins = options.timeout || DEFAULT_TIMEOUT_MINUTES;
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
    const msg = error instanceof Error ? error.message : String(error);
    writeLine(`  ${icons.error} ${colors.red}Failed to launch agent${RESET}`);
    writeLine(`  ${colors.dim}${msg}${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads doctor\` to check your setup.${RESET}`);
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

  // Fetch learnings from bridge (needed for both dry-run preview and real execution)
  const learnings = await fetchLearnings(squadName);
  const learningContext = learnings.length > 0
    ? `\n## Learnings from Previous Runs\n${learnings.map(l => `- ${l.content}`).join('\n')}\n`
    : '';

  if (options.dryRun) {
    spinner.info(`[DRY RUN] Would run ${agentName}`);
    // Show context that would be injected (with role-based gating)
    const dryRunAgentRole = classifyAgent(agentName);
    const dryRunContextRole: ContextRole = agentName.includes('company-lead') ? 'coo'
      : (dryRunAgentRole as ContextRole | null) ?? 'worker';
    const dryRunContext = gatherSquadContext(squadName, agentName, {
      verbose: options.verbose, agentPath, role: dryRunContextRole
    });
    if (options.verbose) {
      writeLine(`  ${colors.dim}Agent definition:${RESET}`);
      writeLine(`  ${colors.dim}${definition.slice(0, DRYRUN_DEF_MAX_CHARS)}...${RESET}`);
      if (learnings.length > 0) {
        writeLine(`  ${colors.dim}Learnings: ${learnings.length} from bridge${RESET}`);
      }
      if (dryRunContext || learningContext) {
        const fullContext = `${dryRunContext}${learningContext}`;
        writeLine();
        writeLine(`  ${colors.cyan}Context to inject (${Math.ceil(fullContext.length / 4)} tokens):${RESET}`);
        writeLine(`  ${colors.dim}${fullContext.slice(0, DRYRUN_CONTEXT_MAX_CHARS)}...${RESET}`);
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
    // Read cooldown from agent frontmatter, fall back to default
    const frontmatterForCooldown = parseAgentFrontmatter(agentPath);
    const cooldownMs = frontmatterForCooldown.cooldown
      ? (parseCooldown(frontmatterForCooldown.cooldown) || DEFAULT_SCHEDULED_COOLDOWN_MS)
      : DEFAULT_SCHEDULED_COOLDOWN_MS;
    const localCooldown = checkLocalCooldown(squadName, agentName, cooldownMs);

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

  if (options.verbose && learnings.length > 0) {
    writeLine(`  ${colors.dim}Injecting ${learnings.length} learnings${RESET}`);
  }

  // Load system protocol (SYSTEM.md, replaces legacy approval + post-execution)
  const systemProtocol = loadSystemProtocol();
  const systemContext = systemProtocol ? `\n${systemProtocol}\n` : '';

  // Derive context role from agent name for role-based context gating
  const agentRole = classifyAgent(agentName);
  const contextRole: ContextRole = agentName.includes('company-lead') ? 'coo'
    : (agentRole as ContextRole | null) ?? 'worker';

  // Gather squad context (role-based: scanners get minimal, leads get everything)
  const squadContext = gatherSquadContext(squadName, agentName, {
    verbose: options.verbose, agentPath, role: contextRole
  });

  // Fetch cognition beliefs for prompt injection (Reflexion pattern)
  let cognitionContext = '';
  try {
    const { loadSession } = await import('../lib/auth.js');
    const { getApiUrl } = await import('../lib/env-config.js');
    const session = loadSession();
    if (session?.accessToken && session.status === 'active') {
      const safeSquadName = encodeURIComponent(squadName);
      const res = await fetch(`${getApiUrl()}/cognition/context/squad:${safeSquadName}`, {
        headers: { Authorization: `Bearer ${session.accessToken}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const data = await res.json() as { markdown: string };
        if (data.markdown && !data.markdown.includes('No cognition data')) {
          cognitionContext = `\n${data.markdown}\n`;
          if (options.verbose) {
            writeLine(`  ${colors.dim}Injecting cognition beliefs${RESET}`);
          }
        }
      }
    }
  } catch (e) {
    if (options.verbose) writeLine(`  ${colors.dim}warn: cognition fetch failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
  }

  // Generate the Claude Code prompt with timeout awareness
  const timeoutMins = options.timeout || DEFAULT_TIMEOUT_MINUTES;
  const taskDirective = options.task
    ? `\n## TASK DIRECTIVE (overrides default behavior)\n${options.task}\n`
    : '';
  const prompt = `Execute the ${agentName} agent from squad ${squadName}.

Read the agent definition at ${agentPath} and follow its instructions exactly.
${taskDirective}
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
${systemContext}${squadContext}${cognitionContext}${learningContext}
TIME LIMIT: You have ${timeoutMins} minutes. Work efficiently:
- Focus on the most important tasks first
- If a task is taking too long, move on and note it for next run
- Aim to complete within ${Math.floor(timeoutMins * SOFT_DEADLINE_RATIO)} minutes`;

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

    // Parse frontmatter for verification criteria (Ralph loop)
    const frontmatter = parseAgentFrontmatter(agentPath);
    const hasCriteria = !!frontmatter.acceptance_criteria && options.verify !== false;
    const maxRetries = frontmatter.max_retries ?? 2;
    let currentPrompt = prompt;

    for (let attempt = 0; attempt <= (hasCriteria ? maxRetries : 0); attempt++) {
      try {
        let result: string;

        if (isAnthropic) {
          result = await executeWithClaude(currentPrompt, {
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
          result = await executeWithProvider(provider, currentPrompt, {
            verbose: options.verbose,
            foreground: !isBackground,
            squadName,
            agentName,
          });
        }

        // Ralph loop: verify foreground execution against acceptance criteria
        if (hasCriteria && (isForeground || isWatch)) {
          const verification = await verifyExecution(
            squadName, agentName, frontmatter.acceptance_criteria!, { verbose: options.verbose }
          );
          if (!verification.passed && attempt < maxRetries) {
            writeLine(`  ${colors.yellow}Verification: FAIL - ${verification.reason}${RESET}`);
            writeLine(`  ${colors.dim}Retrying (${attempt + 1}/${maxRetries})...${RESET}`);
            currentPrompt = `${prompt}\n\n## PREVIOUS ATTEMPT FAILED\nVerification found: ${verification.reason}\nPlease address this issue and try again.`;
            continue;
          }
          if (verification.passed) {
            writeLine(`  ${colors.green}Verification: PASS - ${verification.reason}${RESET}`);
          }
        }

        // Emit completion event (non-blocking)
        emitExecutionEvent('agent.completed', {
          squad: squadName, agent: agentName, executionId,
        }).catch(() => {});

        if (isForeground || isWatch) {
          spinner.succeed(`Agent ${agentName} completed (${cliName})`);
        } else {
          spinner.succeed(`Agent ${agentName} launched in background (${cliName})`);
          writeLine(`  ${colors.dim}${result}${RESET}`);
          writeLine();
          writeLine(`  ${colors.dim}Monitor:${RESET} squads workers`);
          writeLine(`  ${colors.dim}Memory:${RESET}  squads memory show ${squadName}`);
        }
        break; // Success — exit retry loop
      } catch (error) {
        // Emit failure event (non-blocking)
        emitExecutionEvent('agent.failed', {
          squad: squadName, agent: agentName, executionId, error: String(error),
        }).catch(() => {});

        spinner.fail(`Agent ${agentName} failed to launch`);
        updateExecutionStatus(squadName, agentName, executionId, 'failed', {
          error: String(error),
          durationMs: Date.now() - startMs,
        });
        const msg = error instanceof Error ? error.message : String(error);
        const isLikelyBug = error instanceof ReferenceError || error instanceof TypeError || error instanceof SyntaxError;
        writeLine(`  ${colors.red}${msg}${RESET}`);
        writeLine();
        if (isLikelyBug) {
          writeLine(`  ${colors.yellow}This looks like a bug. Please try:${RESET}`);
          writeLine(`  ${colors.dim}$${RESET} squads doctor          ${colors.dim}— check your setup${RESET}`);
          writeLine(`  ${colors.dim}$${RESET} squads update           ${colors.dim}— get the latest fixes${RESET}`);
          writeLine();
          writeLine(`  ${colors.dim}If the problem persists, file an issue:${RESET}`);
          writeLine(`  ${colors.dim}https://github.com/agents-squads/squads-cli/issues${RESET}`);
        } else {
          writeLine(`  ${colors.dim}Run \`squads doctor\` to check your setup, or \`squads run ${agentName} --verbose\` for details.${RESET}`);
        }
        break; // Error — exit retry loop
      }
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
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET} -a ${colors.cyan}${agentName}${RESET}`);
    if (provider !== 'anthropic') {
      writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET} -a ${colors.cyan}${agentName}${RESET} --provider=${provider}`);
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

/**
 * Pre-flight check for the executor (Claude Code or other provider CLI).
 * Runs once at the start of `squads run` before any agent execution.
 * Checks:
 *   1. CLI binary is available on PATH
 *   2. Authentication looks configured (credentials file or API key)
 * Skippable with SQUADS_SKIP_CHECKS=1 env var (for CI/CD).
 * Returns true if checks pass (or are skipped), false if execution should abort.
 */
async function preflightExecutorCheck(provider: string): Promise<boolean> {
  // Allow skipping for CI/CD or advanced users
  if (process.env.SQUADS_SKIP_CHECKS === '1') {
    return true;
  }

  const isAnthropic = provider === 'anthropic';

  // --- Check 1: CLI binary on PATH ---
  let cliFound: boolean;

  if (isAnthropic) {
    cliFound = await checkClaudeCliAvailable();
  } else {
    cliFound = isProviderCLIAvailable(provider);
  }

  if (!cliFound) {
    const cliConfig = getCLIConfig(provider);
    const cliName = cliConfig?.command || provider;
    const installCmd = cliConfig?.install || `See ${provider} documentation`;

    writeLine();
    writeLine(`  ${icons.error} ${colors.red}${cliName} CLI not found${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}The ${cliName} command is required to run agents but was not found on your PATH.${RESET}`);
    writeLine();
    writeLine(`  ${colors.cyan}Install:${RESET} ${installCmd}`);
    writeLine();
    writeLine(`  ${colors.dim}Skip this check: SQUADS_SKIP_CHECKS=1 squads run ...${RESET}`);
    writeLine();
    return false;
  }

  // Auth check removed: Claude CLI handles its own auth errors with clear messages.
  // Pre-checking here caused false warnings for OAuth users (keychain auth works
  // without .credentials.json or ANTHROPIC_API_KEY). See #520.

  return true;
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
  model?: string; // Model to use (Claude aliases or full model IDs like gemini-2.5-flash)
}

/** Build agent environment variables for Claude execution */
function buildAgentEnv(
  baseEnv: Record<string, string>,
  execContext: ExecutionContext,
  options?: { effort?: EffortLevel; skills?: string[]; includeOtel?: boolean; ghToken?: string }
): Record<string, string> {
  // Strip CLAUDECODE to allow spawning claude from within a Claude Code session
  const { CLAUDECODE: _, ...cleanEnv } = baseEnv;
  const env: Record<string, string> = {
    ...cleanEnv,
    SQUADS_SQUAD: execContext.squad,
    SQUADS_AGENT: execContext.agent,
    SQUADS_TASK_TYPE: execContext.taskType,
    SQUADS_TRIGGER: execContext.trigger,
    SQUADS_EXECUTION_ID: execContext.executionId,
    BRIDGE_API: getBridgeUrl(),
  };

  // Inject bot GH_TOKEN so agents create PRs/issues as the bot identity,
  // not the user's personal gh auth. This enables founder to review/approve.
  if (options?.ghToken) env.GH_TOKEN = options.ghToken;

  if (options?.includeOtel) {
    env.OTEL_RESOURCE_ATTRIBUTES = `squads.squad=${execContext.squad},squads.agent=${execContext.agent},squads.task_type=${execContext.taskType},squads.trigger=${execContext.trigger},squads.execution_id=${execContext.executionId}`;
  }

  if (options?.effort) env.CLAUDE_EFFORT = options.effort;
  if (options?.skills && options.skills.length > 0) env.CLAUDE_SKILLS = options.skills.join(',');

  return env;
}

/** Log verbose execution config (shared by foreground and background modes) */
function logVerboseExecution(config: {
  projectRoot: string;
  mode: string;
  useApi?: boolean;
  execContext: ExecutionContext;
  effort?: EffortLevel;
  skills?: string[];
  resolvedModel?: string;
  claudeModelAlias?: string;
  explicitModel?: string;
  logFile?: string;
  mcpConfigPath?: string;
}): void {
  writeLine(`  ${colors.dim}Project: ${config.projectRoot}${RESET}`);
  writeLine(`  ${colors.dim}Mode: ${config.mode}${RESET}`);
  if (config.logFile) writeLine(`  ${colors.dim}Log: ${config.logFile}${RESET}`);
  if (config.mcpConfigPath) writeLine(`  ${colors.dim}MCP config: ${config.mcpConfigPath}${RESET}`);
  if (config.useApi !== undefined) writeLine(`  ${colors.dim}Auth: ${config.useApi ? 'API credits' : 'subscription'}${RESET}`);
  writeLine(`  ${colors.dim}Execution: ${config.execContext.executionId}${RESET}`);
  writeLine(`  ${colors.dim}Task type: ${config.execContext.taskType}${RESET}`);
  writeLine(`  ${colors.dim}Trigger: ${config.execContext.trigger}${RESET}`);
  if (config.effort) writeLine(`  ${colors.dim}Effort: ${config.effort}${RESET}`);
  if (config.skills && config.skills.length > 0) writeLine(`  ${colors.dim}Skills: ${config.skills.join(', ')}${RESET}`);
  if (config.resolvedModel || config.claudeModelAlias) {
    const source = config.explicitModel ? 'explicit' : 'auto-routed';
    const displayModel = config.resolvedModel || config.claudeModelAlias;
    writeLine(`  ${colors.dim}Model: ${displayModel} (${source})${RESET}`);
  }
}

/** Resolve the target repo root from the squad's repo field (e.g. "org/squads-cli" → sibling dir) */
function resolveTargetRepoRoot(projectRoot: string, squad: Squad | null): string {
  if (!squad?.repo) return projectRoot;
  const repoName = squad.repo.split('/').pop();
  if (!repoName) return projectRoot;
  const candidatePath = join(projectRoot, '..', repoName);
  return existsSync(candidatePath) ? candidatePath : projectRoot;
}

/** Create an isolated worktree for agent execution (Node.js-based, for foreground mode) */
function createAgentWorktree(projectRoot: string, squadName: string, agentName: string): string {
  const timestamp = Date.now();
  const branchName = `agent/${squadName}/${agentName}-${timestamp}`;
  const worktreePath = join(projectRoot, '..', '.worktrees', `${squadName}-${agentName}-${timestamp}`);

  try {
    mkdirSync(join(projectRoot, '..', '.worktrees'), { recursive: true });
    execSync(`git worktree add '${worktreePath}' -b '${branchName}' HEAD`, { cwd: projectRoot, stdio: 'pipe' });
    return worktreePath;
  } catch (e) {
    writeLine(`  ${colors.dim}warn: worktree creation failed, using project root: ${e instanceof Error ? e.message : String(e)}${RESET}`);
    return projectRoot;
  }
}

/** Remove a worktree and its branch after agent execution completes */
function cleanupWorktree(worktreePath: string, projectRoot: string): void {
  if (worktreePath === projectRoot) return; // fallback mode, nothing to clean

  try {
    // Extract branch name from worktree before removing
    const branchInfo = execSync(`git -C '${projectRoot}' worktree list --porcelain`, { encoding: 'utf-8' });
    let branchName = '';
    const lines = branchInfo.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === `worktree ${worktreePath}` && i + 2 < lines.length) {
        const branchLine = lines[i + 2]; // "branch refs/heads/..."
        if (branchLine.startsWith('branch refs/heads/')) {
          branchName = branchLine.replace('branch refs/heads/', '');
        }
        break;
      }
    }

    // Remove worktree
    execSync(`git -C '${projectRoot}' worktree remove '${worktreePath}' --force`, { stdio: 'pipe' });

    // Delete the agent branch (only agent/* branches, safety check)
    if (branchName && branchName.startsWith('agent/')) {
      execSync(`git -C '${projectRoot}' branch -D '${branchName}'`, { stdio: 'pipe' });
    }
  } catch {
    // Non-critical — worktree prune will catch it later
  }
}

/** Build shell script for detached execution with worktree isolation */
function buildDetachedShellScript(config: {
  projectRoot: string;
  squadName: string;
  agentName: string;
  timestamp: number;
  claudeModelAlias?: string;
  escapedPrompt: string;
  logFile: string;
  pidFile: string;
}): string {
  const modelFlag = config.claudeModelAlias ? `--model ${config.claudeModelAlias}` : '';
  const branchName = `agent/${config.squadName}/${config.agentName}-${config.timestamp}`;
  const worktreeDir = `${config.projectRoot}/../.worktrees/${config.squadName}-${config.agentName}-${config.timestamp}`;
  const cleanup = `if [ "\${WORK_DIR}" != '${config.projectRoot}' ]; then git -C '${config.projectRoot}' worktree remove "\${WORK_DIR}" --force 2>/dev/null; BRANCH='${branchName}'; git -C '${config.projectRoot}' branch -D "\${BRANCH}" 2>/dev/null; fi`;
  const script = `mkdir -p '${config.projectRoot}/../.worktrees'; WORK_DIR='${config.projectRoot}'; if git -C '${config.projectRoot}' worktree add '${worktreeDir}' -b '${branchName}' HEAD 2>/dev/null; then WORK_DIR='${worktreeDir}'; fi; cd "\${WORK_DIR}"; unset CLAUDECODE; claude --print --dangerously-skip-permissions --disable-slash-commands ${modelFlag} -- '${config.escapedPrompt}' > '${config.logFile}' 2>&1; ${cleanup}`;
  return `echo $$ > '${config.pidFile}'; ${script}`;
}

/** Prepare log directory and file paths for detached execution */
function prepareLogFiles(projectRoot: string, squadName: string, agentName: string, timestamp: number): { logDir: string; logFile: string; pidFile: string } {
  const logDir = join(projectRoot, '.agents', 'logs', squadName);
  const logFile = join(logDir, `${agentName}-${timestamp}.log`);
  const pidFile = join(logDir, `${agentName}-${timestamp}.pid`);

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  return { logDir, logFile, pidFile };
}

/** Execute Claude in foreground mode (direct stdio, default) */
function executeForeground(config: {
  prompt: string;
  claudeArgs: string[];
  agentEnv: Record<string, string>;
  projectRoot: string;
  squadName: string;
  agentName: string;
  execContext: ExecutionContext;
  startMs: number;
  provider?: string;
}): Promise<string> {
  const workDir = createAgentWorktree(config.projectRoot, config.squadName, config.agentName);

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', config.claudeArgs, {
      stdio: 'inherit',
      cwd: workDir,
      env: config.agentEnv,
    });

    claude.on('close', async (code) => {
      const durationMs = Date.now() - config.startMs;

      if (code === 0) {
        updateExecutionStatus(config.squadName, config.agentName, config.execContext.executionId, 'completed', {
          outcome: 'Session completed successfully',
          durationMs,
        });

        const commitResult = await autoCommitAgentWork(config.squadName, config.agentName, config.execContext.executionId, config.provider);
        if (commitResult.committed) {
          writeLine();
          writeLine(`  ${colors.green}Auto-committed agent work${RESET}`);
        }

        cleanupWorktree(workDir, config.projectRoot);
        resolve('Session completed');
      } else {
        updateExecutionStatus(config.squadName, config.agentName, config.execContext.executionId, 'failed', {
          error: `Claude exited with code ${code}`,
          durationMs,
        });
        cleanupWorktree(workDir, config.projectRoot);
        reject(new Error(`Claude exited with code ${code}`));
      }
    });

    claude.on('error', (err) => {
      const durationMs = Date.now() - config.startMs;
      updateExecutionStatus(config.squadName, config.agentName, config.execContext.executionId, 'failed', {
        error: String(err),
        durationMs,
      });
      cleanupWorktree(workDir, config.projectRoot);
      reject(err);
    });
  });
}

/** Execute Claude in watch mode (background + tail log) */
async function executeWatch(config: {
  projectRoot: string;
  agentEnv: Record<string, string>;
  logFile: string;
  wrapperScript: string;
}): Promise<string> {
  const child = spawn('sh', ['-c', config.wrapperScript], {
    cwd: config.projectRoot,
    detached: true,
    stdio: 'ignore',
    env: config.agentEnv,
  });
  child.unref();

  await new Promise(resolve => setTimeout(resolve, LOG_FILE_INIT_DELAY_MS));

  writeLine(`  ${colors.dim}Tailing log (Ctrl+C to stop watching, agent continues)...${RESET}`);
  writeLine();

  const tail = spawn('tail', ['-f', config.logFile], { stdio: 'inherit' });

  process.on('SIGINT', () => {
    tail.kill();
    writeLine();
    writeLine(`  ${colors.dim}Stopped watching. Agent continues in background.${RESET}`);
    writeLine(`  ${colors.dim}Resume: tail -f ${config.logFile}${RESET}`);
    process.exit(0);
  });

  return new Promise((resolve) => {
    tail.on('close', () => {
      resolve(`Agent running in background. Log: ${config.logFile}`);
    });
  });
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

  // Determine execution mode
  const runInBackground = background === true && !watch;
  const runInWatch = watch === true;
  const runInForeground = !runInBackground && !runInWatch;

  const startMs = Date.now();
  const projectRoot = getProjectRoot();
  ensureProjectTrusted(projectRoot);

  // Resolve model and provider
  const squad = squadName !== 'unknown' ? loadSquad(squadName) : null;
  const mcpConfigPath = selectMcpConfig(squadName, squad);
  const taskType = detectTaskType(agentName);
  const resolvedModel = resolveModel(model, squad, taskType);
  const provider = resolvedModel ? detectProviderFromModel(resolvedModel) : 'anthropic';

  // Resolve target repo for worktree creation (squad.repo → sibling dir)
  const targetRepoRoot = resolveTargetRepoRoot(projectRoot, squad);

  // Delegate to non-Anthropic providers
  if (provider !== 'anthropic' && provider !== 'unknown') {
    if (verbose) {
      const source = model ? 'explicit' : 'auto-routed';
      writeLine(`  ${colors.dim}Model: ${resolvedModel} (${source})${RESET}`);
      writeLine(`  ${colors.dim}Provider: ${provider}${RESET}`);
    }
    return executeWithProvider(provider, prompt, {
      verbose, foreground, cwd: targetRepoRoot, squadName, agentName,
    });
  }

  const claudeModelAlias = resolvedModel ? getClaudeModelAlias(resolvedModel) : undefined;

  const execContext: ExecutionContext = {
    squad: squadName, agent: agentName, taskType, trigger,
    executionId: generateExecutionId(),
  };

  // Build base env: remove ANTHROPIC_API_KEY unless --use-api, remove CLAUDECODE
  const { ANTHROPIC_API_KEY: _apiKey, CLAUDECODE: _claudeCode, ...envWithoutApiKey } = process.env;
  const spawnEnv = useApi
    ? (() => { const { CLAUDECODE: _, ...rest } = process.env; return rest; })()
    : envWithoutApiKey;

  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  await registerContextWithBridge(execContext);

  // Get bot token so agents create PRs/issues as bot identity (not user's personal gh auth)
  let botGhToken: string | undefined;
  try {
    const ghEnv = await getBotGhEnv();
    botGhToken = ghEnv.GH_TOKEN;
  } catch { /* graceful: falls back to user's gh auth */ }

  // ── Foreground mode ──────────────────────────────────────────────────
  if (runInForeground) {
    if (verbose) {
      logVerboseExecution({
        projectRoot, mode: 'foreground', useApi, execContext,
        effort, skills, resolvedModel, claudeModelAlias, explicitModel: model,
      });
    }

    // Build claude args as array to avoid shell escaping issues with large prompts
    const claudeArgs: string[] = [];
    if (!process.stdin.isTTY) claudeArgs.push('--print');
    claudeArgs.push('--dangerously-skip-permissions');
    claudeArgs.push('--disable-slash-commands');
    if (mcpConfigPath) claudeArgs.push('--mcp-config', mcpConfigPath);
    if (claudeModelAlias) claudeArgs.push('--model', claudeModelAlias);
    claudeArgs.push('--', prompt);

    const agentEnv = buildAgentEnv(spawnEnv as Record<string, string>, execContext, {
      effort, skills, includeOtel: true, ghToken: botGhToken,
    });

    return executeForeground({
      prompt, claudeArgs, agentEnv, projectRoot: targetRepoRoot,
      squadName, agentName, execContext, startMs, provider,
    });
  }

  // ── Detached modes (watch + background) ──────────────────────────────
  const timestamp = Date.now();
  const { logFile, pidFile } = prepareLogFiles(projectRoot, squadName, agentName, timestamp);
  const agentEnv = buildAgentEnv(spawnEnv as Record<string, string>, execContext, {
    effort, skills, includeOtel: !runInWatch, ghToken: botGhToken,
  });

  const wrapperScript = buildDetachedShellScript({
    projectRoot: targetRepoRoot, squadName, agentName, timestamp,
    claudeModelAlias, escapedPrompt, logFile, pidFile,
  });

  if (runInWatch) {
    if (verbose) {
      logVerboseExecution({
        projectRoot, mode: 'watch (background + tail)',
        execContext, logFile,
      });
    }

    return executeWatch({ projectRoot: targetRepoRoot, agentEnv, logFile, wrapperScript });
  }

  // ── Background mode ──────────────────────────────────────────────────
  if (verbose) {
    logVerboseExecution({
      projectRoot, mode: 'background', useApi, execContext,
      effort, skills, resolvedModel, claudeModelAlias,
      explicitModel: model, logFile, mcpConfigPath,
    });
  }

  const child = spawn('sh', ['-c', wrapperScript], {
    cwd: targetRepoRoot,
    detached: true,
    stdio: 'ignore',
    env: agentEnv,
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
  const squadName = options.squadName || 'unknown';
  const agentName = options.agentName || 'unknown';
  const timestamp = Date.now();

  // Build clean env: remove CLAUDECODE to allow nesting, pass squad context
  const { CLAUDECODE: _claudeCode, ...cleanEnv } = process.env;
  const providerEnv = {
    ...cleanEnv,
    SQUADS_SQUAD: squadName,
    SQUADS_AGENT: agentName,
    SQUADS_PROVIDER: provider,
  };

  // Create isolated worktree for this agent (same pattern as executeWithClaude)
  const branchName = `agent/${squadName}/${agentName}-${timestamp}`;
  const worktreePath = join(projectRoot, '..', '.worktrees', `${squadName}-${agentName}-${timestamp}`);
  let workDir = projectRoot;
  try {
    mkdirSync(join(projectRoot, '..', '.worktrees'), { recursive: true });
    execSync(`git worktree add '${worktreePath}' -b '${branchName}' HEAD`, { cwd: projectRoot, stdio: 'pipe' });
    workDir = worktreePath;
  } catch (e) {
    writeLine(`  ${colors.dim}warn: worktree creation failed, using project root: ${e instanceof Error ? e.message : String(e)}${RESET}`);
  }

  // Copy .agents directory into worktree so sandboxed providers can access
  // agent definitions, memory, and config files. Providers like Gemini restrict
  // file reads to the workspace directory, so these must be local.
  let effectivePrompt = prompt;
  if (workDir !== projectRoot) {
    const agentsDir = join(projectRoot, '.agents');
    const targetAgentsDir = join(workDir, '.agents');
    if (existsSync(agentsDir) && !existsSync(targetAgentsDir)) {
      try {
        cpSync(agentsDir, targetAgentsDir, { recursive: true });
      } catch (e) {
        writeLine(`  ${colors.dim}warn: .agents copy failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
    }
    // Rewrite absolute paths in prompt so sandboxed providers can resolve them
    effectivePrompt = prompt.replaceAll(projectRoot, workDir);
  }

  const args = cliConfig.buildArgs(effectivePrompt);

  if (options.verbose) {
    writeLine(`  ${colors.dim}Provider: ${cliConfig.displayName}${RESET}`);
    writeLine(`  ${colors.dim}Command: ${cliConfig.command} ${args.join(' ').slice(0, VERBOSE_COMMAND_MAX_CHARS)}...${RESET}`);
    writeLine(`  ${colors.dim}CWD: ${workDir}${RESET}`);
    if (workDir !== projectRoot) {
      writeLine(`  ${colors.dim}Worktree: ${branchName}${RESET}`);
    }
  }

  // Foreground mode: run directly in terminal
  if (options.foreground) {
    return new Promise((resolve, reject) => {
      const proc = spawn(cliConfig.command, args, {
        stdio: 'inherit',
        cwd: workDir,
        env: providerEnv,
      });

      proc.on('close', (code) => {
        cleanupWorktree(workDir, projectRoot);
        if (code === 0) {
          resolve('Session completed');
        } else {
          reject(new Error(`${cliConfig.command} exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        cleanupWorktree(workDir, projectRoot);
        reject(err);
      });
    });
  }

  // Background mode: run detached with log file (matches executeWithClaude pattern)
  const logDir = join(projectRoot, '.agents', 'logs', squadName);
  const logFile = join(logDir, `${agentName}-${timestamp}.log`);
  const pidFile = join(logDir, `${agentName}-${timestamp}.pid`);

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const escapedPrompt = effectivePrompt.replace(/'/g, "'\\''");
  const providerArgs = cliConfig.buildArgs(escapedPrompt).map(a => `'${a}'`).join(' ');
  const cleanupCmd = workDir !== projectRoot
    ? `; git -C '${projectRoot}' worktree remove '${workDir}' --force 2>/dev/null; git -C '${projectRoot}' branch -D '${branchName}' 2>/dev/null`
    : '';
  const shellScript = `cd '${workDir}' && ${cliConfig.command} ${providerArgs} > '${logFile}' 2>&1${cleanupCmd}`;
  const wrapperScript = `echo $$ > '${pidFile}'; ${shellScript}`;

  const child = spawn('sh', ['-c', wrapperScript], {
    cwd: workDir,
    detached: true,
    stdio: 'ignore',
    env: providerEnv,
  });

  child.unref();

  if (options.verbose) {
    writeLine(`  ${colors.dim}Log: ${logFile}${RESET}`);
    writeLine(`  ${colors.dim}PID file: ${pidFile}${RESET}`);
  }

  return `Log: ${logFile}. Monitor: tail -f ${logFile}`;
}

export async function runSquadCommand(
  squadName: string,
  options: RunOptions
): Promise<void> {
  return runCommand(squadName, options);
}
