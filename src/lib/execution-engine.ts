/**
 * Execution engine: agent spawning, worktree management, and provider dispatch.
 * Extracted from commands/run.ts to separate execution mechanics from command logic.
 */

import { track } from './telemetry.js';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
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
import { parseAgentFrontmatter, type ContextStats } from './run-context.js';
import { ExecEventFlusher, ExecEventWriter, createClaudeStreamJsonAdapter, createOpencodeStreamJsonAdapter, deriveRootRunId, execEventsFile } from './exec-events.js';
import { compileAllowedTools } from './agent-contract.js';
import {
  type ExecutionContext,
  defaultTimeoutForRole,
} from './run-types.js';
import {
  selectMcpConfig,
  detectTaskType,
  getClaudeModelAlias,
  resolveModel,
  getProjectRoot,
  generateExecutionId,
  checkClaudeCliAvailable,
  checkClaudeAuthenticated,
} from './run-utils.js';
import {
  registerContextWithBridge,
  updateExecutionStatus,
} from './execution-log.js';
import { logObservability, logRunStarted, captureSessionUsage, snapshotGoals, diffGoals, type ObservabilityRecord } from './observability.js';
import { parseStreamJson, parseOpencodeJson, parseOpencodeLine, StreamJsonAccumulator } from './stream-json.js';
import { findMemoryDir } from './memory.js';
import { buildSpoolWriterShell, buildWatchdogShell } from './spool.js';
import { detectProviderFromModel } from './providers.js';
import { getBridgeUrl } from './env-config.js';
import { getBotGitEnv, getBotPushUrl, getCoAuthorTrailer, getBotGhEnv, buildBotGitCredentialEnv, isGhAuthFailure } from './github.js';
import { scanDiff, loadForbiddenStrings, summarizeFindings } from './secret-scan.js';
import { detectProviderFatalError } from './llm-clis.js';
import {
  buildSandboxSettings, readGuardrailHooks, readGuardrailPermissions, resolveSettingsDir, writeSandboxSettingsFile, sandboxEnabled, sandboxStrict,
} from './sandbox-settings.js';
import { buildWorktreeGuardHooks, mergeHooks, writeWorktreeGuardScript } from './worktree-guard.js';
import {
  colors,
  RESET,
  icons,
  writeLine,
} from './terminal.js';
import {
  getCLIConfig,
  isProviderCLIAvailable,
  commandExists,
} from './llm-clis.js';
import { gitIdentityArgs } from './git.js';
import { reportExecutionStart, reportExecutionComplete } from './api-client.js';

// ── Operational constants (no magic numbers) ──────────────────────────
export const VERIFICATION_STATE_MAX_CHARS = 2000;
export const VERIFICATION_EXEC_TIMEOUT_MS = 30000;
export const LOG_FILE_INIT_DELAY_MS = 500;
export const VERBOSE_COMMAND_MAX_CHARS = 50;
/** Cap on the dispatch task text reported to the API as the execution's brief (#1131). */
export const TASK_BRIEF_MAX_CHARS = 500;
/** Cap on the ledger brief (#1165) — shorter than TASK_BRIEF_MAX_CHARS to prevent PII leakage in user-facing surfaces. */
export const BRIEF_MAX_CHARS = 200;

/**
 * The default agent tool surface — the compiler fallback when an agent
 * declares no explicit contract grants (#920). Shared by the foreground and
 * detached spawn paths so P1 closes the detached bypass with the SAME proven
 * surface foreground runs have exercised for months.
 */
