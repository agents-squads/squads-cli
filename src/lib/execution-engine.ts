/**
 * Execution engine: agent spawning, worktree management, and provider dispatch.
 * Extracted from commands/run.ts to separate execution mechanics from command logic.
 */

import { spawn, execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  loadSquad,
  findSquadsDir,
  findProjectRoot,
  type EffortLevel,
  type Squad,
} from './squad-parser.js';
import { parseAgentFrontmatter } from './run-context.js';
import {
  type ExecutionContext,
} from './run-types.js';
import {
  selectMcpConfig,
  detectTaskType,
  getClaudeModelAlias,
  resolveModel,
  ensureProjectTrusted,
  getProjectRoot,
  generateExecutionId,
  checkClaudeCliAvailable,
} from './run-utils.js';
import {
  registerContextWithBridge,
  updateExecutionStatus,
} from './execution-log.js';
import { logObservability, captureSessionUsage, snapshotGoals, diffGoals, type ObservabilityRecord } from './observability.js';
import { findMemoryDir } from './memory.js';
import { buildSpoolWriterShell, buildWatchdogShell } from './spool.js';
import { detectProviderFromModel } from './providers.js';
import { getBridgeUrl } from './env-config.js';
import { getBotGitEnv, getBotPushUrl, getCoAuthorTrailer, getBotGhEnv } from './github.js';
import { scanDiff, loadForbiddenStrings, summarizeFindings } from './secret-scan.js';
import {
  buildSandboxSettings, readGuardrailHooks, readGuardrailPermissions, writeSandboxSettingsFile, sandboxEnabled,
} from './sandbox-settings.js';
import {
  colors,
  RESET,
  icons,
  writeLine,
} from './terminal.js';
import {
  getCLIConfig,
  isProviderCLIAvailable,
} from './llm-clis.js';

// ── Operational constants (no magic numbers) ──────────────────────────
export const VERIFICATION_STATE_MAX_CHARS = 2000;
export const VERIFICATION_EXEC_TIMEOUT_MS = 30000;
export const LOG_FILE_INIT_DELAY_MS = 500;
export const VERBOSE_COMMAND_MAX_CHARS = 50;

// ── Guardrail settings ────────────────────────────────────────────────

/**
 * Resolve the path to a guardrail settings JSON file for --settings injection.
 *
 * Resolution order:
 *   1. `.claude/guardrail.json` in the project root (user-provided override)
 *   2. Bundled default: `templates/guardrail.json` alongside the squads-cli package
 *
 * Returns undefined when neither exists (no guardrail applied).
 */
export function resolveGuardrailSettings(projectRoot: string): string | undefined {
  // 1. Project-level override
  const projectGuardrail = join(projectRoot, '.claude', 'guardrail.json');
  if (existsSync(projectGuardrail)) return projectGuardrail;

  // 2. Bundled default (dist/lib/ → dist/templates/ in compiled output;
  //    src/lib/ → templates/ in source tree)
  const bundledGuardrail = join(__dirname, '..', '..', 'templates', 'guardrail.json');
  if (existsSync(bundledGuardrail)) return bundledGuardrail;

  // Also check one level up (when running from dist/lib/)
  const bundledGuardrailAlt = join(__dirname, '..', 'templates', 'guardrail.json');
  if (existsSync(bundledGuardrailAlt)) return bundledGuardrailAlt;

  return undefined;
}

// ── Interfaces ────────────────────────────────────────────────────────

