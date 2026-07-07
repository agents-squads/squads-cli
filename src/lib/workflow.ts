/**
 * Squad Workflow — Plan → Execute → Review → Verify
 *
 * Architecture:
 * 1. PLAN: Lead sees goals + feedback + budget → produces task assignments
 * 2. EXECUTE: Workers run independently in parallel, each with their task
 * 3. REVIEW: Lead evaluates worker output, merges PRs, updates goals
 * 4. VERIFY: Verifier checks deliverables against quality gate
 *
 * Workers don't share a conversation — they get their task + squad context.
 * Token budget replaces turn limits. Lead plans within the budget.
 */

import { track } from './telemetry.js';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import {
  type AgentRole,
  type Transcript,
  classifyAgent,
  isQuotaMessage,
  isAuthFailureMessage,
  modelForRole,
  createTranscript,
  serializeTranscript,
  addTurn,
  detectConvergence,
  estimateTurnCost,
  parseHandoff,
  extractValidationContract,
} from './conversation.js';
import {
  type Squad,
  findSquadsDir,
  findProjectRoot,
} from './squad-parser.js';
import {
  type ContextRole,
  gatherSquadContext,
  resolveContextRoleFromAgent,
} from './run-context.js';
import {
  buildAgentEnv,
  resolveGuardrailSettings,
} from './execution-engine.js';
import { defaultTimeoutForRole } from './run-types.js';
import { type ExecutionContext } from './run-types.js';
import { loadProjectConfig } from './config.js';
import { getBotGhEnv } from './github.js';
import { parseIssueNumberFromTask, checkPrForIssue } from './squad-loop.js';
import { generateExecutionId, getClaudeModelAlias } from './run-utils.js';
import { createRunWorktree } from './worktree.js';
import { colors, RESET, writeLine } from './terminal.js';
import {
  logObservability,
  snapshotGoals,
  diffGoals,
  deriveCostFromTokens,
  type ObservabilityRecord,
} from './observability.js';
import {
  StreamJsonAccumulator,
  emptyUsage,
  addUsage,
  emptyOutcomes,
  addOutcomes,
  type StreamUsage,
  type RunOutcomes,
} from './stream-json.js';
import {
  ExecEventWriter,
  createClaudeStreamJsonAdapter,
  execEventsFile,
} from './exec-events.js';
import { compileAllowedTools } from './agent-contract.js';
import { findMemoryDir } from './memory.js';
import {
  buildSandboxSettings, readGuardrailHooks, readGuardrailPermissions,
  writeSandboxSettingsFile, sandboxEnabled, sandboxStrict,
} from './sandbox-settings.js';

// =============================================================================
// Configuration
// =============================================================================

export type CycleFocus = 'create' | 'resolve' | 'review' | 'ship' | 'research' | 'cost';

export interface ConversationOptions {
  task?: string;
  maxTurns?: number;
  costCeiling?: number;
  verbose?: boolean;
  model?: string;
  /** Per-agent execution timeout (minutes) — from --timeout; threads to each spawned agent (#438) */
  timeout?: number;
  /** Token budget for the squad (output tokens). Default: 50K */
  tokenBudget?: number;
  /** Cycle focus — changes the lead's planning behavior */
  focus?: CycleFocus;
  /** Scoped, single-issue conversation (roster trimmed, PR-gate stop enabled) — derived from `task` when omitted */
  scoped?: boolean;
  /** Branch namespace override for the per-run worktree (default: 'squads/run-'). E.g. `squads propose` (#983) uses 'squads/proposal-' so its runs land in a distinct namespace the inbox scanner classifies separately. */
  branchPrefix?: string;
}