export const DEFAULT_AGENT_TOOLS: string[] = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash(git:*)', 'Bash(gh:*)', 'Bash(npm:*)', 'Bash(npx:*)',
  'Bash(node:*)', 'Bash(python3:*)', 'Bash(curl:*)',
  'Bash(bash:*)', 'Bash(sh:*)', // agents run their own helper scripts (e.g. an agent's watchlist.sh)
  'Bash(docker:*)', 'Bash(duckdb:*)',
  'Bash(bq:*)', 'Bash(gcloud:*)',
  'Bash(gws:*)', 'Bash(stripe:*)',
  'Bash(ls:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)',
  'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)',
  'Bash(echo:*)', 'Bash(chmod:*)', 'Bash(date:*)',
  'Bash(squads:*)',
  'Agent', 'WebFetch', 'WebSearch',
];

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
  /**
   * Executor harness override (#1177). 'opencode' reroutes an anthropic-model
   * run through `opencode run` instead of the claude CLI. Defaults from
   * SQUADS_HARNESS; independent of this, a missing claude binary auto-falls
   * back to opencode when installed (anti-lock-in).
   */
  harness?: string;
  /** Task directive — `<repo>#<n>` refs route the run to an also_owns repo (#1092) */
  task?: string;
  /** Assembly-time context stats from gatherSquadContext — emitted as the run's `context_assembled` event (#902). */
  contextStats?: ContextStats;
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

    // Commit using --file to avoid shell interpolation. Repo-scoped fallback
    // identity (#980) when no git identity is configured — GIT_AUTHOR_*/
    // GIT_COMMITTER_* env vars from botEnv (if set) still take precedence.
    const identity = gitIdentityArgs(projectRoot);
    try {
      execSync(`git ${identity} commit --file "${msgFile}"`, execOpts);
    } finally {
      try { unlinkSync(msgFile); } catch { /* ignore */ }
    }

    // Push to origin using bot token. Retries once after re-minting the
    // installation token on an auth failure (#1133): the bot token has a
    // ~1h TTL, and this push runs after the agent's full turn, so a long
    // turn can outlive it. `spawnSync` never throws on a failed push (only
    // on a spawn-level error) — the status/stderr must be checked explicitly.
    try {
      const { spawnSync } = await import('child_process');
      const repo = detectGitHubRepo(projectRoot);
      // Validate repo format (org/name) to prevent injection
      const validRepo = repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : undefined;

      const pushOnce = async (forceRefresh: boolean) => {
        const pushUrl = validRepo ? await getBotPushUrl(validRepo, { forceRefresh }) : null;
        return spawnSync('git', ['push', pushUrl ?? 'origin', 'HEAD'], { ...execOpts, stdio: 'pipe' });
      };

      let result = await pushOnce(false);
      let stderr = result.stderr?.toString('utf-8') ?? result.error?.message ?? '';
      if (result.status !== 0 && validRepo && isGhAuthFailure(stderr)) {
        result = await pushOnce(true);
        stderr = result.stderr?.toString('utf-8') ?? result.error?.message ?? '';
      }
      if (result.status !== 0) {
        writeLine(`  ${colors.dim}warn: git push failed (commit is still local): ${stderr}${RESET}`);
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

// Cached for the process lifetime (#956): a multi-agent run calls this once
// per spawn, but the login state can't change mid-process, so probe once.
let cachedAuthProbe: boolean | null = null;

/**
 * Pre-flight check for the executor (Claude Code or other provider CLI).
 * Runs once at the start of `squads run` before any agent execution.
 * Checks:
 *   1. CLI binary is available on PATH
 *   2. For Anthropic without an API key: the CLI is actually logged in (#956)
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
    writeLine(`  ${colors.dim}Or pick another provider: squads providers${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Skip this check: SQUADS_SKIP_CHECKS=1 squads run ...${RESET}`);
    writeLine();
    return false;
  }

  // --- Check 2: Claude authentication (#956) ---
  // Skipped when ANTHROPIC_API_KEY is set — the CLI will use it directly.
  // Otherwise probe once (cached): an env/file-based check caused false
  // warnings for OAuth/keychain users (#520), so this reads the CLI's own
  // "not logged in" response instead of inferring auth from files/env.
  if (isAnthropic && !process.env.ANTHROPIC_API_KEY) {
    if (cachedAuthProbe === null) {
      cachedAuthProbe = checkClaudeAuthenticated();
    }

    if (!cachedAuthProbe) {
      writeLine();
      writeLine(`  ${icons.error} ${colors.red}Claude is installed but not logged in — run: claude /login${RESET}`);
      void track('journey.run.blocked', { reason: 'not_logged_in' }); // funnel drop instrument (#964)
      writeLine();
      return false;
    }
  }

  return true;
}

// ── Environment & logging helpers ────────────────────────────────────

/** Build agent environment variables for Claude execution */
export function buildAgentEnv(
  baseEnv: Record<string, string>,
  execContext: ExecutionContext,
  options?: {
    effort?: EffortLevel;
    skills?: string[];
    includeOtel?: boolean;
    ghToken?: string;
    /** GIT_CONFIG_* env from buildBotGitCredentialEnv() — keeps the spawned
     *  agent's own `git push` authenticated past the token's ~1h TTL (#1133). */
    gitCredentialEnv?: Record<string, string>;
  }
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
    // Audit chain (#920): the root anchors aggregate cost/traceability across
    // nested dispatches (an agent running `squads run` inherits these). Root
    // propagates unchanged; parent is always the run doing THIS spawn.
    // #1181: a dispatch from inside an interactive Claude Code session roots
    // at that session's own run record (sess_<id>) — shared derivation with
    // the event writer and the observability reporter, so all three stamping
    // sites agree. Explicit SQUADS_ROOT_RUN_ID keeps precedence.
    SQUADS_ROOT_RUN_ID: deriveRootRunId(baseEnv) || execContext.executionId,
    SQUADS_PARENT_RUN_ID: execContext.executionId,
    BRIDGE_API: getBridgeUrl(),
  };

  // Inject bot GH_TOKEN so agents create PRs/issues as the bot identity,
  // not the user's personal gh auth. This enables founder to review/approve.
  if (options?.ghToken) env.GH_TOKEN = options.ghToken;

  // Live-refreshing git credential helper (#1133) — see buildBotGitCredentialEnv.
  if (options?.gitCredentialEnv) Object.assign(env, options.gitCredentialEnv);

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

/**
 * Resolve the target repo root from the squad's repo field (e.g. "org/squads-cli" → sibling dir).
 * A `<repo>#<n>` ref in the task directive may reroute to an `also_owns` repo (#1092) —
 * allowlisted to [repo, ...also_owns], never an arbitrary repo named in the task.
 */
export function resolveTargetRepoRoot(projectRoot: string, squad: Squad | null, task?: string): string {
  if (!squad?.repo) return projectRoot;
  if (task) {
    const owned = [squad.repo, ...(squad.also_owns ?? [])];
    // cli#1121: an EXPLICIT repo marker ("repo <owner>/<name>", "in repo X",
    // "target repo: X") beats issue-ref order — a task like "work repo-B#180
    // (app side, repo repo-A)" used to bind to repo-B because the first
    // owner/repo#N token won, wasting a full lane run on the wrong sandbox.
    // Same allowlist discipline: a marker naming a repo the squad does NOT
    // own is ignored, never routed to.
    const marker = task.match(/(?:\bin\s+repo|\btarget\s+repo|\brepo)[:\s]+([\w.-]+\/[\w.-]+)/i);
    if (marker) {
      const [mOrg, mName] = [marker[1].slice(0, marker[1].lastIndexOf('/')), marker[1].split('/').pop()!];
      const hit = owned.find((o) => {
        const slash = o.lastIndexOf('/');
        const [oOrg, oName] = slash === -1 ? [undefined, o] : [o.slice(0, slash), o.slice(slash + 1)];
        return oName === mName && (!oOrg || oOrg === mOrg);
      });
      if (hit) {
        const candidate = join(projectRoot, '..', hit.split('/').pop()!);
        if (existsSync(candidate)) return candidate;
      }
    }
    for (const ref of task.matchAll(/(?:([\w.-]+)\/)?([\w.-]+)#\d+/g)) {
      const [, refOrg, refName] = ref;
      const hit = owned.find((o) => {
        const slash = o.lastIndexOf('/');
        const [oOrg, oName] = slash === -1 ? [undefined, o] : [o.slice(0, slash), o.slice(slash + 1)];
        return oName === refName && (!refOrg || !oOrg || refOrg === oOrg);
      });
      if (!hit) continue; // ref to a repo this squad doesn't own — ignore
      const candidate = join(projectRoot, '..', hit.split('/').pop()!);
      if (existsSync(candidate)) return candidate;
      // owned but not checked out as a sibling — a later owned ref may still match
    }
  }
  const repoName = squad.repo.split('/').pop();
  if (!repoName) return projectRoot;
  const candidatePath = join(projectRoot, '..', repoName);
  return existsSync(candidatePath) ? candidatePath : projectRoot;
}

/** All repo roots a squad may operate in: primary repo + existing also_owns sibling dirs (#1092) */
export function resolveOwnedRepoRoots(projectRoot: string, squad: Squad | null): string[] {
  const roots = [resolveTargetRepoRoot(projectRoot, squad)];
  for (const owned of squad?.also_owns ?? []) {
    const name = owned.split('/').pop();
    if (!name) continue;
    const candidate = join(projectRoot, '..', name);
    if (existsSync(candidate)) roots.push(candidate);
  }
  return roots;
}

/** Whether a compiled tool surface grants gh — i.e. the agent is expected to
 * open PRs/comment on issues, so a dead bot mint means a wasted run (cli#1150). */
export function toolsRequireGh(tools: string[]): boolean {
  return tools.some((t) => /^Bash\(gh([ :]|\))/.test(t));
}

/** Create an isolated worktree for agent execution (Node.js-based, for foreground mode) */
export function createAgentWorktree(projectRoot: string, squadName: string, agentName: string): string {
  const timestamp = Date.now();
  const branchName = `agent/${squadName}/${agentName}-${timestamp}`;
  const worktreePath = join(projectRoot, '..', '.worktrees', `${squadName}-${agentName}-${timestamp}`);

  try {
    mkdirSync(join(projectRoot, '..', '.worktrees'), { recursive: true });
    const identity = gitIdentityArgs(projectRoot);
    execSync(`git ${identity} worktree add '${worktreePath}' -b '${branchName}' HEAD`, { cwd: projectRoot, stdio: 'pipe' });
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

// #1076 thresholds: a file losing ≥50 lines with <10% of them replaced reads
// as a corrupted whole-file edit; legitimate refactors add back comparable volume.
const TRUNCATION_MIN_DELETED_LINES = 50;
const TRUNCATION_REPLACEMENT_RATIO = 0.1;

export type HarvestOutcome =
  | { outcome: 'in-place' }          // ran in projectRoot directly — nothing to move
  | { outcome: 'nothing' }           // worktree clean, no commits — agent produced no file changes
  | { outcome: 'branch-preserved'; branch: string }  // committed to the agent branch — the only landing path (#966)
  | { outcome: 'blocked'; detail: string }           // secret/PII scan refused the commit — worktree kept
  | { outcome: 'suspect'; branch: string; detail: string };  // mass deletion without replacement (#1076) — branch kept, run marked failed

/**
 * Harvest file changes a non-anthropic executor left in its worktree.
 *
 * Claude agents commit and push their own work (per the gh workflow they are
 * prompted with), so the engine historically never harvested — and provider
 * executors like aider, which only edit files, silently lost ALL output when
 * the worktree was cleaned (#823). This commits whatever the executor wrote
 * (after the same secret/PII scan autoCommitAgentWork uses) and preserves it
 * on the agent branch — NEVER integrated into the operator's checkout (#966:
 * the old fast-forward path landed unrequested agent commits directly on a
 * host repo's main). The inbox stranded-branch scanner surfaces the branch
 * for a human decision. Work must never evaporate behind a green run — and
 * must never land without one either.
 */
export async function harvestProviderWork(
  workDir: string,
  projectRoot: string,
  branchName: string,
  info: { squadName: string; agentName: string; provider: string },
  /** Paths the HARNESS copied into the worktree (e.g. '.agents' for sandboxed
   *  providers) — furniture, not agent work; excluded from the harvest (#1070). */
  excludePaths: string[] = [],
): Promise<HarvestOutcome> {
  if (workDir === projectRoot) return { outcome: 'in-place' };

  const run = (cmd: string, cwd: string) =>
    execSync(cmd, { encoding: 'utf-8', cwd, stdio: ['pipe', 'pipe', 'pipe'] });

  // Pathspec that hides harness-copied furniture from every work-detection step.
  const excludeSpec = excludePaths
    .map((p) => `':(exclude)${p.replace(/'/g, '')}'`)
    .join(' ');
  const pathspec = excludeSpec ? ` -- . ${excludeSpec}` : '';

  // 1. Commit any uncommitted changes the executor left behind
  const dirty = run(`git status --porcelain${pathspec}`, workDir).trim();
  if (dirty) {
    const botEnv = await getBotGitEnv();
    const env = { ...process.env, ...botEnv };
    execSync(`git add -A${pathspec}`, { cwd: workDir, env, stdio: 'pipe' });

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
    // Repo-scoped fallback identity (#980) when no git identity is configured.
    const identity = gitIdentityArgs(workDir);
    try {
      execSync(`git ${identity} commit --file "${msgFile}"`, { cwd: workDir, env, stdio: 'pipe' });
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

  // 3. Truncation guard (#1076): a file losing nearly everything with almost
  //    nothing added back is a corrupted whole-file edit, not work — aider has
  //    replaced an 826-line file with its 6-line patch fragment and exited 0.
  //    Diff against the branch's fork point (projectRoot HEAD may have moved
  //    during the run) and flag; the inbox gate decides, never auto-land.
  try {
    const base = run(`git merge-base HEAD '${branchName}'`, projectRoot).trim();
    const numstat = run(`git diff --numstat '${base}' '${branchName}'`, projectRoot).trim();
    const gutted: string[] = [];
    for (const row of numstat.split('\n')) {
      const [addStr, delStr, file] = row.split('\t');
      const added = parseInt(addStr, 10);
      const deleted = parseInt(delStr, 10);
      if (!Number.isFinite(added) || !Number.isFinite(deleted)) continue; // binary file
      if (deleted >= TRUNCATION_MIN_DELETED_LINES && added < deleted * TRUNCATION_REPLACEMENT_RATIO) {
        gutted.push(`${file} (-${deleted}/+${added})`);
      }
    }
    if (gutted.length > 0) {
      return {
        outcome: 'suspect',
        branch: branchName,
        detail: `mass deletion without replacement: ${gutted.join(', ')}`,
      };
    }
  } catch { /* diff unavailable — fall through to preserve; the gate still reviews */ }

  // 4. Preserve on the agent branch — integration is a human decision made
  //    through the inbox gate, never a side effect of a run finishing (#966).
  return { outcome: 'branch-preserved', branch: branchName };
}

// ── Detached execution helpers ───────────────────────────────────────

/**
 * Detached-lane shell equivalent of harvestProviderWork (#966/#1126): commit
 * whatever the executor left in workDir and preserve it on the dedicated
 * agent branch — NEVER merge/ff into projectRoot's checked-out branch. The
 * pre-#966 version of this shell path fast-forwarded projectRoot whenever the
 * branch was ahead, silently landing unreviewed agent commits on whatever the
 * operator had checked out; the foreground TS path was fixed by #966 but this
 * detached path was not until #1126. Integration is an inbox decision, never
 * a side effect of a background run finishing — the branch ref is logged
 * loudly to the run's log file so `squads inbox`'s stranded-branch scanner
 * surfaces it. Returns '' when the agent ran in projectRoot directly (nothing
 * to harvest). Exported standalone (mirroring buildDetachedShellScript) so
 * the preserve-only contract can be exercised against a real git repo in
 * tests, the same way harvestProviderWork is.
 */
export function buildDetachedHarvestShell(config: {
  workDir: string;
  projectRoot: string;
  branchName: string;
  squadName: string;
  agentName: string;
  provider: string;
  logFile: string;
}): string {
  if (config.workDir === config.projectRoot) return '';
  // Author = the user's git identity (same as the TS-side harvest); the
  // repo-scoped fallback identity (#980, single source of truth via
  // gitIdentityArgs) applies ONLY when no git identity is configured.
  const harvestMsg = `-m 'feat(${config.squadName}/${config.agentName}): agent work via ${config.provider}' -m '${getCoAuthorTrailer(config.provider)}'`;
  const harvestIdentity = gitIdentityArgs(config.workDir);
  return `; git -C '${config.workDir}' add -A 2>/dev/null` +
    `; git -C '${config.workDir}' ${harvestIdentity} commit ${harvestMsg} >/dev/null 2>&1` +
    `; KEEP_BRANCH=''; HARVEST=none` +
    `; if [ "$(git -C '${config.projectRoot}' rev-list --count '${config.branchName}' '^HEAD' 2>/dev/null)" != "0" ]; then KEEP_BRANCH=1; HARVEST=preserved; fi` +
    `; git -C '${config.projectRoot}' worktree remove '${config.workDir}' --force 2>/dev/null` +
    `; if [ -n "$KEEP_BRANCH" ]; then echo "agent work preserved on branch ${config.branchName} -- review and land it through the gate: squads inbox" >> '${config.logFile}';` +
    ` else git -C '${config.projectRoot}' branch -D '${config.branchName}' 2>/dev/null; fi`;
}

/**
 * Shell snippet writing a detached wrapper's pid file. Line 1 is always the
 * wrapper's pid (unchanged format — `squads runs`/liveness checks read only
 * this line). Line 2, when an executionId is known, is this run's API
 * execution id (#1131) — read back by runs-inventory's cleanStaleRuns() so a
 * wrapper that dies before ever reaching the spool writer can still report
 * its postmortem instead of leaving the API row stuck at 'running' forever.
 */
function buildPidFileWriteCmd(pidFile: string, executionId?: string): string {
  const safeExecId = executionId ? executionId.replace(/[^A-Za-z0-9_-]/g, '') : '';
  return safeExecId
    ? `printf '%s\\n%s\\n' "$$" '${safeExecId}' > '${pidFile}'`
    : `echo $$ > '${pidFile}'`;
}

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
  /** Claude session id for this run (#857) — pins the session JSONL so reconcile attributes exactly this run's usage. */
  sessionId?: string;
  /** Compiled tool allowlist (#920). When present, replaces --dangerously-skip-permissions on the detached executor. */
  allowedTools?: string[];
  /** Settings file for the executor (#780): sandbox + guardrail hooks. Detached runs previously got NEITHER. */
  settingsFile?: string;
}): string {
  const modelFlag = config.claudeModelAlias ? `--model ${config.claudeModelAlias}` : '';
  const settingsFlag = config.settingsFile ? `--settings '${config.settingsFile.replace(/'/g, '')}' ` : '';
  const safeSessionId = config.sessionId ? config.sessionId.replace(/[^A-Za-z0-9-]/g, '') : '';
  const sessionFlag = safeSessionId ? `--session-id ${safeSessionId} ` : '';
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
        sessionId: safeSessionId,
        harness: 'claude',
      })
    : '';
  // stream-json (#902): the detached log is a LIVE event stream instead of a
  // buffer that stays empty until exit — `--print` alone emits nothing until
  // the run ends, which is exactly the black box this kills. `--verbose` is
  // required for stream-json to emit events. The reconcile sweep normalizes
  // this raw log into the run's events file (exec-events.ts).
  //
  // Permissions (#920 / P1): detached runs ran --dangerously-skip-permissions
  // since inception — the last ungoverned spawn surface. They now get the same
  // compiled allowlist as foreground; SQUADS_SKIP_PERMISSIONS=1 remains the
  // explicit sandboxed-environment opt-out (checked by the CALLER, which then
  // omits allowedTools).
  const permissionFlags = config.allowedTools && config.allowedTools.length > 0
    ? `--allowedTools ${config.allowedTools.map((t) => `'${t.replace(/'/g, '')}'`).join(' ')}`
    : '--dangerously-skip-permissions';
  const executorCmd = `claude --print --output-format stream-json --verbose ${permissionFlags} ${settingsFlag}--disable-slash-commands ${sessionFlag}${modelFlag} -- '${config.escapedPrompt}' > '${config.logFile}' 2>&1`;
  const watchdogSecs = Math.max(1, Math.round((config.timeoutMinutes ?? defaultTimeoutForRole()) * 60));
  // Repo-scoped fallback identity (#980) computed once here (TS side) rather
  // than inline in the shell — single source of truth via gitIdentityArgs.
  const identity = gitIdentityArgs(config.projectRoot);
  // cli#1166: worktree creation failure used to SILENTLY fall back to the
  // primary checkout — that's exactly how a lane switched the live
  // checkout's branch under foreign uncommitted work. An autonomous lane
  // never runs in the primary root: fail loud, keep the pid file (the
  // lane-death backstop reports the postmortem, #1131).
  const script = `mkdir -p '${config.projectRoot}/../.worktrees'; if ! git -C '${config.projectRoot}' ${identity} worktree add '${worktreeDir}' -b '${branchName}' HEAD >> '${config.logFile}' 2>&1; then echo 'FATAL: worktree creation failed — refusing to run the lane in the primary checkout (cli#1166)' >> '${config.logFile}'; exit 1; fi; WORK_DIR='${worktreeDir}'; cd "\${WORK_DIR}"; unset CLAUDECODE; ${buildWatchdogShell(executorCmd, watchdogSecs, timeoutFlag)}; ${cleanup}${spool}`;
  // pid file removed on clean wrapper exit — a surviving pid file with a dead
  // pid is the orphan signal `squads runs --clean` keys on (hq#450 D4). Its
  // second line (when known) is this run's API execution id (#1131) — the
  // only way cleanStaleRuns' lane-death backstop can report a postmortem for
  // a wrapper that died before it ever reached the spool writer.
  const pidFileWrite = buildPidFileWriteCmd(config.pidFile, config.executionId);
  // cli#1135: a wrapper segment dying before its own redirect used to leave
  // NO log file — 'exited with code 1' was the whole postmortem. exec-redirect
  // the entire wrapper into the lane log first thing: the log file now exists
  // from the instant the wrapper starts, and every segment's stderr (mkdir,
  // worktree add, cd, executor spawn, spool) lands in it.
  return `${pidFileWrite}; exec >> '${config.logFile}' 2>&1; START=$(date +%s); ${script}; rm -f '${config.pidFile}'`;
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
  task?: string;
  /** Exec-event stream (#902) — run_end/token_usage emitted here on close. */
  events?: ExecEventWriter;
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

    // Run-ledger start event: the close handler below writes the terminal row
    // for the SAME id, so the fold sees running → completed/failed. pid is the
    // spawned claude process — dies with the run, so the orphan reaper can
    // tell "still working" from "crashed without reporting".
    logRunStarted({
      id: config.execContext.executionId,
      squad: config.squadName,
      agent: config.agentName,
      provider: config.provider || 'anthropic',
      model: config.agentEnv.SQUADS_MODEL || 'unknown',
      trigger: (config.execContext.trigger || 'manual') as ObservabilityRecord['trigger'],
      pid: claude.pid,
      brief: config.task?.slice(0, BRIEF_MAX_CHARS),
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
        session_id: sessionUsage?.session_id,
        trigger: (config.execContext.trigger || 'manual') as ObservabilityRecord['trigger'],
        status: code === 0 ? 'completed' : 'failed',
        duration_ms: durationMs,
        input_tokens: sessionUsage?.input_tokens || 0,
        output_tokens: sessionUsage?.output_tokens || 0,
        cache_read_tokens: sessionUsage?.cache_read_tokens || 0,
        cache_write_tokens: sessionUsage?.cache_write_tokens || 0,
        cost_usd: sessionUsage?.cost_usd || 0,
        context_tokens: 0,
        brief: config.task?.slice(0, BRIEF_MAX_CHARS),
        error: code !== 0 ? `Claude exited with code ${code}` : undefined,
        goals_before: Object.keys(goalsBefore).length > 0 ? goalsBefore : undefined,
        goals_after: Object.keys(goalsAfter).length > 0 ? goalsAfter : undefined,
        goals_changed: goalsChanged.length > 0 ? goalsChanged : undefined,
        // Real outcomes parsed from the session JSONL (#1060) — absent when
        // unknown so the scoreboard never ingests fake zeros.
        ...(sessionUsage?.outcomes ? {
          actions: sessionUsage.outcomes.actions,
          files_edited: sessionUsage.outcomes.files_edited,
          commits: sessionUsage.outcomes.commits,
          prs_created: sessionUsage.outcomes.prs_created,
          issues_created: sessionUsage.outcomes.issues_created,
        } : {}),
      };
      logObservability(obsRecord);

      // Exec events (#902): foreground runs use inherited stdio (no stream to
      // tee), so the event record is the aggregate — session usage + outcome.
      if (config.events) {
        config.events.emit({
          type: 'token_usage',
          input: sessionUsage?.input_tokens || 0,
          output: sessionUsage?.output_tokens || 0,
          cacheRead: sessionUsage?.cache_read_tokens || 0,
          cacheWrite: sessionUsage?.cache_write_tokens || 0,
          costEst: sessionUsage?.cost_usd || 0,
          model: sessionUsage?.model || '',
        }, config.agentName);
        config.events.emit({
          type: 'run_end',
          ok: code === 0,
          durationMs,
          totalUsage: {
            input: sessionUsage?.input_tokens || 0,
            output: sessionUsage?.output_tokens || 0,
            cacheRead: sessionUsage?.cache_read_tokens || 0,
            cacheWrite: sessionUsage?.cache_write_tokens || 0,
            costEst: sessionUsage?.cost_usd || 0,
          },
          outcomes: sessionUsage?.outcomes,
        });
        config.events.close();
      }

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
        brief: config.task?.slice(0, BRIEF_MAX_CHARS),
        error: String(err),
      });

      updateExecutionStatus(config.squadName, config.agentName, config.execContext.executionId, 'failed', {
        error: String(err),
        durationMs,
      });
      if (config.events) {
        config.events.emit({
          type: 'run_end',
          ok: false,
          durationMs,
          totalUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costEst: 0 },
        });
        config.events.close();
      }
      cleanupWorktree(workDir, config.projectRoot);
      reject(err);
    });
  });
}