export interface ExecuteWithClaudeOptions {
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

// ── Auto-commit ──────────────────────────────────────────────────────

/**
 * Auto-commit agent work after execution completes.
 * Commits as the Agents Squads bot (if configured), pushes with bot token.
 * Falls back to user's git identity if bot not configured.
 */
export async function autoCommitAgentWork(
  squadName: string,
  agentName: string,
  executionId: string,
  provider?: string,
): Promise<{ committed: boolean; message?: string; error?: string }> {
  const { execSync } = await import('child_process');
  const { detectGitHubRepo } = await import('./github.js');
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

    // PII/secret guard — never let an agent's auto-commit leak a credential or
    // PII into a (possibly public) repo. Scan only the staged ADDITIONS; if any
    // finding, unstage and refuse to commit (safe failure: work stays local,
    // surfaced as an error rather than pushed).
    const stagedDiff = execSync('git diff --cached', {
      encoding: 'utf-8', cwd: projectRoot, maxBuffer: 32 * 1024 * 1024,
    });
    const findings = scanDiff(stagedDiff, { forbidden: loadForbiddenStrings(projectRoot) });
    if (findings.length > 0) {
      try { execSync('git reset', execOpts); } catch { /* refuse to commit regardless */ }
      return {
        committed: false,
        error: `blocked: ${findings.length} secret/PII finding(s) in staged changes — ${summarizeFindings(findings)}`,
      };
    }

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

// ── Verification ─────────────────────────────────────────────────────

/**
 * Verify execution against acceptance criteria using a lightweight model.
 * Returns pass/fail with reason. Used by the Ralph verification loop.
 */
export async function verifyExecution(
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

  // Load verification protocol from markdown
  const verifyProtocolPath = join(findProjectRoot() || '', '.agents', 'config', 'verification.md');
  const verifyProtocol = existsSync(verifyProtocolPath) ? readFileSync(verifyProtocolPath, 'utf-8') : 'Respond: PASS: reason or FAIL: reason';

  const verifyPrompt = `Agent: ${squadName}/${agentName}

## Acceptance Criteria
${criteria}

## Evidence

### Agent State File
${stateContent || '(empty or not found)'}

### Recent Git Commits
${recentCommits}

${verifyProtocol}`;

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

// ── Preflight check ──────────────────────────────────────────────────

/**
 * Pre-flight check for the executor (Claude Code or other provider CLI).
 * Runs once at the start of `squads run` before any agent execution.
 * Checks:
 *   1. CLI binary is available on PATH
 *   2. Authentication looks configured (credentials file or API key)
 * Skippable with SQUADS_SKIP_CHECKS=1 env var (for CI/CD).
 * Returns true if checks pass (or are skipped), false if execution should abort.
 */
export async function preflightExecutorCheck(provider: string): Promise<boolean> {
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

// ── Environment & logging helpers ────────────────────────────────────

/** Build agent environment variables for Claude execution */
export function buildAgentEnv(
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

  // Inject per-squad GCP credential if available
  // Agents get GOOGLE_APPLICATION_CREDENTIALS pointing to their squad's service account key
  const credPath = process.env.SQUADS_GCP_CREDENTIALS_DIR
    ? join(process.env.SQUADS_GCP_CREDENTIALS_DIR, `${execContext.squad}-sa-key.json`)
    : join(homedir(), '.squads', 'secrets', `${execContext.squad}-sa-key.json`);
  if (existsSync(credPath)) env.GOOGLE_APPLICATION_CREDENTIALS = credPath;

  if (options?.includeOtel) {
    env.OTEL_RESOURCE_ATTRIBUTES = `squads.squad=${execContext.squad},squads.agent=${execContext.agent},squads.task_type=${execContext.taskType},squads.trigger=${execContext.trigger},squads.execution_id=${execContext.executionId}`;
  }

  if (options?.effort) env.CLAUDE_EFFORT = options.effort;
  if (options?.skills && options.skills.length > 0) env.CLAUDE_SKILLS = options.skills.join(',');

  return env;
}

/** Log verbose execution config (shared by foreground and background modes) */
export function logVerboseExecution(config: {
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

// ── Worktree management ──────────────────────────────────────────────

/** Resolve the target repo root from the squad's repo field (e.g. "org/squads-cli" → sibling dir) */
export function resolveTargetRepoRoot(projectRoot: string, squad: Squad | null): string {
  if (!squad?.repo) return projectRoot;
  const repoName = squad.repo.split('/').pop();
  if (!repoName) return projectRoot;
  const candidatePath = join(projectRoot, '..', repoName);
  return existsSync(candidatePath) ? candidatePath : projectRoot;
}

/** Create an isolated worktree for agent execution (Node.js-based, for foreground mode) */
export function createAgentWorktree(projectRoot: string, squadName: string, agentName: string): string {
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
export function cleanupWorktree(
  worktreePath: string,
  projectRoot: string,
  opts: { keepBranch?: boolean } = {},
): void {
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

    // Delete the agent branch (only agent/* branches, safety check).
    // keepBranch preserves harvested-but-unmerged work for manual recovery.
    if (!opts.keepBranch && branchName && branchName.startsWith('agent/')) {
      execSync(`git -C '${projectRoot}' branch -D '${branchName}'`, { stdio: 'pipe' });
    }
  } catch {
    // Non-critical — worktree prune will catch it later
  }
}

// ── Provider work harvest ─────────────────────────────────────────────

export type HarvestOutcome =
  | { outcome: 'in-place' }          // ran in projectRoot directly — nothing to move
  | { outcome: 'nothing' }           // worktree clean, no commits — agent produced no file changes
  | { outcome: 'merged' }            // committed + fast-forwarded into projectRoot
  | { outcome: 'branch-preserved'; branch: string }  // committed but projectRoot diverged/dirty — branch kept
  | { outcome: 'blocked'; detail: string };          // secret/PII scan refused the commit — worktree kept

/**
 * Harvest file changes a non-anthropic executor left in its worktree.
 *
 * Claude agents commit and push their own work (per the gh workflow they are
 * prompted with), so the engine historically never harvested — and provider
 * executors like aider, which only edit files, silently lost ALL output when
 * the worktree was cleaned (#823). This commits whatever the executor wrote
 * (after the same secret/PII scan autoCommitAgentWork uses) and fast-forwards
 * the project root; when that isn't safe the agent branch is preserved and
 * reported instead. Work must never evaporate behind a green run.
 */
export async function harvestProviderWork(
  workDir: string,
  projectRoot: string,
  branchName: string,
  info: { squadName: string; agentName: string; provider: string },
): Promise<HarvestOutcome> {
  if (workDir === projectRoot) return { outcome: 'in-place' };

  const run = (cmd: string, cwd: string) =>
    execSync(cmd, { encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'] });

  // 1. Commit any uncommitted changes the executor left behind
  const dirty = run('git status --porcelain', workDir).trim();
  if (dirty) {
    const botEnv = await getBotGitEnv();
    const env = { ...process.env, ...botEnv };
    execSync('git add -A', { cwd: workDir, env, stdio: 'pipe' });

    // Same guard as autoCommitAgentWork: never commit a leaked credential/PII
    const stagedDiff = execSync('git diff --cached', {
      encoding: 'utf-8', cwd: workDir, maxBuffer: 32 * 1024 * 1024,
    });
    const findings = scanDiff(stagedDiff, { forbidden: loadForbiddenStrings(projectRoot) });
    if (findings.length > 0) {
      try { execSync('git reset', { cwd: workDir, stdio: 'pipe' }); } catch { /* refuse regardless */ }
      return {
        outcome: 'blocked',
        detail: `${findings.length} secret/PII finding(s) — ${summarizeFindings(findings)}`,
      };
    }

    const coAuthor = getCoAuthorTrailer(info.provider);
    const msgFile = join(tmpdir(), `squads-harvest-${Date.now()}.txt`);
    writeFileSync(msgFile, `feat(${info.squadName}/${info.agentName}): agent work via ${info.provider}\n\n${coAuthor}\n`);
    try {
      execSync(`git commit --file "${msgFile}"`, { cwd: workDir, env, stdio: 'pipe' });
    } finally {
      try { unlinkSync(msgFile); } catch { /* ignore */ }
    }
  }

  // 2. Anything to integrate?
  let ahead = '0';
  try {
    ahead = run(`git rev-list --count '${branchName}' '^HEAD'`, projectRoot).trim();
  } catch { /* branch missing — treat as nothing */ }
  if (ahead === '0') return { outcome: 'nothing' };

  // 3. Fast-forward the project root. --ff-only refuses on divergence and
  //    aborts (preserving local changes) rather than producing a merge state.
  try {
    execSync(`git merge --ff-only '${branchName}'`, { cwd: projectRoot, stdio: 'pipe' });
    return { outcome: 'merged' };
  } catch {
    return { outcome: 'branch-preserved', branch: branchName };
  }
}

// ── Detached execution helpers ───────────────────────────────────────

/** Build shell script for detached execution with worktree isolation */
export function buildDetachedShellScript(config: {
  projectRoot: string;
  squadName: string;
  agentName: string;
  timestamp: number;
  claudeModelAlias?: string;
  escapedPrompt: string;
  logFile: string;
  pidFile: string;
  /** Dispatch project root (where executions.jsonl lives) + run identity for the spool done-file (hq#450 D1). */
  obsRoot?: string;
  executionId?: string;
  trigger?: string;
  /** Watchdog cap for the executor (hq#450 D3). */
  timeoutMinutes?: number;
}): string {
  const modelFlag = config.claudeModelAlias ? `--model ${config.claudeModelAlias}` : '';
  const branchName = `agent/${config.squadName}/${config.agentName}-${config.timestamp}`;
  const worktreeDir = `${config.projectRoot}/../.worktrees/${config.squadName}-${config.agentName}-${config.timestamp}`;
  const cleanup = `if [ "\${WORK_DIR}" != '${config.projectRoot}' ]; then git -C '${config.projectRoot}' worktree remove "\${WORK_DIR}" --force 2>/dev/null; BRANCH='${branchName}'; git -C '${config.projectRoot}' branch -D "\${BRANCH}" 2>/dev/null; fi`;
  // Spool done-file: the wrapper outlives the CLI, so it records completion
  // facts itself; the next CLI invocation reconciles them into observability.
  const timeoutFlag = `${config.pidFile}.timeout`;
  const spool = config.obsRoot && config.executionId
    ? buildSpoolWriterShell({
        obsRoot: config.obsRoot,
        execId: config.executionId,
        squad: config.squadName,
        agent: config.agentName,
        provider: 'anthropic',
        model: config.claudeModelAlias || '',
        trigger: config.trigger || 'manual',
        logFile: config.logFile,
        timeoutFlag,
      })
    : '';
  const executorCmd = `claude --print --dangerously-skip-permissions --disable-slash-commands ${modelFlag} -- '${config.escapedPrompt}' > '${config.logFile}' 2>&1`;
  const watchdogSecs = Math.max(1, Math.round((config.timeoutMinutes || 15) * 60));
  const script = `mkdir -p '${config.projectRoot}/../.worktrees'; WORK_DIR='${config.projectRoot}'; if git -C '${config.projectRoot}' worktree add '${worktreeDir}' -b '${branchName}' HEAD 2>/dev/null; then WORK_DIR='${worktreeDir}'; fi; cd "\${WORK_DIR}"; unset CLAUDECODE; ${buildWatchdogShell(executorCmd, watchdogSecs, timeoutFlag)}; ${cleanup}${spool}`;
  return `echo $$ > '${config.pidFile}'; START=$(date +%s); ${script}`;
}

/** Prepare log directory and file paths for detached execution */
export function prepareLogFiles(projectRoot: string, squadName: string, agentName: string, timestamp: number): { logDir: string; logFile: string; pidFile: string } {
  const logDir = join(projectRoot, '.agents', 'logs', squadName);
  const logFile = join(logDir, `${agentName}-${timestamp}.log`);
  const pidFile = join(logDir, `${agentName}-${timestamp}.pid`);

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  return { logDir, logFile, pidFile };
}

// ── Execution modes ──────────────────────────────────────────────────

/** Execute Claude in foreground mode (direct stdio, default) */
export function executeForeground(config: {
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

  // Snapshot goals before execution
  const goalsBefore = snapshotGoals(config.squadName);

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', config.claudeArgs, {
      stdio: 'inherit',
      cwd: workDir,
      env: config.agentEnv,
    });

    claude.on('close', async (code) => {
      const durationMs = Date.now() - config.startMs;

      // Capture token usage from Claude Code's session JSONL
      const sessionUsage = captureSessionUsage(config.startMs);

      // Snapshot goals after execution and diff
      const goalsAfter = snapshotGoals(config.squadName);
      const goalsChanged = diffGoals(goalsBefore, goalsAfter);

      const obsRecord: ObservabilityRecord = {
        ts: new Date().toISOString(),
        id: config.execContext.executionId,
        squad: config.squadName,
        agent: config.agentName,
        provider: config.provider || 'anthropic',
        model: sessionUsage?.model || config.agentEnv.SQUADS_MODEL || 'unknown',
        trigger: (config.execContext.trigger || 'manual') as ObservabilityRecord['trigger'],
        status: code === 0 ? 'completed' : 'failed',
        duration_ms: durationMs,
        input_tokens: sessionUsage?.input_tokens || 0,
        output_tokens: sessionUsage?.output_tokens || 0,
        cache_read_tokens: sessionUsage?.cache_read_tokens || 0,
        cache_write_tokens: sessionUsage?.cache_write_tokens || 0,
        cost_usd: sessionUsage?.cost_usd || 0,
        context_tokens: 0,
        error: code !== 0 ? `Claude exited with code ${code}` : undefined,
        goals_before: Object.keys(goalsBefore).length > 0 ? goalsBefore : undefined,
        goals_after: Object.keys(goalsAfter).length > 0 ? goalsAfter : undefined,
        goals_changed: goalsChanged.length > 0 ? goalsChanged : undefined,
      };
      logObservability(obsRecord);

      if (code === 0) {
        updateExecutionStatus(config.squadName, config.agentName, config.execContext.executionId, 'completed', {
          outcome: `Session completed (${sessionUsage?.input_tokens || 0} in / ${sessionUsage?.output_tokens || 0} out, $${(sessionUsage?.cost_usd || 0).toFixed(3)})`,
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

      logObservability({
        ts: new Date().toISOString(),
        id: config.execContext.executionId,
        squad: config.squadName,
        agent: config.agentName,
        provider: config.provider || 'anthropic',
        model: 'unknown',
        trigger: (config.execContext.trigger || 'manual') as ObservabilityRecord['trigger'],
        status: 'failed',
        duration_ms: durationMs,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
        cost_usd: 0, context_tokens: 0,
        error: String(err),
      });

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
export async function executeWatch(config: {
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

// ── Main execution functions ─────────────────────────────────────────

export async function executeWithClaude(
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
  // Priority: 1) CLI --model flag  2) agent frontmatter model:  3) SQUAD.md model routing
  const squad = squadName !== 'unknown' ? loadSquad(squadName) : null;
  const mcpConfigPath = selectMcpConfig(squadName, squad);

  // Merge CLI --skills flag with SQUAD.md context.skills
  const squadSkills = squad?.context?.skills || [];
  const mergedSkills = [...new Set([...(skills || []), ...squadSkills])];
  const taskType = detectTaskType(agentName);

  // Read agent frontmatter model if no explicit CLI flag
  let effectiveModel = model;
  if (!effectiveModel) {
    const squadsDir = findSquadsDir();
    if (squadsDir) {
      const agentPath = join(squadsDir, squadName, `${agentName}.md`);
      const frontmatter = parseAgentFrontmatter(agentPath);
      if (frontmatter.model) {
        effectiveModel = frontmatter.model;
      }
    }
  }

  const resolvedModel = resolveModel(effectiveModel, squad, taskType);
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
        effort, skills: mergedSkills, resolvedModel, claudeModelAlias, explicitModel: model,
      });
    }

    // Build claude args as array to avoid shell escaping issues with large prompts
    const claudeArgs: string[] = [];
    if (!process.stdin.isTTY) claudeArgs.push('--print');

    // Permission model: scoped allowed tools instead of blanket skip
    // Agents can: read/write files, run git/gh/npm/bash, use tools
    // Agents cannot: bypass to arbitrary system access
    if (process.env.SQUADS_SKIP_PERMISSIONS === '1') {
      // Explicit opt-in for sandboxed environments (Docker, CI)
      claudeArgs.push('--dangerously-skip-permissions');
    } else {
      claudeArgs.push('--allowedTools',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'Bash(git:*)', 'Bash(gh:*)', 'Bash(npm:*)', 'Bash(npx:*)',
        'Bash(node:*)', 'Bash(python3:*)', 'Bash(curl:*)',
        'Bash(docker:*)', 'Bash(duckdb:*)',
        'Bash(bq:*)', 'Bash(gcloud:*)',
        'Bash(gws:*)', 'Bash(stripe:*)',
        'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',
        'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
        'Bash(echo:*)', 'Bash(chmod:*)', 'Bash(date:*)',
        'Bash(squads:*)',
        'Agent', 'WebFetch', 'WebSearch',
      );
    }
    claudeArgs.push('--disable-slash-commands');
    if (mcpConfigPath) claudeArgs.push('--mcp-config', mcpConfigPath);
    // Inject guardrail PreToolUse hooks so spawned sessions inherit destructive-command guards.
    // P2 (opt-in via SQUADS_SANDBOX=1): additionally run the agent inside Claude Code's OS
    // sandbox (Seatbelt/bubblewrap) — FS isolation (write = worktree + memory) + denyRead
    // of credential dirs + a network domain allowlist — merging the guardrail hooks in.
    const guardrailPath = resolveGuardrailSettings(targetRepoRoot);
    if (sandboxEnabled()) {
      const memDir = findMemoryDir();
      const settings = buildSandboxSettings({
        cwd: targetRepoRoot,
        writeScope: memDir ? [memDir] : [],
        guardrailHooks: readGuardrailHooks(guardrailPath),
        guardrailPermissions: readGuardrailPermissions(guardrailPath),
      });
      const settingsPath = writeSandboxSettingsFile(settings, join(targetRepoRoot, '.git'));
      claudeArgs.push('--settings', settingsPath);
    } else if (guardrailPath) {
      claudeArgs.push('--settings', guardrailPath);
    }
    if (claudeModelAlias) claudeArgs.push('--model', claudeModelAlias);
    claudeArgs.push('--', prompt);

    const agentEnv = buildAgentEnv(spawnEnv as Record<string, string>, execContext, {
      effort, skills: mergedSkills, includeOtel: true, ghToken: botGhToken,
    });
    // P2: native subprocess credential scrub (strips Anthropic/cloud creds from bash children).
    if (sandboxEnabled()) agentEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';

    return executeForeground({
      prompt, claudeArgs, agentEnv, projectRoot: targetRepoRoot,
      squadName, agentName, execContext, startMs, provider,
    });
  }

  // ── Detached modes (watch + background) ──────────────────────────────
  const timestamp = Date.now();
  const { logFile, pidFile } = prepareLogFiles(projectRoot, squadName, agentName, timestamp);
  const agentEnv = buildAgentEnv(spawnEnv as Record<string, string>, execContext, {
    effort, skills: mergedSkills, includeOtel: !runInWatch, ghToken: botGhToken,
  });

  const envTimeout = Number(process.env.SQUADS_AGENT_TIMEOUT_MINUTES);
  const watchdogMinutes = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : _timeoutMinutes;
  const wrapperScript = buildDetachedShellScript({
    projectRoot: targetRepoRoot, squadName, agentName, timestamp,
    claudeModelAlias, escapedPrompt, logFile, pidFile,
    obsRoot: projectRoot, executionId: execContext.executionId, trigger,
    timeoutMinutes: watchdogMinutes,
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
      effort, skills: mergedSkills, resolvedModel, claudeModelAlias,
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
export async function executeWithProvider(
  provider: string,
  prompt: string,
  options: {
    verbose?: boolean;
    foreground?: boolean;
    cwd?: string;
    squadName?: string;
    agentName?: string;
    model?: string;
    executionId?: string;
    trigger?: ExecutionContext['trigger'];
    startMs?: number;
    timeoutMinutes?: number;
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

  const buildOpts = options.model ? { model: options.model } : undefined;
  const args = cliConfig.buildArgs(effectivePrompt, buildOpts);

  if (options.verbose) {
    writeLine(`  ${colors.dim}Provider: ${cliConfig.displayName}${RESET}`);
    writeLine(`  ${colors.dim}Command: ${cliConfig.command} ${args.join(' ').slice(0, VERBOSE_COMMAND_MAX_CHARS)}...${RESET}`);
    writeLine(`  ${colors.dim}CWD: ${workDir}${RESET}`);
    if (workDir !== projectRoot) {
      writeLine(`  ${colors.dim}Worktree: ${branchName}${RESET}`);
    }
    if (cliConfig.stdinPrompt) {
      writeLine(`  ${colors.dim}Prompt delivery: stdin${RESET}`);
    }
  }

  // Foreground mode: run directly in terminal
  if (options.foreground) {
    return new Promise((resolve, reject) => {
      // When the provider prints usage (aider et al), pipe output through so
      // it can be parsed for observability — still streamed live to the user.
      const captureUsage = typeof cliConfig.parseUsage === 'function';
      const proc = spawn(cliConfig.command, args, {
        stdio: captureUsage
          ? [cliConfig.stdinPrompt ? 'pipe' : 'inherit', 'pipe', 'pipe']
          : cliConfig.stdinPrompt ? ['pipe', 'inherit', 'inherit'] : 'inherit',
        cwd: workDir,
        env: providerEnv,
      });

      // Tail buffer for usage parsing (cap to keep memory bounded)
      const OUTPUT_TAIL_MAX = 256 * 1024;
      let outputTail = '';
      if (captureUsage) {
        const append = (chunk: Buffer) => {
          outputTail = (outputTail + chunk.toString('utf-8')).slice(-OUTPUT_TAIL_MAX);
        };
        proc.stdout?.on('data', (c: Buffer) => { process.stdout.write(c); append(c); });
        proc.stderr?.on('data', (c: Buffer) => { process.stderr.write(c); append(c); });
      }

      // For stdinPrompt providers (e.g. Ollama), pipe the prompt via stdin
      if (cliConfig.stdinPrompt && proc.stdin) {
        proc.stdin.write(effectivePrompt);
        proc.stdin.end();
      }

      proc.on('close', async (code) => {
        // Observability: every run gets a record, whatever the provider (#824).
        // Token/cost figures come from the provider's own output when parseable.
        const startMs = options.startMs || timestamp;
        const usage = captureUsage ? cliConfig.parseUsage!(outputTail) : null;
        logObservability({
          ts: new Date().toISOString(),
          id: options.executionId || generateExecutionId(),
          squad: squadName,
          agent: agentName,
          provider,
          model: options.model || 'unknown',
          trigger: (options.trigger || 'manual') as ObservabilityRecord['trigger'],
          status: code === 0 ? 'completed' : 'failed',
          duration_ms: Date.now() - startMs,
          input_tokens: usage?.input_tokens || 0,
          output_tokens: usage?.output_tokens || 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: usage?.cost_usd || 0,
          context_tokens: 0,
          error: code !== 0 ? `${cliConfig.command} exited with code ${code}` : undefined,
        });
        if (usage && options.verbose) {
          writeLine(`  ${colors.dim}Usage: ${usage.input_tokens} in / ${usage.output_tokens} out, $${usage.cost_usd.toFixed(4)}${RESET}`);
        }
        // Harvest regardless of exit code — partial work from a failed run
        // must not evaporate either.
        let harvest: HarvestOutcome = { outcome: 'in-place' };
        try {
          harvest = await harvestProviderWork(workDir, projectRoot, branchName, {
            squadName, agentName, provider,
          });
        } catch (e) {
          writeLine(`  ${colors.yellow}warn: harvest failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
        }

        switch (harvest.outcome) {
          case 'merged':
            writeLine(`  ${colors.green}Harvested agent work${RESET} ${colors.dim}(fast-forwarded ${branchName})${RESET}`);
            cleanupWorktree(workDir, projectRoot);
            break;
          case 'branch-preserved':
            writeLine(`  ${colors.yellow}Agent work preserved on branch ${harvest.branch}${RESET}`);
            writeLine(`  ${colors.dim}Project root diverged or has conflicting changes — merge manually: git merge ${harvest.branch}${RESET}`);
            cleanupWorktree(workDir, projectRoot, { keepBranch: true });
            break;
          case 'blocked':
            writeLine(`  ${colors.red}Harvest blocked: ${harvest.detail}${RESET}`);
            writeLine(`  ${colors.dim}Worktree kept for inspection: ${workDir}${RESET}`);
            break; // keep worktree AND branch — nothing is lost, nothing leaks
          default:
            cleanupWorktree(workDir, projectRoot);
        }

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
  // Detached harvest (shell equivalent of harvestProviderWork): commit whatever
  // the executor wrote, fast-forward the project root, and only delete the
  // agent branch when its work is integrated or empty — never lose output.
  // Author = the user's git identity (same as the TS-side harvest), with the
  // provider co-author trailer marking machine authorship; a neutral local
  // identity is the fallback ONLY when no git identity is configured (#837).
  const harvestMsg = `-m 'feat(${squadName}/${agentName}): agent work via ${provider}' -m '${getCoAuthorTrailer(provider)}'`;
  const cleanupCmd = workDir !== projectRoot
    ? `; git -C '${workDir}' add -A 2>/dev/null` +
      `; { git -C '${workDir}' commit ${harvestMsg}` +
      ` || git -C '${workDir}' -c user.name='squads-agent' -c user.email='squads-agent@localhost' commit ${harvestMsg}; } >/dev/null 2>&1` +
      `; KEEP_BRANCH=''; HARVEST=none` +
      `; if [ "$(git -C '${projectRoot}' rev-list --count '${branchName}' '^HEAD' 2>/dev/null)" != "0" ]; then` +
      ` { git -C '${projectRoot}' merge --ff-only '${branchName}' >/dev/null 2>&1 && HARVEST=merged; } || { KEEP_BRANCH=1; HARVEST=preserved; }; fi` +
      `; git -C '${projectRoot}' worktree remove '${workDir}' --force 2>/dev/null` +
      `; if [ -z "$KEEP_BRANCH" ]; then git -C '${projectRoot}' branch -D '${branchName}' 2>/dev/null;` +
      ` else echo "agent work preserved on branch ${branchName} (merge manually)" >> '${logFile}'; fi`
    : '';
  // Spool done-file (hq#450 D1): record completion facts for the reconcile
  // sweep — the CLI that spawned this wrapper is long gone when it finishes.
  const timeoutFlag = `${pidFile}.timeout`;
  const spoolCmd = options.executionId
    ? buildSpoolWriterShell({
        obsRoot: getProjectRoot(),
        execId: options.executionId,
        squad: squadName,
        agent: agentName,
        provider,
        model: options.model || '',
        trigger: options.trigger || 'manual',
        logFile,
        timeoutFlag,
      })
    : '';
  const envTimeout = Number(process.env.SQUADS_AGENT_TIMEOUT_MINUTES);
  const watchdogMinutes = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : (options.timeoutMinutes || 15);
  const executorCmd = `${cliConfig.command} ${providerArgs} > '${logFile}' 2>&1`;
  const shellScript = `cd '${workDir}' || exit 1; ${buildWatchdogShell(executorCmd, Math.round(watchdogMinutes * 60), timeoutFlag)}${cleanupCmd}${spoolCmd}`;
  const wrapperScript = `echo $$ > '${pidFile}'; START=$(date +%s); ${shellScript}`;

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