/** Load focus instructions from .agents/config/cycle-focus.md */
function loadFocusPrompt(focus: CycleFocus): string {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return '';
  const focusPath = join(squadsDir, '..', 'config', 'cycle-focus.md');
  if (!existsSync(focusPath)) return '';
  const content = readFileSync(focusPath, 'utf-8');
  if (!content) return '';
  const match = content.match(new RegExp(`## ${focus}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match ? match[1].trim() : '';
}

/** Fallback token budget / cost ceiling — overridden by project config. */
const DEFAULT_TOKEN_BUDGET = 50000;
const DEFAULT_COST_CEILING = 25;

// =============================================================================
// Agent Execution (independent, tool-capable)
// =============================================================================

interface AgentRunConfig {
  agentName: string;
  agentPath: string;
  role: AgentRole;
  squadName: string;
  model: string;
  /** The specific task for this agent (from lead's plan) */
  task: string;
  /** Full squad context (goals, feedback, strategy, etc.) */
  squadContext: string;
  cwd: string;
  /** Stream this agent's output live (prefixed) — set under squad-run --verbose (#791) */
  verbose?: boolean;
  /** Per-agent execution timeout (minutes) — from --timeout. env SQUADS_AGENT_TIMEOUT_MINUTES overrides; unset → per-role default via defaultTimeoutForRole (#438, #941) */
  timeout?: number;
  /** Cycle-level exec-event stream (#902) — this agent's tool activity is teed into it. */
  events?: ExecEventWriter;
}

/**
 * Result of one independent agent run: the response text PLUS the real cost/
 * token usage captured from the stream-json `result` event (#791 follow-up).
 * `usage` is all-zero only when no result event was seen (timeout / spawn error).
 */
export interface AgentRunResult {
  text: string;
  usage: StreamUsage;
  outcomes: RunOutcomes;
}

/** Spread the accumulated outcomes into an ObservabilityRecord. */
function outcomeFields(o: RunOutcomes) {
  return {
    actions: o.actions,
    files_edited: o.files_edited,
    commits: o.commits,
    prs_created: o.prs_created,
    issues_created: o.issues_created,
  };
}

/**
 * Run a single agent independently via
 * `claude --print --output-format stream-json --verbose --allowedTools`.
 * Agent gets: their task + squad context. No shared transcript.
 *
 * `--output-format stream-json` emits JSONL events (one per line) and REQUIRES
 * `--verbose` on the claude invocation to do so — that is always passed and is
 * separate from our user-facing `config.verbose`, which only gates the LIVE
 * display of assistant text. The terminal `result` event carries the canonical
 * full response text and real `total_cost_usd` + `usage`, so observability gets
 * true numbers instead of 0.
 */
/**
 * Transient API failures (stream cut, connection reset, 5xx/overloaded) lose
 * the TURN in conversation mode — the verifier's verdict was cut mid-response
 * on a real run (#944). One re-spawn with backoff recovers them. Quota,
 * timeout, auth and invalid-model errors must stay LOUD (#936) — never retried.
 */
const TRANSIENT_API_ERROR =
  /connection (closed|error|reset)|api error:.*(closed|reset|interrupted)|overloaded|status (500|502|503|529)|ECONNRESET|ETIMEDOUT|socket hang up/i;

export function isTransientTurnError(text: string): boolean {
  if (/\[QUOTA\]|timed out after|authentication|invalid.*model|insufficient/i.test(text)) return false;
  return TRANSIENT_API_ERROR.test(text);
}

async function runIndependentAgent(config: AgentRunConfig): Promise<AgentRunResult> {
  const maxRetries = process.env.SQUADS_TURN_RETRIES === '0' ? 0 : 1;
  const backoffMs = parseInt(process.env.SQUADS_TURN_RETRY_BACKOFF_MS ?? '5000', 10);
  let result = await runIndependentAgentOnce(config);
  for (let attempt = 1; attempt <= maxRetries && isTransientTurnError(result.text); attempt++) {
    writeLine(`  ${colors.yellow}${config.agentName}: transient API error — retrying turn (${attempt}/${maxRetries})${RESET}`);
    await new Promise((r) => setTimeout(r, backoffMs * attempt));
    result = await runIndependentAgentOnce(config);
  }
  return result;
}

async function runIndependentAgentOnce(config: AgentRunConfig): Promise<AgentRunResult> {
  const { agentName, agentPath, role, squadName, task, squadContext } = config;

  const prompt = `You are ${agentName} (${role}) in squad ${squadName}.

Read your full agent definition at ${agentPath} and follow its instructions.

## Your Task

${task}

${squadContext}

## Output Requirements

- Write the test that reflects INTENDED behavior BEFORE implementing — a test
  written after the code confirms decisions instead of catching bugs (#995)
- Commit your work (git add, commit, push)
- Open PRs targeting develop (product repos) or push to main (domain repos)
- Run the build before pushing — fix if it fails
- Report: branch name, PR number, build status, what you changed
- Before your STATUS line, emit a structured handoff (#990) — the next agent
  acts on THIS, not on your prose. Every field is mandatory; your own command
  log must not contradict your status:

## HANDOFF
completed: [what is genuinely done]
undone: [what remains, or "none"]
commands: [key commands you ran, each with its exit code, e.g. \`npm test\` → 0]
issues: [problems discovered, or "none"]
procedures: [followed | deviated: reason]

- End with: ## STATUS: DONE or ## STATUS: BLOCKED [reason]
- NEVER claim DONE with a non-empty undone list or a failing exit code in
  commands — that is BLOCKED with a reason.`;

  const resolvedModel = config.model || modelForRole(role);
  const claudeModel = getClaudeModelAlias(resolvedModel) || resolvedModel;

  const { CLAUDECODE: _cc, ANTHROPIC_API_KEY: _ak, ...cleanEnv } = process.env;

  let botGhToken: string | undefined;
  try {
    const ghEnv = await getBotGhEnv();
    botGhToken = ghEnv.GH_TOKEN;
  } catch { /* falls back to user auth */ }

  const execContext: ExecutionContext = {
    squad: squadName, agent: agentName,
    taskType: role === 'lead' ? 'lead' : role === 'scanner' ? 'research' : role === 'verifier' ? 'evaluation' : 'execution',
    trigger: 'scheduled', executionId: generateExecutionId(),
  };

  // Effort level per role (#702): scanners low, workers high, verifiers medium
  const effortByRole: Record<string, string> = { lead: 'high', scanner: 'low', worker: 'high', verifier: 'medium' };
  const agentEnv = buildAgentEnv(cleanEnv as Record<string, string>, execContext, { ghToken: botGhToken, effort: effortByRole[role] as 'high' | 'medium' | 'low' });

  // Role-based tool sets (#701): scanners read-only, workers full, verifiers read+build.
  // readBase = inspection only (no git/gh, no writes).
  const readBase = ['Read', 'Glob', 'Grep', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(date:*)', 'Bash(curl:*)', 'WebFetch', 'WebSearch'];
  // Lead git/gh: inspect repos/PRs, file delegation issues, and MERGE ready worker
  // PRs (orchestration — CI-gated via --auto, per the review prompt). NOT commit/push/
  // pr-create — the lead lands workers' reviewed code but never authors/ships its own.
  const leadGitGh = ['Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)', 'Bash(git branch:*)', 'Bash(git fetch:*)', 'Bash(gh pr view:*)', 'Bash(gh pr list:*)', 'Bash(gh pr checks:*)', 'Bash(gh pr merge:*)', 'Bash(gh issue view:*)', 'Bash(gh issue list:*)', 'Bash(gh issue create:*)'];
  const readTools = [...readBase, 'Bash(git:*)', 'Bash(gh:*)'];
  const writeTools = ['Write', 'Edit', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(python3:*)', 'Bash(bash:*)', 'Bash(sh:*)', 'Bash(docker:*)', 'Bash(duckdb:*)', 'Bash(bq:*)', 'Bash(gcloud:*)', 'Bash(gws:*)', 'Bash(stripe:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(echo:*)', 'Bash(chmod:*)', 'Bash(squads:*)', 'Agent'];
  const buildTools = ['Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)'];

  const toolsByRole: Record<string, string[]> = {
    // Leads PLAN, DELEGATE, and LAND: read, state/memory writes (Write/Edit so the
    // review phase can update state.md — goals.md stays governance-blocked by design),
    // git/gh that inspects + files issues + MERGES ready worker PRs (CI-gated --auto),
    // and Agent (dispatch). NO git commit/push, NO gh pr create, NO build-Bash — a lead
    // lands workers' reviewed PRs but CANNOT author/ship code itself (squads-cli#790, #793).
    lead: [...readBase, ...leadGitGh, 'Write', 'Edit', 'Agent'],
    scanner: readTools,
    worker: [...readTools, ...writeTools],
    verifier: [...readTools, ...buildTools],
  };

  // stream-json gives us the per-agent cost/usage in the terminal `result` event.
  // `--verbose` is REQUIRED for stream-json to emit events — always pass it; it's
  // independent of config.verbose (which only gates the live display below).
  const claudeArgs: string[] = ['--print', '--output-format', 'stream-json', '--verbose'];
  if (process.env.SQUADS_SKIP_PERMISSIONS === '1') {
    claudeArgs.push('--dangerously-skip-permissions');
  } else {
    // Explicit contract grants win over the role surface (#920).
    const fallback = toolsByRole[role] || [...readTools, ...writeTools];
    claudeArgs.push('--allowedTools', ...compileAllowedTools(agentPath, fallback).tools);
  }
  claudeArgs.push('--disable-slash-commands');

  // Fail-safe (#448): the agent's cwd must exist at spawn time. Under parallel
  // org runs a per-run worktree can vanish between creation and spawn (a racing
  // squad's worktree cleanup/prune against the shared repo .git). spawn() with a
  // missing cwd makes the process error out ("Path ... does not exist"), killing
  // an otherwise-healthy squad. Fall back to a valid directory instead.
  let spawnCwd = config.cwd;
  if (!existsSync(spawnCwd)) {
    spawnCwd = findProjectRoot() || process.cwd();
    writeLine(
      `  ${colors.dim}warn: ${agentName} cwd ${config.cwd} is missing, falling back to ${spawnCwd}${RESET}`
    );
  }

  const guardrailPath = resolveGuardrailSettings(spawnCwd);
  if (sandboxEnabled()) {
    // P2 default-on (#780): conversation agents run inside the OS sandbox too —
    // same settings shape as the single-agent paths, guardrail hooks merged in.
    const memDir = findMemoryDir();
    const settings = buildSandboxSettings({
      cwd: spawnCwd,
      writeScope: memDir ? [memDir] : [],
      guardrailHooks: readGuardrailHooks(guardrailPath),
      guardrailPermissions: readGuardrailPermissions(guardrailPath),
      strict: sandboxStrict(),
    });
    claudeArgs.push('--settings', writeSandboxSettingsFile(settings, join(spawnCwd, '.git')));
    agentEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
  } else if (guardrailPath) {
    claudeArgs.push('--settings', guardrailPath);
  }
  if (claudeModel) claudeArgs.push('--model', claudeModel);

  // Exec-event stream (#902): announce this agent as a lane in the cycle's
  // fan-out tree, then tee its provider stream through the Claude adapter so
  // every tool call / file touch / web fetch lands as a normalized event.
  config.events?.emit({
    type: 'subagent_spawn',
    childRunId: execContext.executionId,
    squad: squadName,
    agent: agentName,
    task: task.slice(0, 200),
  });
  const eventAdapter = config.events ? createClaudeStreamJsonAdapter() : undefined;

  return new Promise<AgentRunResult>((resolve) => {
    const child = spawn('claude', claudeArgs, {
      cwd: spawnCwd, env: agentEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt);
    child.stdin.end();

    // Parse the JSONL stream-json stdout line-by-line. On `assistant` events we
    // stream the text live (under config.verbose) with the existing prefix; on
    // the terminal `result` event we capture the canonical text + real cost/usage.
    // Stream-decode so multi-byte UTF-8 chars split across chunk boundaries aren't corrupted.
    const decoder = new TextDecoder('utf-8');
    const accumulator = new StreamJsonAccumulator(
      config.verbose
        ? (text: string) => {
            for (const line of text.split('\n')) {
              writeLine(`  ${colors.dim}${agentName} │${RESET} ${line}`);
            }
          }
        : undefined,
      eventAdapter
        ? (raw: string) => config.events?.ingestProviderLine(eventAdapter, raw, agentName)
        : undefined,
    );

    // Timeout: configurable via env var, defaults from run-types.ts
    const envTimeout = process.env.SQUADS_AGENT_TIMEOUT_MINUTES;
    const timeoutMinutes = envTimeout ? parseInt(envTimeout, 10) : (config.timeout ?? defaultTimeoutForRole(config.role));
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Safety net: if the child ignores SIGTERM, force-kill so `close` still
      // fires and we never hang. The `close` handler does the usage capture +
      // resolve for BOTH the normal and timed-out paths, so a cut-off agent
      // still reports the assistant-event tokens it streamed before the kill
      // (instead of the old emptyUsage(), which dropped them on the floor).
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    }, timeoutMinutes * 60 * 1000);

    child.stdout.on('data', (chunk: Buffer) => {
      accumulator.push(decoder.decode(chunk, { stream: true }));
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      accumulator.push(decoder.decode()); // flush bytes held back for a split multi-byte char
      accumulator.flush();
      const { text, usage: rawUsage, isError, outcomes } = accumulator.getResult();
      // Cut-off runs (no terminal `result` event) carry real assistant-event
      // tokens but cost_usd == 0. Derive a notional cost from tokens × pricing
      // so the observability record still shows a cost — tokens are the real
      // quota unit; cost is a derived proxy on a Max subscription. (No-op when
      // there are no tokens, or when the result event already gave us a cost.)
      const hasTokens = rawUsage.input_tokens + rawUsage.output_tokens + rawUsage.cache_read_tokens + rawUsage.cache_write_tokens > 0;
      const usage: StreamUsage = (rawUsage.cost_usd === 0 && hasTokens)
        ? { ...rawUsage, cost_usd: deriveCostFromTokens(rawUsage, rawUsage.model || claudeModel || config.model) }
        : rawUsage;
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();

      config.events?.emit({
        type: 'subagent_done',
        childRunId: execContext.executionId,
        agent: agentName,
        ok: !timedOut && !isError && code === 0,
      });

      // Timed-out agents: return the timeout sentinel the convergence loop
      // expects, but with the salvaged assistant-event usage (real tokens; cost
      // derived above) instead of zero — cut-off cost is no longer invisible.
      if (timedOut) {
        resolve({ text: `[ERROR] ${agentName} timed out after ${timeoutMinutes} minutes`, usage, outcomes });
        return;
      }

      // Preserve the contract: still RETURN the agent's response text (now from
      // the result event), and keep the [QUOTA]/[ERROR]/no-output sentinels the
      // downstream plan/convergence parsing depends on.
      if (isQuotaMessage(text)) {
        resolve({ text: `[QUOTA] ${agentName}: API limit reached`, usage, outcomes });
      } else if (isError && text.length > 0) {
        // is_error:true — return the error text as before, but keep real usage.
        resolve({ text, usage, outcomes });
      } else if (text.length > 0) {
        resolve({ text: text.trim(), usage, outcomes });
      } else if (code !== 0) {
        resolve({ text: `[ERROR] ${agentName} exited with code ${code}${stderr ? ': ' + stderr.slice(0, 200) : ''}`, usage, outcomes });
      } else {
        resolve({ text: `[${agentName} completed with no output]`, usage, outcomes });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      config.events?.emit({ type: 'subagent_done', childRunId: execContext.executionId, agent: agentName, ok: false });
      resolve({ text: `[ERROR] ${agentName} failed to spawn: ${err.message}`, usage: emptyUsage(), outcomes: emptyOutcomes() });
    });
  });
}

// =============================================================================
// Squad Workflow: Plan → Execute → Review → Verify
// =============================================================================

interface ClassifiedAgent {
  name: string;
  role: AgentRole;
  path: string;
}

export function buildAgentRoster(
  squad: Squad,
  squadsDir: string,
  opts: { taskMode?: boolean } = {},
): ClassifiedAgent[] {
  // If squad defines conversation_agents, only include those in the conversation.
  // Other agents run on their own schedules, not in the squad conversation.
  const conversationFilter = squad.conversation_agents;

  const agents: ClassifiedAgent[] = [];
  for (const agent of squad.agents) {
    if (conversationFilter && !conversationFilter.includes(agent.name)) continue;
    const role = classifyAgent(agent.name, agent.role);
    if (!role) continue;
    const agentPath = join(squadsDir, squad.dir, `${agent.name}.md`);
    if (!existsSync(agentPath)) continue;
    agents.push({ name: agent.name, role, path: agentPath });
  }

  // Lead fallback by NAME (#449): if no agent classified as lead (e.g. a roster
  // whose role values don't match any synonym), promote the agent whose name is
  // `<squad>-lead` or otherwise ends in `-lead`. Without a lead the whole squad
  // is skipped ("No lead agent found"), so this is the last line of defense.
  if (!agents.some(a => a.role === 'lead')) {
    const byName = agents.find(
      a => a.name.toLowerCase() === `${squad.name.toLowerCase()}-lead` ||
        a.name.toLowerCase().endsWith('-lead')
    );
    if (byName) byName.role = 'lead';
  }

  // Scoped --task mode (#951): a `--task` dispatch (e.g. issue-solver working
  // one issue) doesn't need the full squad roster — scanners/verifiers add
  // turns and cost without adding value to a single bounded fix. Keep the
  // lead(s) plus the first worker that isn't an eval/critic/tester/bench
  // agent (those are quality-gate roles, not delegates that build).
  if (opts.taskMode) {
    const leads = agents.filter(a => a.role === 'lead');
    const delegate = agents.find(
      a => a.role === 'worker' && !/-eval$|-critic|-tester$|-bench$/i.test(a.name),
    );
    return delegate ? [...leads, delegate] : leads;
  }

  return agents;
}

export interface ConversationResult {
  transcript: Transcript;
  turnCount: number;
  totalCost: number;
  converged: boolean;
  reason: string;
}

/**
 * Run a squad workflow: Plan → Execute → Review → Verify.
 *
 * Lead plans within token budget, workers execute independently in parallel,
 * lead reviews, verifier checks quality.
 */
export async function runConversation(
  squad: Squad,
  options: ConversationOptions = {},
): Promise<ConversationResult> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    return { transcript: createTranscript(squad.name), turnCount: 0, totalCost: 0, converged: true, reason: 'No squads directory found' };
  }

  const projectConfig = loadProjectConfig();
  const tokenBudget = options.tokenBudget || projectConfig.token_budget || DEFAULT_TOKEN_BUDGET;
  const costCeiling = options.costCeiling || projectConfig.cost_ceiling || DEFAULT_COST_CEILING;
  const maxTurns = options.maxTurns || 100;
  const scoped = options.scoped ?? Boolean(options.task);
  const issueNumberFromTask = options.task ? parseIssueNumberFromTask(options.task) : null;
  const transcript = createTranscript(squad.name);

  // Deliver-and-stop gate (#951): in a scoped single-issue conversation, stop
  // as soon as a PR already addresses the target issue — even if the turn/cost
  // ceiling hasn't been hit. Wraps detectConvergence (kept pure/IO-free) with
  // one extra IO check; the bot's gh auth is fetched once, lazily, only when
  // the gate can actually fire.
  let prGateGhEnv: Record<string, string> | undefined;
  const checkConvergence = async () => {
    const base = detectConvergence(transcript, maxTurns, costCeiling);
    if (base.converged) return base;
    if (!scoped || issueNumberFromTask === null || !squad.repo) return base;
    if (!prGateGhEnv) prGateGhEnv = await getBotGhEnv().catch(() => ({}));
    const pr = checkPrForIssue(squad.repo, issueNumberFromTask, prGateGhEnv);
    if (pr) {
      return {
        converged: true,
        reason: `PR #${pr.number} already addresses issue #${issueNumberFromTask} — stopping (${pr.title})`,
      };
    }
    return base;
  };

  // Resolve squad's working directory
  let squadCwd = process.cwd();
  if (squad.repo) {
    const repoName = squad.repo.split('/').pop();
    if (repoName) {
      const reposRoot = join(squadsDir, '..', '..', '..');
      const candidatePath = join(reposRoot, repoName);
      if (existsSync(candidatePath)) squadCwd = candidatePath;
    }
  }

  // Per-squad-RUN worktree isolation (#440): create ONE git worktree of the
  // squad's repo so all agents in this conversation (plan → execute → review →
  // verify) share an isolated checkout — the worker's branch switches, file
  // drops, and PRs never touch the user's working tree. Falls back to in-place
  // (squadCwd unchanged) if the dir isn't a git repo or worktree add fails.
  // Disable with SQUADS_NO_WORKTREE=1. Cleanup runs in finally below.
  const worktree = createRunWorktree(squadCwd, squad.name, options.branchPrefix);
  squadCwd = worktree.cwd;

  try {
  const allAgents = buildAgentRoster(squad, squadsDir, { taskMode: scoped });
  const leads = allAgents.filter(a => a.role === 'lead');
  const scanners = allAgents.filter(a => a.role === 'scanner');
  const workers = allAgents.filter(a => a.role === 'worker');
  const verifiers = allAgents.filter(a => a.role === 'verifier');

  if (leads.length === 0) {
    return { transcript, turnCount: 0, totalCost: 0, converged: true, reason: 'No lead agent found' };
  }

  const lead = leads[0];
  const log = (msg: string) => writeLine(`  ${colors.dim}${msg}${RESET}`);

  // Track timing and goals before cycle begins
  const cycleStartMs = Date.now();
  const executionId = generateExecutionId();
  const goalsBefore = snapshotGoals(squad.name);

  // Accumulate REAL cost/usage across every agent spawn in this conversation
  // (plan + workers + review + verify) — captured from stream-json result events.
  let cycleUsage: StreamUsage = emptyUsage();
  // Accumulate what every agent in this conversation actually DID (real output).
  let cycleOutcomes: RunOutcomes = emptyOutcomes();

  log(`${squad.name}: ${allAgents.length} agents (${leads.length}L ${scanners.length}S ${workers.length}W ${verifiers.length}V) budget: ${Math.round(tokenBudget / 1000)}K tokens`);

  // Exec-event stream for this cycle (#902): persists to the dispatch root's
  // observability dir (survives the per-run worktree by construction). One
  // file per cycle; each agent's activity is attributed via the envelope.
  const events = new ExecEventWriter(
    execEventsFile(findProjectRoot() || process.cwd(), executionId),
    executionId,
  );
  const finishEvents = (ok: boolean) => {
    events.emit({
      type: 'run_end',
      ok,
      durationMs: Date.now() - cycleStartMs,
      totalUsage: {
        input: cycleUsage.input_tokens,
        output: cycleUsage.output_tokens,
        cacheRead: cycleUsage.cache_read_tokens,
        cacheWrite: cycleUsage.cache_write_tokens,
        costEst: cycleUsage.cost_usd,
      },
      outcomes: { ...outcomeFields(cycleOutcomes) },
    });
    events.close();
  };

  // Auth-failure fail-fast (#956): a missing/expired login fails every claude
  // invocation identically — unlike a quota wall it never clears mid-cycle, so
  // continuing just burns turns until convergence detection prints a cryptic
  // "no signals" stop at exit 0. Abort loud, nonzero exit, credited as failed
  // (same family as the #936/#947 exit-0 provider failures).
  const abortOnAuthFailure = (text: string, agentName: string): ConversationResult | null => {
    if (!isAuthFailureMessage(text)) return null;
    void track('journey.run.blocked', { reason: 'not_logged_in' }); // funnel drop instrument (#964)
    writeLine(`  ${colors.red}${squad.name}: Claude is not authenticated — run: claude /login${RESET}`);
    logObservability({
      ts: new Date().toISOString(),
      id: executionId,
      squad: squad.name,
      agent: agentName,
      provider: 'anthropic',
      model: options.model || modelForRole('lead'),
      trigger: 'scheduled',
      status: 'failed',
      duration_ms: Date.now() - cycleStartMs,
      input_tokens: cycleUsage.input_tokens,
      output_tokens: cycleUsage.output_tokens,
      cache_read_tokens: cycleUsage.cache_read_tokens,
      cache_write_tokens: cycleUsage.cache_write_tokens,
      cost_usd: cycleUsage.cost_usd,
      context_tokens: 0,
      ...outcomeFields(cycleOutcomes),
      error: 'Claude is not authenticated — run: claude /login',
      task: options.task,
    });
    finishEvents(false);
    process.exitCode = 1;
    return { transcript, turnCount: transcript.turns.length, totalCost: cycleUsage.cost_usd, converged: false, reason: 'Claude is not authenticated — run: claude /login' };
  };

  // Build squad context once (shared by all agents)
  // Resolve context role from frontmatter; leads default to 'lead', COO agents have role: coo
  const contextRole: ContextRole = resolveContextRoleFromAgent(lead.path, lead.name);
  events.emit({
    type: 'run_start',
    squad: squad.name,
    agent: lead.name,
    mode: 'conversation',
    model: options.model || modelForRole('lead'),
    role: contextRole,
    startedAt: new Date(cycleStartMs).toISOString(),
  });
  const squadContext = gatherSquadContext(squad.name, lead.name, {
    agentPath: lead.path, role: contextRole,
    // The one event the provider stream can never produce: per-layer cost (#902).
    onStats: (stats) => events.emit({
      type: 'context_assembled',
      layers: stats.layers,
      totalTokensEst: stats.totalTokensEst,
      budgetTokens: Math.ceil(stats.budgetChars / 4),
    }, lead.name),
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: PLAN — Lead scopes work within budget
  // ═══════════════════════════════════════════════════════════════════

  log(`  plan: ${lead.name}...`);

  const workerNames = workers.map(w => w.name).join(', ')
    || (scanners.length > 0
      ? '(no workers — dispatch scanners with "- scanner: [name] | task: [...]" lines, or do the work yourself)'
      : '(no workers — do the work yourself)');
  const scannerNames = scanners.map(s => s.name).join(', ');

  // Load focus-specific instructions from .agents/config/cycle-focus.md
  const focus = options.focus || 'create';
  const focusInstructions = loadFocusPrompt(focus);

  // Load plan prompt template from .agents/config/conversation-roles.md (Lead first turn)
  // Focus instructions override the default planning behavior
  // Load plan prompt from template (no prompts in TypeScript — CLAUDE.md rule)
  const planTemplatePath = join(__dirname, '..', 'templates', 'prompts', 'plan.md');
  const planTemplate = existsSync(planTemplatePath)
    ? readFileSync(planTemplatePath, 'utf-8')
    : 'You are {{LEAD_NAME}} (lead) in squad {{SQUAD_NAME}}. Plan the work.';
  const planPrompt = planTemplate
    .replace('{{LEAD_NAME}}', lead.name)
    .replace('{{SQUAD_NAME}}', squad.name)
    .replace('{{LEAD_PATH}}', lead.path)
    .replace('{{FOCUS}}', focus.toUpperCase())
    .replace('{{FOCUS_INSTRUCTIONS}}', focusInstructions)
    .replace('{{BUDGET_K}}', String(Math.round(tokenBudget / 1000)))
    .replace('{{MAX_TASKS}}', String(Math.floor(tokenBudget / 10000)))
    .replace('{{WORKERS}}', workerNames)
    .replace('{{SCANNERS}}', scannerNames || '(none)')
    .replace('{{SQUAD_CONTEXT}}', squadContext);

  const planResult = await runIndependentAgent({
    agentName: lead.name, agentPath: lead.path, role: 'lead',
    squadName: squad.name, model: options.model || modelForRole('lead'),
    task: options.task ? `${options.task}\n\n${planPrompt}` : planPrompt, squadContext: '', cwd: squadCwd, verbose: options.verbose, timeout: options.timeout, events,
  });
  const planOutput = planResult.text;
  // #989: the plan's validation contract is the verifier's checklist — done-ness
  // defined before code, checked independently of the implementation.
  const validationContract = extractValidationContract(planOutput);
  // #995: the contract is a run ARTIFACT, not just transcript text — remediation
  // cycles, follow-up dispatches, and the inbox reference done-ness across runs.
  if (validationContract) {
    try {
      const contractDir = join(squadsDir, '..', 'observability', 'runs', executionId);
      mkdirSync(contractDir, { recursive: true });
      writeFileSync(join(contractDir, 'validation-contract.md'),
        `# Validation contract — ${squad.name} ${executionId}\n\n${validationContract}\n`);
    } catch {
      // artifact write is best-effort; the in-prompt contract still governs
    }
  }
  cycleUsage = addUsage(cycleUsage, planResult.usage);
  cycleOutcomes = addOutcomes(cycleOutcomes, planResult.outcomes);
  addTurn(transcript, lead.name, 'lead', planOutput, estimateTurnCost(options.model || 'sonnet'));

  const planAuthAbort = abortOnAuthFailure(planOutput, lead.name);
  if (planAuthAbort) return planAuthAbort;

  // Quota detection — if plan hit the API limit, stop immediately
  if (isQuotaMessage(planOutput)) {
    logObservability({
      ts: new Date().toISOString(),
      id: executionId,
      squad: squad.name,
      agent: lead.name,
      provider: 'anthropic',
      model: options.model || modelForRole('lead'),
      trigger: 'scheduled',
      status: 'failed',
      duration_ms: Date.now() - cycleStartMs,
      input_tokens: cycleUsage.input_tokens,
      output_tokens: cycleUsage.output_tokens,
      cache_read_tokens: cycleUsage.cache_read_tokens,
      cache_write_tokens: cycleUsage.cache_write_tokens,
      cost_usd: cycleUsage.cost_usd,
      context_tokens: 0,
      ...outcomeFields(cycleOutcomes),
      error: 'Quota limit reached',
      task: options.task,
    });
    finishEvents(false);
    return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: false, reason: 'Quota limit reached' };
  }

  // Check if lead declared done immediately (nothing to do)
  const conv = await checkConvergence();
  if (conv.converged) {
    const goalsAfterEarly = snapshotGoals(squad.name);
    const goalsChangedEarly = diffGoals(goalsBefore, goalsAfterEarly);
    logObservability({
      ts: new Date().toISOString(),
      id: executionId,
      squad: squad.name,
      agent: lead.name,
      provider: 'anthropic',
      model: options.model || modelForRole('lead'),
      trigger: 'scheduled',
      status: 'completed',
      duration_ms: Date.now() - cycleStartMs,
      input_tokens: cycleUsage.input_tokens,
      output_tokens: cycleUsage.output_tokens,
      cache_read_tokens: cycleUsage.cache_read_tokens,
      cache_write_tokens: cycleUsage.cache_write_tokens,
      cost_usd: cycleUsage.cost_usd,
      context_tokens: 0,
      ...outcomeFields(cycleOutcomes),
      task: options.task,
      goals_before: Object.keys(goalsBefore).length > 0 ? goalsBefore : undefined,
      goals_after: Object.keys(goalsAfterEarly).length > 0 ? goalsAfterEarly : undefined,
      goals_changed: goalsChangedEarly.length > 0 ? goalsChangedEarly : undefined,
    });
    finishEvents(true);
    return { transcript, turnCount: transcript.turns.length, totalCost: cycleUsage.cost_usd, converged: true, reason: conv.reason };
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: EXECUTE — Workers run independently in parallel
  // ═══════════════════════════════════════════════════════════════════

  // Parse task assignments from lead's plan
  let taskAssignments = parseTaskAssignments(planOutput, [...workers, ...scanners]);

  // Zero parsed tasks with agents available = format failure, not "nothing to do".
  // Fail the turn loudly: re-prompt the lead ONCE with the exact dispatch format
  // before falling back to lead-works-directly (hq#452 — intelligence stalled here).
  if (taskAssignments.length === 0 && workers.length + scanners.length > 0) {
    writeLine(`  ${colors.yellow}[WARN] ${lead.name}: plan had no parseable task assignments — retrying with format reminder${RESET}`);
    const formatReminder = `Your previous plan could not be parsed into task assignments — no worker received any work. Re-emit ONLY the task list, one line per task, in EXACTLY this format (no prose around it):

- worker: [worker-name] | task: [specific instruction]
- scanner: [scanner-name] | task: [specific instruction]

Available workers: ${workers.map(w => w.name).join(', ') || '(none)'}
Available scanners: ${scanners.map(s => s.name).join(', ') || '(none)'}

Your previous plan, for reference:

${planOutput.slice(0, 3000)}`;
    const retryResult = await runIndependentAgent({
      agentName: lead.name, agentPath: lead.path, role: 'lead',
      squadName: squad.name, model: options.model || modelForRole('lead'),
      task: formatReminder, squadContext: '', cwd: squadCwd, verbose: options.verbose, timeout: options.timeout, events,
    });
    cycleUsage = addUsage(cycleUsage, retryResult.usage);
    cycleOutcomes = addOutcomes(cycleOutcomes, retryResult.outcomes);
    if (!isQuotaMessage(retryResult.text)) {
      addTurn(transcript, lead.name, 'lead', retryResult.text, estimateTurnCost(options.model || 'sonnet'));
      taskAssignments = parseTaskAssignments(retryResult.text, [...workers, ...scanners]);
    }
  }

  if (taskAssignments.length === 0) {
    // No tasks parsed — lead does the work directly
    writeLine(`  ${colors.yellow}[WARN] ${lead.name}: no parseable task assignments after retry — lead works directly, ${workers.length + scanners.length} agents idle${RESET}`);
    addTurn(transcript, lead.name, 'lead', '[Lead produced plan but no parseable task assignments. Lead should do the work directly in the review phase.]', estimateTurnCost('sonnet'));
  } else {
    log(`  execute: ${taskAssignments.length} tasks in parallel...`);

    // Run all assigned workers in parallel
    const workerPromises = taskAssignments.map(({ agent, task }) => {
      log(`    ${agent.name}: ${task.slice(0, 60)}...`);
      return runIndependentAgent({
        agentName: agent.name, agentPath: agent.path, role: agent.role,
        squadName: squad.name, model: options.model || modelForRole(agent.role),
        task, squadContext, cwd: squadCwd, verbose: options.verbose, timeout: options.timeout, events,
      }).then(result => ({ agent, output: result.text, usage: result.usage, outcomes: result.outcomes }));
    });

    const workerResults = await Promise.all(workerPromises);

    for (const { agent, output, usage, outcomes } of workerResults) {
      cycleUsage = addUsage(cycleUsage, usage);
      cycleOutcomes = addOutcomes(cycleOutcomes, outcomes);
      if (output.startsWith('[ERROR]')) {
        writeLine(`  ${colors.yellow}[WARN] ${agent.name}: ${output.slice(0, 80)}${RESET}`);
      }
      addTurn(transcript, agent.name, agent.role, output, estimateTurnCost(options.model || 'sonnet'));
    }

    // #990: a worker whose own handoff contradicts its DONE claim gets flagged
    // loudly — review/verify prompts enforce it; this makes it operator-visible.
    for (const r of workerResults) {
      const handoff = parseHandoff(r.output);
      if (handoff.contradictsDone) {
        writeLine(`  ${colors.yellow}[WARN] ${r.agent.name}: STATUS DONE contradicted by its own handoff (undone: ${handoff.undone || 'none'}; exits: ${handoff.exitCodes.join(',') || '—'})${RESET}`);
      }
    }

    const workerAuthFailure = workerResults.find(r => isAuthFailureMessage(r.output));
    if (workerAuthFailure) {
      const workerAuthAbort = abortOnAuthFailure(workerAuthFailure.output, workerAuthFailure.agent.name);
      if (workerAuthAbort) return workerAuthAbort;
    }

    // Fail-fast (#856): every dispatched agent came back quota-capped — the
    // window died mid-cycle. Review/verify would cap too; stop burning turns.
    if (workerResults.length > 0 && workerResults.every(r => isQuotaMessage(r.output))) {
      writeLine(`  ${colors.red}${squad.name}: all ${workerResults.length} dispatched agents hit the session limit — aborting cycle (skipping review/verify)${RESET}`);
      logObservability({
        ts: new Date().toISOString(),
        id: executionId,
        squad: squad.name,
        agent: lead.name,
        provider: 'anthropic',
        model: options.model || modelForRole('lead'),
        trigger: 'scheduled',
        status: 'failed',
        duration_ms: Date.now() - cycleStartMs,
        input_tokens: cycleUsage.input_tokens,
        output_tokens: cycleUsage.output_tokens,
        cache_read_tokens: cycleUsage.cache_read_tokens,
        cache_write_tokens: cycleUsage.cache_write_tokens,
        cost_usd: cycleUsage.cost_usd,
        context_tokens: 0,
        ...outcomeFields(cycleOutcomes),
        error: 'Quota limit reached',
        task: options.task,
      });
      finishEvents(false);
      return { transcript, turnCount: transcript.turns.length, totalCost: cycleUsage.cost_usd, converged: false, reason: 'Quota limit reached' };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: REVIEW — Lead evaluates worker output
  // ═══════════════════════════════════════════════════════════════════

  log(`  review: ${lead.name}...`);

  const reviewPrompt = `Review the work done by your team. The conversation transcript shows what each worker produced.

1. Read each worker's ## HANDOFF block FIRST (#990): a DONE status with a
   non-empty undone list or a failing exit code in commands is NOT done —
   treat it as incomplete and say so in your summary.
2. Check if workers actually committed code (PR numbers, commit SHAs)
3. Merge PRs that are ready: \`gh pr merge --squash --delete-branch --auto\`
4. Update goals.md if a goal was achieved
5. Update state.md with what was accomplished

End with:
## STATUS: DONE
Summary: [what was achieved]`;

  const reviewResult = await runIndependentAgent({
    agentName: lead.name, agentPath: lead.path, role: 'lead',
    squadName: squad.name, model: options.model || modelForRole('lead'),
    task: reviewPrompt, squadContext: `${squadContext}\n\n${serializeTranscript(transcript)}`,
    cwd: squadCwd, verbose: options.verbose, timeout: options.timeout, events,
  });
  const reviewOutput = reviewResult.text;
  cycleUsage = addUsage(cycleUsage, reviewResult.usage);
  cycleOutcomes = addOutcomes(cycleOutcomes, reviewResult.outcomes);
  addTurn(transcript, lead.name, 'lead', reviewOutput, estimateTurnCost(options.model || 'sonnet'));

  const reviewAuthAbort = abortOnAuthFailure(reviewOutput, lead.name);
  if (reviewAuthAbort) return reviewAuthAbort;

  // Fail-fast (#856): review turn capped — don't spend verifier turns on a dead window
  if (isQuotaMessage(reviewOutput)) {
    writeLine(`  ${colors.red}${squad.name}: review turn hit the session limit — aborting cycle (skipping verify)${RESET}`);
    logObservability({
      ts: new Date().toISOString(),
      id: executionId,
      squad: squad.name,
      agent: lead.name,
      provider: 'anthropic',
      model: options.model || modelForRole('lead'),
      trigger: 'scheduled',
      status: 'failed',
      duration_ms: Date.now() - cycleStartMs,
      input_tokens: cycleUsage.input_tokens,
      output_tokens: cycleUsage.output_tokens,
      cache_read_tokens: cycleUsage.cache_read_tokens,
      cache_write_tokens: cycleUsage.cache_write_tokens,
      cost_usd: cycleUsage.cost_usd,
      context_tokens: 0,
      ...outcomeFields(cycleOutcomes),
      error: 'Quota limit reached',
      task: options.task,
    });
    finishEvents(false);
    return { transcript, turnCount: transcript.turns.length, totalCost: cycleUsage.cost_usd, converged: false, reason: 'Quota limit reached' };
  }

  // Goals.md staleness check — warn if goals were not updated during review
  const goalsAfterReview = snapshotGoals(squad.name);
  const goalsChangedInReview = diffGoals(goalsBefore, goalsAfterReview);
  if (goalsChangedInReview.length === 0 && Object.keys(goalsBefore).length > 0) {
    writeLine(`  ${colors.yellow}[WARN] ${squad.name}: goals.md not updated after review — lead should update goals when work is completed${RESET}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 4: VERIFY — Quality gate
  // ═══════════════════════════════════════════════════════════════════

  if (verifiers.length > 0) {
    const verifier = verifiers[0];
    log(`  verify: ${verifier.name}...`);

    const contractSection = validationContract
      ? `\n## VALIDATION CONTRACT (from the plan — check EVERY assertion)\n${validationContract}\n\nReport per-assertion PASS/FAIL. The verdict can only be APPROVED when every assertion passes or the lead explicitly waived it with a reason in the transcript.\n`
      : '';

    const verifyPrompt = `Verify the work from this cycle. The transcript shows the plan and worker outputs.
${contractSection}
Check every PR and deliverable:
1. Build: does it pass?
2. Conflicts: is the PR mergeable?
3. Review comments: are ALL automated review comments addressed?
4. Correctness: does it match what the lead asked for?
5. Handoffs (#990): re-read each worker's ## HANDOFF block. A DONE claim
   contradicted by its own handoff (non-empty undone, failing exit codes,
   skipped procedures without reason) fails this check — the verdict must be
   REJECTED naming the contradiction.

End with:
## VERDICT: APPROVED (all checks pass)
or
## VERDICT: REJECTED (which check failed and why)`;

    const verifyResult = await runIndependentAgent({
      agentName: verifier.name, agentPath: verifier.path, role: 'verifier',
      squadName: squad.name, model: options.model || modelForRole('verifier'),
      task: verifyPrompt, squadContext: `${squadContext}\n\n${serializeTranscript(transcript)}`,
      cwd: squadCwd, verbose: options.verbose, timeout: options.timeout, events,
    });
    const verifyOutput = verifyResult.text;
    cycleUsage = addUsage(cycleUsage, verifyResult.usage);
    cycleOutcomes = addOutcomes(cycleOutcomes, verifyResult.outcomes);
    addTurn(transcript, verifier.name, 'verifier', verifyOutput, estimateTurnCost(options.model || 'haiku'));

    // ── #994: bounded remediation — ONE fix round when the verifier rejects.
    // Missions production data: every milestone needed 2-4 validation rounds;
    // one-shot passes are the exception. Our bounded runs get exactly one
    // remediation round; a second rejection converges not-approved and the
    // inbox owns the rest.
    const rejectedFirst = /##\s*VERDICT:\s*REJECTED/i.test(verifyOutput);
    if (rejectedFirst && workers.length > 0
        && !isQuotaMessage(verifyOutput) && !isAuthFailureMessage(verifyOutput)) {
      log(`  remediate: ${lead.name}... (one round, #994)`);
      const remediationPrompt = `The verifier REJECTED this cycle. Its verdict in the transcript names the exact failures${validationContract ? ' (including per-assertion FAILs against the validation contract)' : ''}.

Emit fix tasks scoped ONLY to the named failures — no new scope, no improvements:

\`\`\`plan
TASKS:
- worker: [worker-name] | task: [fix instruction naming the failed check/assertion]
\`\`\`

Max 2 tasks. If the rejection is not actionable by a worker (needs a human decision or external access), do NOT emit tasks — end with ## STATUS: BLOCKED [reason].`;
      const remediationResult = await runIndependentAgent({
        agentName: lead.name, agentPath: lead.path, role: 'lead',
        squadName: squad.name, model: options.model || modelForRole('lead'),
        task: remediationPrompt, squadContext: `${squadContext}\n\n${serializeTranscript(transcript)}`,
        cwd: squadCwd, verbose: options.verbose, timeout: options.timeout, events,
      });
      cycleUsage = addUsage(cycleUsage, remediationResult.usage);
      cycleOutcomes = addOutcomes(cycleOutcomes, remediationResult.outcomes);
      addTurn(transcript, lead.name, 'lead', remediationResult.text, estimateTurnCost(options.model || 'sonnet'));

      const fixAssignments = parseTaskAssignments(remediationResult.text, workers).slice(0, 2);
      if (fixAssignments.length > 0 && !isQuotaMessage(remediationResult.text)) {
        log(`  fix: ${fixAssignments.length} task(s), serial...`);
        // Serial on purpose: fix tasks routinely touch the same files.
        for (const { agent, task } of fixAssignments) {
          const fixResult = await runIndependentAgent({
            agentName: agent.name, agentPath: agent.path, role: agent.role,
            squadName: squad.name, model: options.model || modelForRole(agent.role),
            task, squadContext, cwd: squadCwd, verbose: options.verbose, timeout: options.timeout, events,
          });
          cycleUsage = addUsage(cycleUsage, fixResult.usage);
          cycleOutcomes = addOutcomes(cycleOutcomes, fixResult.outcomes);
          addTurn(transcript, agent.name, agent.role, fixResult.text, estimateTurnCost(options.model || 'sonnet'));
        }

        log(`  re-verify: ${verifier.name}...`);
        const reverifyResult = await runIndependentAgent({
          agentName: verifier.name, agentPath: verifier.path, role: 'verifier',
          squadName: squad.name, model: options.model || modelForRole('verifier'),
          task: verifyPrompt, squadContext: `${squadContext}\n\n${serializeTranscript(transcript)}`,
          cwd: squadCwd, verbose: options.verbose, timeout: options.timeout, events,
        });
        cycleUsage = addUsage(cycleUsage, reverifyResult.usage);
        cycleOutcomes = addOutcomes(cycleOutcomes, reverifyResult.outcomes);
        addTurn(transcript, verifier.name, 'verifier', reverifyResult.text, estimateTurnCost(options.model || 'haiku'));
      }
    }
  }

  // Determine final convergence
  const finalConv = await checkConvergence();

  // ═══════════════════════════════════════════════════════════════════
  // Observability — log conversation cycle as a single record
  // ═══════════════════════════════════════════════════════════════════

  const cycleDurationMs = Date.now() - cycleStartMs;
  const goalsAfterFinal = snapshotGoals(squad.name);
  const goalsChanged = diffGoals(goalsBefore, goalsAfterFinal);

  const obsRecord: ObservabilityRecord = {
    ts: new Date().toISOString(),
    id: executionId,
    squad: squad.name,
    agent: lead.name,
    provider: 'anthropic',
    model: options.model || modelForRole('lead'),
    trigger: 'scheduled',
    status: 'completed',
    duration_ms: cycleDurationMs,
    // Real token-level data captured from stream-json result events (#791 follow-up).
    input_tokens: cycleUsage.input_tokens,
    output_tokens: cycleUsage.output_tokens,
    cache_read_tokens: cycleUsage.cache_read_tokens,
    cache_write_tokens: cycleUsage.cache_write_tokens,
    cost_usd: cycleUsage.cost_usd,
    context_tokens: 0,
    ...outcomeFields(cycleOutcomes),
    task: options.task,
    goals_before: Object.keys(goalsBefore).length > 0 ? goalsBefore : undefined,
    goals_after: Object.keys(goalsAfterFinal).length > 0 ? goalsAfterFinal : undefined,
    goals_changed: goalsChanged.length > 0 ? goalsChanged : undefined,
  };
  logObservability(obsRecord);

  finishEvents(true);
  return {
    transcript,
    turnCount: transcript.turns.length,
    totalCost: cycleUsage.cost_usd,
    converged: finalConv.converged, // reflect actual convergence status
    reason: finalConv.reason || 'Cycle complete (plan → execute → review → verify)',
  };
  } finally {
    // Remove the per-run worktree on every exit path (success, early return,
    // or throw). No-op when isolation was skipped/fell back in-place (#440).
    worktree.cleanup();
  }
}

// =============================================================================
// Task Assignment Parser
// =============================================================================

interface TaskAssignment {
  agent: ClassifiedAgent;
  task: string;
}

/**
 * Parse task assignments from lead's plan output.
 * Looks for patterns like:
 *   - worker: worker-name | task: do something
 *   - scanner: scanner-name | task: scan something
 *   - Assigned: worker-name → do something
 */
function parseTaskAssignments(planOutput: string, availableAgents: ClassifiedAgent[]): TaskAssignment[] {
  const assignments: TaskAssignment[] = [];
  const lines = planOutput.split('\n');

  for (const line of lines) {
    // Pattern: "- worker: name | task: description"
    const pipeMatch = line.match(/(?:worker|scanner|agent):\s*(\S+)\s*\|\s*task:\s*(.+)/i);
    if (pipeMatch) {
      const agentName = pipeMatch[1].trim();
      const task = pipeMatch[2].trim();
      const agent = availableAgents.find(a => a.name === agentName || a.name.includes(agentName) || agentName.includes(a.name));
      if (agent && task) {
        assignments.push({ agent, task });
        continue;
      }
    }

    // Pattern: "Assigned: name → description" or "- name: description"
    const arrowMatch = line.match(/(?:assigned|assign):\s*(\S+)\s*[→→-]\s*(.+)/i);
    if (arrowMatch) {
      const agentName = arrowMatch[1].trim();
      const task = arrowMatch[2].trim();
      const agent = availableAgents.find(a => a.name === agentName || a.name.includes(agentName) || agentName.includes(a.name));
      if (agent && task) {
        assignments.push({ agent, task });
        continue;
      }
    }
  }

  // No silent fallback on parse failure — the caller re-prompts the lead once
  // with the exact format, then fails loudly (hq#452). The old behavior (assign
  // every worker the full plan) hid format failures and ignored scanner-only squads.
  return assignments;
}

// =============================================================================
// Transcript Persistence
// =============================================================================

export function saveTranscript(transcript: Transcript): string | null {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;

  const convDir = join(squadsDir, '..', 'conversations', transcript.squad);
  if (!existsSync(convDir)) mkdirSync(convDir, { recursive: true });

  const id = Date.now().toString(36);
  const filePath = join(convDir, `${id}.md`);

  const lines = [
    `# Conversation: ${transcript.squad}`,
    `Started: ${transcript.startedAt}`,
    `Turns: ${transcript.turns.length}`,
    `Estimated cost: $${transcript.totalCost.toFixed(2)}`,
    '', '---', '',
  ];

  for (const turn of transcript.turns) {
    lines.push(`## ${turn.agent} (${turn.role}) — ${turn.timestamp}`);
    lines.push('');
    lines.push(turn.content);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  writeFileSync(filePath, lines.join('\n'));
  return filePath;
}