/**
 * Execute Claude in watch mode: background run + LIVE event feed (#903).
 * Since #902 the detached log is a stream-json event stream, so watch renders
 * the human activity feed through the provider adapter instead of raw
 * `tail -f` (which would show JSON). SQUADS_WATCH_RAW=1 restores raw lines.
 */
export async function executeWatch(config: {
  projectRoot: string;
  agentEnv: Record<string, string>;
  logFile: string;
  pidFile?: string;
  wrapperScript: string;
  /** Execution context for spawn-failure reporting (#1157) */
  execContext?: {
    executionId: string;
    squadName: string;
    agentName: string;
    model?: string;
    trigger?: string;
  };
}): Promise<string> {
  const child = spawn('sh', ['-c', config.wrapperScript], {
    cwd: config.projectRoot,
    detached: true,
    stdio: 'ignore',
    env: config.agentEnv,
  });
  child.unref();

  // Spawn-failure handler (#1157): if the wrapper itself fails to start,
  // nothing inside the script runs — no pid file, no spool, no events.
  // Record the failure so the run doesn't disappear from observability.
  child.on('error', (err) => {
    if (config.execContext) {
      const durationMs = Date.now(); // No start timestamp in watch mode
      logObservability({
        ts: new Date().toISOString(),
        id: config.execContext!.executionId,
        squad: config.execContext!.squadName,
        agent: config.execContext!.agentName,
        provider: 'anthropic',
        model: config.execContext!.model || 'unknown',
        trigger: (config.execContext!.trigger || 'manual') as ObservabilityRecord['trigger'],
        status: 'failed',
        duration_ms: durationMs,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_usd: 0,
        context_tokens: 0,
        error: `Failed to spawn watch lane: ${err.message}`,
      });
      updateExecutionStatus(config.execContext!.squadName, config.execContext!.agentName, config.execContext!.executionId, 'failed', {
        error: `Failed to spawn watch lane: ${err.message}`,
        durationMs,
      });
      // Report spawn failure to the API (fire-and-forget)
      void reportExecutionComplete(config.execContext!.executionId, 'failed', {
        error: `Failed to spawn watch lane: ${err.message}`,
        durationMs,
        squad: config.execContext!.squadName,
        agent: config.execContext!.agentName,
      });
    }
  });

  await new Promise(resolve => setTimeout(resolve, LOG_FILE_INIT_DELAY_MS));

  writeLine(`  ${colors.dim}Watching live (Ctrl+C to stop watching, agent continues)...${RESET}`);
  writeLine();

  const { followProviderLog } = await import('./event-follow.js');
  const follower = followProviderLog(config.logFile, { pidFile: config.pidFile });

  process.on('SIGINT', () => {
    follower.stop();
    writeLine();
    writeLine(`  ${colors.dim}Stopped watching. Agent continues in background.${RESET}`);
    writeLine(`  ${colors.dim}Raw log: ${config.logFile}${RESET}`);
    process.exit(0);
  });

  await follower.done;
  writeLine();
  return `Run finished. Log: ${config.logFile}`;
}

// ── Main execution functions ─────────────────────────────────────────

/**
 * Map a resolved anthropic model to opencode's `provider/model` syntax
 * (#1177). Aliases (sonnet/opus/haiku) return undefined — opencode then uses
 * its own configured default model, which never drifts with Claude releases.
 */
function toOpencodeModel(model: string | null | undefined): string | undefined {
  if (!model) return undefined;
  if (model.includes('/')) return model;
  if (/^claude-/i.test(model)) return `anthropic/${model}`;
  return undefined;
}

export async function executeWithClaude(
  prompt: string,
  options: ExecuteWithClaudeOptions
): Promise<string> {
  const {
    verbose,
    timeoutMinutes,
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
  // Unset → per-role default (worker/lead/scanner/verifier); role comes from
  // the caller's context assembly stats when known, else the flat fallback (#941).
  const _timeoutMinutes = timeoutMinutes ?? defaultTimeoutForRole(options.contextStats?.role);

  // Determine execution mode
  const runInBackground = background === true && !watch;
  const runInWatch = watch === true;
  const runInForeground = !runInBackground && !runInWatch;

  const startMs = Date.now();
  const projectRoot = getProjectRoot();
  // #960: the ~/.claude.json trust mutation is GONE — verified unnecessary for
  // headless `claude -p` (2026-07-06 empirical + docs: trust only gates project
  // settings allow-rules, and we pass our own --settings via CLI args).

  // Resolve model and provider
  // Priority: 1) CLI --model flag  2) agent frontmatter model:  3) SQUAD.md model routing
  const squad = squadName !== 'unknown' ? loadSquad(squadName) : null;
  const mcpConfigPath = selectMcpConfig(squadName, squad);

  // Merge CLI --skills flag with SQUAD.md context.skills
  const squadSkills = squad?.context?.skills || [];
  const mergedSkills = [...new Set([...(skills || []), ...squadSkills])];
  const taskType = detectTaskType(agentName);

  // Agent definition path — used for frontmatter model AND contract grants (#920).
  const squadsDirForAgent = findSquadsDir();
  const agentPath = squadsDirForAgent ? join(squadsDirForAgent, squadName, `${agentName}.md`) : '';

  // Read agent frontmatter model if no explicit CLI flag
  let effectiveModel = model;
  if (!effectiveModel && agentPath) {
    const frontmatter = parseAgentFrontmatter(agentPath);
    if (frontmatter.model) {
      effectiveModel = frontmatter.model;
    }
  }

  const resolvedModel = resolveModel(effectiveModel, squad, taskType);
  const provider = resolvedModel ? detectProviderFromModel(resolvedModel) : 'anthropic';

  // Resolve target repo for worktree creation (squad.repo → sibling dir;
  // task refs may reroute to an also_owns repo, #1092)
  const targetRepoRoot = resolveTargetRepoRoot(projectRoot, squad, options.task);

  // Delegate to non-Anthropic providers
  if (provider !== 'anthropic' && provider !== 'unknown') {
    if (verbose) {
      const source = model ? 'explicit' : 'auto-routed';
      writeLine(`  ${colors.dim}Model: ${resolvedModel} (${source})${RESET}`);
      writeLine(`  ${colors.dim}Provider: ${provider}${RESET}`);
    }
    return executeWithProvider(provider, prompt, {
      verbose, foreground, cwd: targetRepoRoot, squadName, agentName, task: options.task,
    });
  }

  // Fallback harness (#1177, anti-lock-in): reroute an anthropic-model run
  // through `opencode run` when explicitly requested (options.harness /
  // SQUADS_HARNESS=opencode) or when the claude binary itself is missing and
  // opencode is installed. Downstream this is the provider path — worktree,
  // spool (harness-stamped), reconcile — with opencode-shaped observability
  // at full parity (cli#1175 contract).
  const requestedHarness = options.harness || process.env.SQUADS_HARNESS || '';
  if (requestedHarness === 'opencode' || !commandExists('claude')) {
    if (commandExists('opencode')) {
      if (requestedHarness !== 'opencode') {
        writeLine(`  ${colors.yellow}claude CLI not found — falling back to the opencode harness (#1177)${RESET}`);
      }
      return executeWithProvider('opencode', prompt, {
        verbose,
        foreground: !(background === true) && !watch,
        cwd: targetRepoRoot,
        squadName,
        agentName,
        model: toOpencodeModel(resolvedModel),
        trigger,
        timeoutMinutes,
        task: options.task,
      });
    }
    if (requestedHarness === 'opencode') {
      throw new Error(`harness 'opencode' requested but the opencode CLI is not installed. Install: ${getCLIConfig('opencode')?.install}`);
    }
    // claude missing, opencode missing — fall through; the claude spawn fails loud.
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

  // Exec-event stream (#902): run_start + context_assembled are written by the
  // CLI at dispatch (only we know the layers); the run's tool activity follows —
  // live for foreground, appended at reconcile for detached (from the raw
  // stream-json log the executor writes).
  const events = new ExecEventWriter(execEventsFile(projectRoot, execContext.executionId), execContext.executionId, {
    source: 'squads-cli',
    provider,
    // Live projection to the connected API (#1158) — file write never blocks on it.
    flusher: new ExecEventFlusher(execContext.executionId),
  });
  events.emit({
    type: 'run_start',
    squad: squadName,
    agent: agentName,
    mode: runInForeground ? 'foreground' : runInWatch ? 'watch' : 'background',
    model: claudeModelAlias || resolvedModel || '',
    role: options.contextStats?.role || '',
    startedAt: new Date(startMs).toISOString(),
  });
  if (options.contextStats) {
    events.emit({
      type: 'context_assembled',
      layers: options.contextStats.layers,
      totalTokensEst: options.contextStats.totalTokensEst,
      budgetTokens: Math.ceil(options.contextStats.budgetChars / 4),
    }, agentName);
  }

  // Get bot token so agents create PRs/issues as bot identity (not user's personal gh auth)
  let botGhToken: string | undefined;
  let mintError: string | undefined;
  try {
    const ghEnv = await getBotGhEnv();
    botGhToken = ghEnv.GH_TOKEN;
  } catch (e) {
    mintError = e instanceof Error ? e.message : String(e);
  }
  // cli#1150: an agent granted Bash(gh:*) is EXPECTED to open PRs / comment
  // on issues. Detached lanes are fresh subprocesses with no interactive gh
  // login — with a failed mint they run their whole budget issuing failing
  // gh calls (or worse, land personal-auth PRs from ambient credentials).
  // Fail at dispatch, not at the end of a wasted run. Foreground keeps the
  // graceful fallback: the operator is present and may have gh auth.
  if (!botGhToken && !runInForeground) {
    const compiledForMint = compileAllowedTools(agentPath, DEFAULT_AGENT_TOOLS);
    if (toolsRequireGh(compiledForMint.tools)) {
      throw new Error(
        `bot token mint failed and this agent's tools include gh (${mintError ?? 'unknown error'}) — ` +
        `a detached lane would burn its whole run on failing gh calls (cli#1150). ` +
        `Fix the GitHub App credentials (~/.squads/secrets/github-app.json) and re-dispatch.`,
      );
    }
  }
  const botGitCredentialEnv = buildBotGitCredentialEnv();

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
      // Contract grants win when the agent declares them; the tuned default
      // surface otherwise (#920 — deny-by-omission where declared).
      const compiled = compileAllowedTools(agentPath, DEFAULT_AGENT_TOOLS);
      if (verbose && compiled.source === 'contract') {
        writeLine(`  ${colors.dim}Tool grants: ${compiled.tools.length} from agent contract${RESET}`);
      }
      claudeArgs.push('--allowedTools', ...compiled.tools);
    }
    claudeArgs.push('--disable-slash-commands');
    if (mcpConfigPath) claudeArgs.push('--mcp-config', mcpConfigPath);
    // Inject guardrail PreToolUse hooks so spawned sessions inherit destructive-command guards.
    // P2 (opt-in via SQUADS_SANDBOX=1): additionally run the agent inside Claude Code's OS
    // sandbox (Seatbelt/bubblewrap) — FS isolation (write = worktree + memory) + denyRead
    // of credential dirs + a network domain allowlist — merging the guardrail hooks in.
    const guardrailPath = resolveGuardrailSettings(targetRepoRoot);
    // Worktree guard (cli#1166/#1153): a per-spawn PreToolUse hook that
    // blocks mutations aimed at the primary checkout. It self-disarms when
    // the session cwd IS the primary root (foreground fallback mode), so
    // injecting it unconditionally is safe.
    const guardScript = writeWorktreeGuardScript(
      targetRepoRoot, resolveSettingsDir(join(targetRepoRoot, '.git')),
    );
    const guardHooks = buildWorktreeGuardHooks(guardScript);
    if (sandboxEnabled()) {
      const memDir = findMemoryDir();
      const settings = buildSandboxSettings({
        cwd: targetRepoRoot,
        writeScope: memDir ? [memDir] : [],
        guardrailHooks: mergeHooks(readGuardrailHooks(guardrailPath), guardHooks),
        guardrailPermissions: readGuardrailPermissions(guardrailPath),
        strict: sandboxStrict(),
      });
      const settingsPath = writeSandboxSettingsFile(settings, join(targetRepoRoot, '.git'));
      claudeArgs.push('--settings', settingsPath);
    } else {
      const settings: Record<string, unknown> = {
        hooks: mergeHooks(readGuardrailHooks(guardrailPath), guardHooks),
      };
      const perms = readGuardrailPermissions(guardrailPath);
      if (perms) settings.permissions = perms;
      claudeArgs.push('--settings', writeSandboxSettingsFile(settings, join(targetRepoRoot, '.git')));
    }
    if (claudeModelAlias) claudeArgs.push('--model', claudeModelAlias);
    claudeArgs.push('--', prompt);

    const agentEnv = buildAgentEnv(spawnEnv as Record<string, string>, execContext, {
      effort, skills: mergedSkills, includeOtel: true, ghToken: botGhToken, gitCredentialEnv: botGitCredentialEnv,
    });
    // P2: native subprocess credential scrub (strips Anthropic/cloud creds from bash children).
    if (sandboxEnabled()) agentEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';

    return executeForeground({
      prompt, claudeArgs, agentEnv, projectRoot: targetRepoRoot,
      squadName, agentName, execContext, startMs, provider, events,
      task: options.task,
    });
  }

  // ── Detached modes (watch + background) ──────────────────────────────
  const timestamp = Date.now();
  // targetRepoRoot, not projectRoot (dispatch root) — pid/log files must land
  // where runs-inventory.ts's inventoryRoots() scans (squad's bound repo), or
  // `squads runs` invoked from the target repo misses live lanes (#1125).
  const { logFile, pidFile } = prepareLogFiles(targetRepoRoot, squadName, agentName, timestamp);
  const agentEnv = buildAgentEnv(spawnEnv as Record<string, string>, execContext, {
    effort, skills: mergedSkills, includeOtel: !runInWatch, ghToken: botGhToken, gitCredentialEnv: botGitCredentialEnv,
  });

  const envTimeout = Number(process.env.SQUADS_AGENT_TIMEOUT_MINUTES);
  const watchdogMinutes = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : _timeoutMinutes;

  // Settings for the detached executor (#780): sandbox (default-on) + guardrail
  // hooks. Detached runs previously received NEITHER — the sandbox flip also
  // brings the governance denylist to the path that needed it most. The file
  // lives in the repo's .git (shared across a repo's runs — same content).
  const detachedGuardrail = resolveGuardrailSettings(targetRepoRoot);
  let detachedSettingsFile: string | undefined;
  // Worktree guard (cli#1166/#1153) — same per-spawn mutation block as
  // foreground; detached lanes are where both escapes actually happened.
  const detachedGuardScript = writeWorktreeGuardScript(
    targetRepoRoot, resolveSettingsDir(join(targetRepoRoot, '.git')),
  );
  const detachedGuardHooks = buildWorktreeGuardHooks(detachedGuardScript);
  if (sandboxEnabled()) {
    const memDirDetached = findMemoryDir();
    const settings = buildSandboxSettings({
      cwd: targetRepoRoot,
      writeScope: memDirDetached ? [memDirDetached] : [],
      guardrailHooks: mergeHooks(readGuardrailHooks(detachedGuardrail), detachedGuardHooks),
      guardrailPermissions: readGuardrailPermissions(detachedGuardrail),
      strict: sandboxStrict(),
    });
    detachedSettingsFile = writeSandboxSettingsFile(settings, join(targetRepoRoot, '.git'));
    agentEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  } else {
    const settings: Record<string, unknown> = {
      hooks: mergeHooks(readGuardrailHooks(detachedGuardrail), detachedGuardHooks),
    };
    const detachedPerms = readGuardrailPermissions(detachedGuardrail);
    if (detachedPerms) settings.permissions = detachedPerms;
    detachedSettingsFile = writeSandboxSettingsFile(settings, join(targetRepoRoot, '.git'));
  }

  const wrapperScript = buildDetachedShellScript({
    projectRoot: targetRepoRoot, squadName, agentName, timestamp,
    claudeModelAlias, escapedPrompt, logFile, pidFile,
    obsRoot: projectRoot, executionId: execContext.executionId, trigger,
    timeoutMinutes: watchdogMinutes,
    sessionId: randomUUID(),
    // #920: same compiled surface as foreground; SQUADS_SKIP_PERMISSIONS=1
    // keeps the legacy bypass for sandboxed environments.
    allowedTools: process.env.SQUADS_SKIP_PERMISSIONS === '1'
      ? undefined
      : compileAllowedTools(agentPath, DEFAULT_AGENT_TOOLS).tools,
    settingsFile: detachedSettingsFile,
  });

  // Detached: run_start/context_assembled are already on disk; the run's tool
  // events are normalized from the raw stream-json log at reconcile (spool.ts).
  events.close();

  // Register run start with the API for background/watch modes (#1100).
  // brief carries the dispatch task text (#1131) — the postmortem "what was
  // this run even for" the app can't answer today without it.
  // Fire-and-forget: never block the dispatch on API reachability
  void reportExecutionStart(squadName, agentName, execContext.executionId, {
    trigger,
    model: claudeModelAlias || resolvedModel,
    brief: options.task?.slice(0, TASK_BRIEF_MAX_CHARS),
  });
  // Ledger start event. No pid: the wrapper's pidFile is the liveness
  // authority for detached runs and reconcileDetachedRuns writes the
  // terminal row; the reaper's 3h fallback covers a vanished pidFile.
  logRunStarted({
    id: execContext.executionId,
    squad: squadName,
    agent: agentName,
    provider: 'anthropic',
    model: claudeModelAlias || resolvedModel || 'unknown',
    trigger: trigger as ObservabilityRecord['trigger'],
    task: options.task?.slice(0, TASK_BRIEF_MAX_CHARS),
    brief: options.task?.slice(0, BRIEF_MAX_CHARS),
  });

  if (runInWatch) {
    if (verbose) {
      logVerboseExecution({
        projectRoot, mode: 'watch (background + tail)',
        execContext, logFile,
      });
    }

    return executeWatch({
      projectRoot: targetRepoRoot,
      agentEnv,
      logFile,
      pidFile,
      wrapperScript,
      execContext: {
        executionId: execContext.executionId,
        squadName,
        agentName,
        model: claudeModelAlias || resolvedModel,
        trigger,
      },
    });
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

  // Spawn-failure handler (#1157): if the wrapper itself fails to start,
  // nothing inside the script runs — no pid file, no spool, no events.
  // Record the failure so the run doesn't disappear from observability.
  child.on('error', (err) => {
    const durationMs = Date.now() - startMs;
    logObservability({
      ts: new Date().toISOString(),
      id: execContext.executionId,
      squad: squadName,
      agent: agentName,
      provider: 'anthropic',
      model: claudeModelAlias || resolvedModel || 'unknown',
      trigger: trigger as ObservabilityRecord['trigger'],
      status: 'failed',
      duration_ms: durationMs,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      context_tokens: 0,
      error: `Failed to spawn background lane: ${err.message}`,
    });
    updateExecutionStatus(squadName, agentName, execContext.executionId, 'failed', {
      error: `Failed to spawn background lane: ${err.message}`,
      durationMs,
    });
    // Report spawn failure to the API (fire-and-forget)
    void reportExecutionComplete(execContext.executionId, 'failed', {
      error: `Failed to spawn background lane: ${err.message}`,
      durationMs,
      squad: squadName,
      agent: agentName,
    });
  });

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
/**
 * The base a provider-lane worktree branches from (#1083): the repo's
 * integration branch (origin/develop, else origin/main), never the operator's
 * checked-out HEAD. Best-effort fetch keeps the base fresh; offline falls back
 * to the stale local ref (still better than operator HEAD), then HEAD when no
 * remote refs exist at all (fresh local-only repos).
 */
export function resolveIntegrationBase(projectRoot: string): string {
  for (const ref of ['origin/develop', 'origin/main']) {
    try {
      execSync(`git rev-parse --verify --quiet '${ref}'`, { cwd: projectRoot, stdio: 'pipe' });
      try {
        execSync(`git fetch origin '${ref.split('/')[1]}' --quiet`, { cwd: projectRoot, stdio: 'pipe', timeout: 10_000 });
      } catch { /* offline — stale ref beats operator HEAD */ }
      return ref;
    } catch { /* ref absent — try next */ }
  }
  return 'HEAD';
}

/**
 * Ambient-credential guard for provider lanes (#1084). Provider work lands via
 * harvest + the inbox gate (#966), never the lane's own pushes/PRs — a GLM run
 * created a PR authored by the OPERATOR's personal account by inheriting
 * ambient gh auth. Strip the env tokens and point gh at an empty, per-run
 * config dir so keychain-backed `gh` auth can't ride along either. (git's own
 * credential helpers / ssh keys are out of scope here — sandbox P2 covers FS
 * and network isolation.)
 */
export function providerCredentialGuard(timestamp: number): Record<string, string | undefined> {
  let ghConfigDir: string | undefined;
  try {
    ghConfigDir = join(tmpdir(), `squads-ghconfig-${timestamp}`);
    mkdirSync(ghConfigDir, { recursive: true });
  } catch { ghConfigDir = undefined; }
  return {
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}),
  };
}

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
    /** Compiled tool allowlist for claude-harness lanes (#1073). */
    allowedTools?: string[];
    /** Dispatch task text — reported to the API as the execution's brief (#1131). */
    task?: string;
  }
): Promise<string> {
  const cliConfig = getCLIConfig(provider);

  if (!cliConfig) {
    throw new Error(`Unknown provider: ${provider}. Run 'squads providers' to see available providers.`);
  }

  if (!isProviderCLIAvailable(provider)) {
    throw new Error(`CLI '${cliConfig.command}' not found. Install: ${cliConfig.install}`);
  }

  const dispatchRoot = getProjectRoot();
  const squadName = options.squadName || 'unknown';
  const agentName = options.agentName || 'unknown';
  // Callers that already resolved the squad's bound repo pass cwd (#1092
  // task-reroute, agent-runner.ts / execution-engine.ts's own delegation).
  // Callers that don't (lead/sequential modes in run-modes.ts) get the same
  // resolution here — otherwise worktree, harvest, and pid/log placement
  // (below) all land in the dispatch root instead of the squad's target
  // repo, the same blind spot runs-inventory.ts scans around (#1125).
  const projectRoot = options.cwd
    || resolveTargetRepoRoot(dispatchRoot, squadName !== 'unknown' ? loadSquad(squadName) : null, options.task);
  const timestamp = Date.now();

  // Build clean env: remove CLAUDECODE to allow nesting, pass squad context.
  // Provider env hooks (cliConfig.env) inject endpoint/auth overrides; a key
  // set to undefined removes the inherited variable from the child env.
  const { CLAUDECODE: _claudeCode, ...cleanEnv } = process.env;
  const providerEnv: NodeJS.ProcessEnv = {
    ...cleanEnv,
    ...(cliConfig.env?.() ?? {}),
    ...providerCredentialGuard(timestamp),
    SQUADS_SQUAD: squadName,
    SQUADS_AGENT: agentName,
    SQUADS_PROVIDER: provider,
  };
  for (const key of Object.keys(providerEnv)) {
    if (providerEnv[key] === undefined) delete providerEnv[key];
  }

  // Create isolated worktree for this agent — branched from the repo's
  // INTEGRATION base, never the operator's checked-out HEAD (#1083): a lane
  // spawned while the operator sat on an unmerged fix branch produced a PR
  // mixing that branch's content into the agent's diff.
  const branchName = `agent/${squadName}/${agentName}-${timestamp}`;
  const worktreePath = join(projectRoot, '..', '.worktrees', `${squadName}-${agentName}-${timestamp}`);
  let workDir = projectRoot;
  try {
    mkdirSync(join(projectRoot, '..', '.worktrees'), { recursive: true });
    const identity = gitIdentityArgs(projectRoot);
    const base = resolveIntegrationBase(projectRoot);
    execSync(`git ${identity} worktree add '${worktreePath}' -b '${branchName}' '${base}'`, { cwd: projectRoot, stdio: 'pipe' });
    workDir = worktreePath;
  } catch (e) {
    writeLine(`  ${colors.dim}warn: worktree creation failed, using project root: ${e instanceof Error ? e.message : String(e)}${RESET}`);
  }

  // Copy .agents directory into worktree so sandboxed providers can access
  // agent definitions, memory, and config files. Providers like Gemini restrict
  // file reads to the workspace directory, so these must be local.
  let effectivePrompt = prompt;
  // Paths the harness itself materializes in the worktree — excluded from the
  // harvest so furniture never gets committed as "agent work" (#1070).
  const harnessCopiedPaths: string[] = [];
  if (workDir !== projectRoot) {
    const agentsDir = join(projectRoot, '.agents');
    const targetAgentsDir = join(workDir, '.agents');
    if (existsSync(agentsDir) && !existsSync(targetAgentsDir)) {
      try {
        cpSync(agentsDir, targetAgentsDir, { recursive: true });
        harnessCopiedPaths.push('.agents');
      } catch (e) {
        writeLine(`  ${colors.dim}warn: .agents copy failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
      }
    }
    // Rewrite absolute paths in prompt so sandboxed providers can resolve them
    effectivePrompt = prompt.replaceAll(projectRoot, workDir);
  }

  const buildOpts = (options.model || options.allowedTools?.length)
    ? {
        ...(options.model ? { model: options.model } : {}),
        ...(options.allowedTools?.length ? { allowedTools: options.allowedTools } : {}),
      }
    : undefined;
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

  // One id for the whole run, resolved once: the start event, the terminal
  // row, and the API report must share it or the ledger fold sees two runs —
  // one forever 'running' (the exact bug the run-ledger kills).
  const executionId = options.executionId || generateExecutionId();

  // Exec events for provider lanes (#1159): stream-json lanes (claude-harness
  // foreign providers — glm, deepseek) normalize through the Claude adapter
  // live in foreground; detached lanes get run_start here and the rest at
  // spool reconcile (normalizeDetachedLog resumes the seq counter).
  const events = (cliConfig.streamJson || cliConfig.opencodeJson)
    ? new ExecEventWriter(execEventsFile(dispatchRoot, executionId), executionId, {
        source: 'squads-cli',
        provider,
        flusher: new ExecEventFlusher(executionId),
      })
    : null;
  events?.emit({
    type: 'run_start',
    squad: squadName,
    agent: agentName,
    mode: options.foreground ? 'foreground' : 'background',
    model: options.model || '',
    role: '',
    startedAt: new Date(timestamp).toISOString(),
  });

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

      logRunStarted({
        id: executionId,
        squad: squadName,
        agent: agentName,
        provider,
        model: options.model || 'unknown',
        trigger: (options.trigger || 'manual') as ObservabilityRecord['trigger'],
        pid: proc.pid,
        task: options.task?.slice(0, TASK_BRIEF_MAX_CHARS),
        brief: options.task?.slice(0, BRIEF_MAX_CHARS),
      });

      // Tail buffer for usage parsing (cap to keep memory bounded). Stream-json
      // lanes get a larger cap — outcomes accumulate across ALL events, so a
      // tight tail would undercount long runs (#1077).
      const OUTPUT_TAIL_MAX = (cliConfig.streamJson || cliConfig.opencodeJson) ? 4 * 1024 * 1024 : 256 * 1024;
      let outputTail = '';
      // Live exec-event normalization (#1159) — one adapter per run, shaped
      // for the harness that emits the stream (#1177).
      const adapter = events
        ? (cliConfig.opencodeJson ? createOpencodeStreamJsonAdapter() : createClaudeStreamJsonAdapter())
        : null;
      let lineBuf = '';
      if (captureUsage) {
        const append = (chunk: Buffer) => {
          outputTail = (outputTail + chunk.toString('utf-8')).slice(-OUTPUT_TAIL_MAX);
        };
        if (cliConfig.streamJson || cliConfig.opencodeJson) {
          // Render assistant text live instead of echoing raw JSONL (#1077).
          const renderer = cliConfig.streamJson
            ? new StreamJsonAccumulator((text) => process.stdout.write(text + '\n'))
            : null;
          proc.stdout?.on('data', (c: Buffer) => {
            renderer?.push(c.toString('utf-8'));
            append(c);
            lineBuf += c.toString('utf-8');
            const lines = lineBuf.split('\n');
            lineBuf = lines.pop() ?? '';
            for (const l of lines) {
              if (events && adapter) events.ingestProviderLine(adapter, l, agentName);
              // opencode: text parts render live from the same line split.
              if (cliConfig.opencodeJson) {
                const ev = parseOpencodeLine(l);
                if (ev?.type === 'text' && typeof ev.part?.text === 'string' && ev.part.text) {
                  process.stdout.write(ev.part.text + '\n');
                }
              }
            }
          });
          proc.stderr?.on('data', (c: Buffer) => { process.stderr.write(c); append(c); });
        } else {
          proc.stdout?.on('data', (c: Buffer) => { process.stdout.write(c); append(c); });
          proc.stderr?.on('data', (c: Buffer) => { process.stderr.write(c); append(c); });
        }
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
        // #936: providers can exit 0 after printing a fatal API error — detect
        // from output so the ledger never credits a failed run as completed.
        const fatal = detectProviderFatalError(outputTail);
        if (fatal) {
          writeLine(`  ${colors.red}provider API failure (run marked failed): ${fatal}${RESET}`);
        }
        // Harvest BEFORE the ledger write so a suspect harvest (#1076) can mark
        // the run failed — and regardless of exit code: partial work from a
        // failed run must not evaporate either.
        let harvest: HarvestOutcome = { outcome: 'in-place' };
        try {
          harvest = await harvestProviderWork(workDir, projectRoot, branchName, {
            squadName, agentName, provider,
          }, harnessCopiedPaths);
        } catch (e) {
          writeLine(`  ${colors.yellow}warn: harvest failed: ${e instanceof Error ? e.message : String(e)}${RESET}`);
        }
        const suspect = harvest.outcome === 'suspect' ? harvest.detail : null;
        // Stream-json lanes carry real outcomes in the event stream (#1077) —
        // same omit-when-unknown convention as everywhere else (#1060).
        const streamOutcomes = outputTail && cliConfig.streamJson
          ? parseStreamJson(outputTail).outcomes
          : outputTail && cliConfig.opencodeJson
            ? parseOpencodeJson(outputTail).outcomes
            : null;
        logObservability({
          ts: new Date().toISOString(),
          id: executionId,
          squad: squadName,
          agent: agentName,
          provider,
          model: options.model || 'unknown',
          trigger: (options.trigger || 'manual') as ObservabilityRecord['trigger'],
          status: code === 0 && !fatal && !suspect ? 'completed' : 'failed',
          duration_ms: Date.now() - startMs,
          input_tokens: usage?.input_tokens || 0,
          output_tokens: usage?.output_tokens || 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          cost_usd: usage?.cost_usd || 0,
          context_tokens: 0,
          brief: options.task?.slice(0, BRIEF_MAX_CHARS),
          ...(streamOutcomes && streamOutcomes.actions > 0 ? {
            actions: streamOutcomes.actions,
            files_edited: streamOutcomes.files_edited,
            commits: streamOutcomes.commits,
            prs_created: streamOutcomes.prs_created,
            issues_created: streamOutcomes.issues_created,
          } : {}),
          error: fatal
            ?? (suspect ? `suspect harvest: ${suspect}` : undefined)
            ?? (code !== 0 ? `${cliConfig.command} exited with code ${code}` : undefined),
        });
        if (usage && options.verbose) {
          writeLine(`  ${colors.dim}Usage: ${usage.input_tokens} in / ${usage.output_tokens} out, $${usage.cost_usd.toFixed(4)}${RESET}`);
        }
        if (events) {
          if (lineBuf.trim() && adapter) events.ingestProviderLine(adapter, lineBuf, agentName);
          events.emit({
            type: 'run_end',
            ok: code === 0 && !fatal && !suspect,
            durationMs: Date.now() - startMs,
            totalUsage: {
              input: usage?.input_tokens || 0,
              output: usage?.output_tokens || 0,
              cacheRead: 0,
              cacheWrite: 0,
              costEst: usage?.cost_usd || 0,
            },
            ...(streamOutcomes && streamOutcomes.actions > 0 ? { outcomes: streamOutcomes } : {}),
          });
          events.close();
        }

        switch (harvest.outcome) {
          case 'branch-preserved':
            writeLine(`  ${colors.green}Agent work preserved on branch ${harvest.branch}${RESET}`);
            writeLine(`  ${colors.dim}Review and land it through the gate: squads inbox${RESET}`);
            cleanupWorktree(workDir, projectRoot, { keepBranch: true });
            break;
          case 'suspect':
            writeLine(`  ${colors.red}SUSPECT harvest (run marked failed): ${harvest.detail}${RESET}`);
            writeLine(`  ${colors.dim}Branch kept for review — do NOT land without inspecting: ${harvest.branch}${RESET}`);
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

  // Single argv source with the foreground path (#1101): rebuilding here via a
  // second buildArgs call silently dropped buildOpts — background claude-harness
  // lanes spawned with NO --allowedTools, so every Write/Edit was denied in
  // --print mode and the lane was read-only. Quote per-arg for the shell wrapper.
  const providerArgs = args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
  const cleanupCmd = buildDetachedHarvestShell({
    workDir, projectRoot, branchName, squadName, agentName, provider, logFile,
  });
  // Spool done-file (hq#450 D1): record completion facts for the reconcile
  // sweep — the CLI that spawned this wrapper is long gone when it finishes.
  const timeoutFlag = `${pidFile}.timeout`;
  const spoolCmd = options.executionId
    ? buildSpoolWriterShell({
        obsRoot: dispatchRoot,
        execId: options.executionId,
        squad: squadName,
        agent: agentName,
        provider,
        model: options.model || '',
        trigger: options.trigger || 'manual',
        logFile,
        timeoutFlag,
        // Harness stamp (#1177) — reconcile picks the stream parser/adapter by
        // this, not by provider: claude-harness lanes and opencode lanes emit
        // different JSONL shapes; plain provider CLIs (aider) stamp nothing.
        harness: cliConfig.command === 'claude' ? 'claude' : cliConfig.opencodeJson ? 'opencode' : '',
      })
    : '';
  const envTimeout = Number(process.env.SQUADS_AGENT_TIMEOUT_MINUTES);
  const watchdogMinutes = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : (options.timeoutMinutes ?? defaultTimeoutForRole());
  const executorCmd = `${cliConfig.command} ${providerArgs} > '${logFile}' 2>&1`;
  const shellScript = `cd '${workDir}' || exit 1; ${buildWatchdogShell(executorCmd, Math.round(watchdogMinutes * 60), timeoutFlag)}${cleanupCmd}${spoolCmd}`;
  // pid file's second line (when known) is this run's API execution id
  // (#1131) — see buildPidFileWriteCmd.
  const wrapperScript = `${buildPidFileWriteCmd(pidFile, options.executionId)}; START=$(date +%s); ${shellScript}; rm -f '${pidFile}'`;

  // Register run start with the API for provider background mode (#1100).
  const child = spawn('sh', ['-c', wrapperScript], {
    cwd: workDir,
    detached: true,
    stdio: 'ignore',
    env: providerEnv,
  });

  child.unref();

  // Spawn-failure handler (#1157): if the wrapper itself fails to start,
  // nothing inside the script runs — no pid file, no spool, no events.
  // Record the failure so the run doesn't disappear from observability.
  child.on('error', (err) => {
    const durationMs = Date.now() - timestamp;
    logObservability({
      ts: new Date().toISOString(),
      id: executionId,
      squad: squadName,
      agent: agentName,
      provider,
      model: options.model || 'unknown',
      trigger: (options.trigger || 'manual') as ObservabilityRecord['trigger'],
      status: 'failed',
      duration_ms: durationMs,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      context_tokens: 0,
      error: `Failed to spawn provider background lane: ${err.message}`,
    });
    // Report spawn failure to the API (fire-and-forget)
    void reportExecutionComplete(executionId, 'failed', {
      error: `Failed to spawn provider background lane: ${err.message}`,
      durationMs,
      squad: squadName,
      agent: agentName,
    });
  });

  // Register run start AFTER spawn so the report carries the wrapper pid —
  // the sh wrapper lives for the run's duration, so it's the liveness signal
  // the orphan reaper checks. Fire-and-forget (#1131 brief; never block on
  // API reachability), same id as the spool's terminal report.
  void reportExecutionStart(squadName, agentName, executionId, {
    trigger: options.trigger || 'manual',
    model: options.model,
    brief: options.task?.slice(0, TASK_BRIEF_MAX_CHARS),
    pid: child.pid,
  });
  logRunStarted({
    id: executionId,
    squad: squadName,
    agent: agentName,
    provider,
    model: options.model || 'unknown',
    trigger: (options.trigger || 'manual') as ObservabilityRecord['trigger'],
    pid: child.pid,
    task: options.task?.slice(0, TASK_BRIEF_MAX_CHARS),
    brief: options.task?.slice(0, BRIEF_MAX_CHARS),
  });

  if (options.verbose) {
    writeLine(`  ${colors.dim}Log: ${logFile}${RESET}`);
    writeLine(`  ${colors.dim}PID file: ${pidFile}${RESET}`);
  }

  return `Log: ${logFile}. Monitor: tail -f ${logFile}`;
}
