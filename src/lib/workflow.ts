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
  modelForRole,
  createTranscript,
  serializeTranscript,
  addTurn,
  detectConvergence,
  estimateTurnCost,
} from './conversation.js';
import {
  type Squad,
  findSquadsDir,
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
import { DEFAULT_TIMEOUT_MINUTES } from './run-types.js';
import { type ExecutionContext } from './run-types.js';
import { loadProjectConfig } from './config.js';
import { getBotGhEnv } from './github.js';
import { generateExecutionId, getClaudeModelAlias } from './run-utils.js';
import { colors, RESET, writeLine } from './terminal.js';
import {
  logObservability,
  snapshotGoals,
  diffGoals,
  type ObservabilityRecord,
} from './observability.js';

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
  /** Token budget for the squad (output tokens). Default: 50K */
  tokenBudget?: number;
  /** Cycle focus — changes the lead's planning behavior */
  focus?: CycleFocus;
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
  /** Full squad context (goals, feedback, priorities, etc.) */
  squadContext: string;
  cwd: string;
}

/**
 * Run a single agent independently via `claude --print --allowedTools`.
 * Agent gets: their task + squad context. No shared transcript.
 */
async function runIndependentAgent(config: AgentRunConfig): Promise<string> {
  const { agentName, agentPath, role, squadName, task, squadContext } = config;

  const prompt = `You are ${agentName} (${role}) in squad ${squadName}.

Read your full agent definition at ${agentPath} and follow its instructions.

## Your Task

${task}

${squadContext}

## Output Requirements

- Commit your work (git add, commit, push)
- Open PRs targeting develop (product repos) or push to main (domain repos)
- Run the build before pushing — fix if it fails
- Report: branch name, PR number, build status, what you changed
- End with: ## STATUS: DONE or ## STATUS: BLOCKED [reason]`;

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
  const writeTools = ['Write', 'Edit', 'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(python3:*)', 'Bash(docker:*)', 'Bash(duckdb:*)', 'Bash(bq:*)', 'Bash(gcloud:*)', 'Bash(gws:*)', 'Bash(stripe:*)', 'Bash(mkdir:*)', 'Bash(cp:*)', 'Bash(mv:*)', 'Bash(echo:*)', 'Bash(chmod:*)', 'Bash(squads:*)', 'Agent'];
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

  const claudeArgs: string[] = ['--print'];
  if (process.env.SQUADS_SKIP_PERMISSIONS === '1') {
    claudeArgs.push('--dangerously-skip-permissions');
  } else {
    const tools = toolsByRole[role] || [...readTools, ...writeTools];
    claudeArgs.push('--allowedTools', ...tools);
  }
  claudeArgs.push('--disable-slash-commands');
  const guardrailPath = resolveGuardrailSettings(config.cwd);
  if (guardrailPath) claudeArgs.push('--settings', guardrailPath);
  if (claudeModel) claudeArgs.push('--model', claudeModel);

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn('claude', claudeArgs, {
      cwd: config.cwd, env: agentEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdin.write(prompt);
    child.stdin.end();

    // Timeout: configurable via env var, defaults from run-types.ts
    const envTimeout = process.env.SQUADS_AGENT_TIMEOUT_MINUTES;
    const timeoutMinutes = envTimeout ? parseInt(envTimeout, 10) : DEFAULT_TIMEOUT_MINUTES;
    const timeout = setTimeout(() => { child.kill('SIGTERM'); resolve(`[ERROR] ${agentName} timed out after ${timeoutMinutes} minutes`); }, timeoutMinutes * 60 * 1000);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      if (output.includes('hit your limit') || output.includes('rate limit')) {
        resolve(`[QUOTA] ${agentName}: API limit reached`);
      } else if (output.length > 0) {
        resolve(output);
      } else if (code !== 0) {
        resolve(`[ERROR] ${agentName} exited with code ${code}${stderr ? ': ' + stderr.slice(0, 200) : ''}`);
      } else {
        resolve(`[${agentName} completed with no output]`);
      }
    });

    child.on('error', (err) => { clearTimeout(timeout); resolve(`[ERROR] ${agentName} failed to spawn: ${err.message}`); });
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

function buildAgentRoster(squad: Squad, squadsDir: string): ClassifiedAgent[] {
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
  const transcript = createTranscript(squad.name);

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

  const allAgents = buildAgentRoster(squad, squadsDir);
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

  log(`${squad.name}: ${allAgents.length} agents (${leads.length}L ${scanners.length}S ${workers.length}W ${verifiers.length}V) budget: ${Math.round(tokenBudget / 1000)}K tokens`);

  // Build squad context once (shared by all agents)
  // Resolve context role from frontmatter; leads default to 'lead', COO agents have role: coo
  const contextRole: ContextRole = resolveContextRoleFromAgent(lead.path, lead.name);
  const squadContext = gatherSquadContext(squad.name, lead.name, {
    agentPath: lead.path, role: contextRole,
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: PLAN — Lead scopes work within budget
  // ═══════════════════════════════════════════════════════════════════

  log(`  plan: ${lead.name}...`);

  const workerNames = workers.map(w => w.name).join(', ') || '(no workers — do the work yourself)';
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

  const planOutput = await runIndependentAgent({
    agentName: lead.name, agentPath: lead.path, role: 'lead',
    squadName: squad.name, model: options.model || modelForRole('lead'),
    task: options.task ? `${options.task}\n\n${planPrompt}` : planPrompt, squadContext: '', cwd: squadCwd,
  });
  addTurn(transcript, lead.name, 'lead', planOutput, estimateTurnCost(options.model || 'sonnet'));

  // Quota detection — if plan hit the API limit, stop immediately
  if (planOutput.includes('[QUOTA]') || planOutput.includes('hit your limit')) {
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
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: transcript.totalCost,
      context_tokens: 0,
      error: 'Quota limit reached',
      task: options.task,
    });
    return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: false, reason: 'Quota limit reached' };
  }

  // Check if lead declared done immediately (nothing to do)
  const conv = detectConvergence(transcript, maxTurns, costCeiling);
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
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: transcript.totalCost,
      context_tokens: 0,
      task: options.task,
      goals_before: Object.keys(goalsBefore).length > 0 ? goalsBefore : undefined,
      goals_after: Object.keys(goalsAfterEarly).length > 0 ? goalsAfterEarly : undefined,
      goals_changed: goalsChangedEarly.length > 0 ? goalsChangedEarly : undefined,
    });
    return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 2: EXECUTE — Workers run independently in parallel
  // ═══════════════════════════════════════════════════════════════════

  // Parse task assignments from lead's plan
  const taskAssignments = parseTaskAssignments(planOutput, [...workers, ...scanners]);

  if (taskAssignments.length === 0) {
    // No tasks parsed — lead does the work directly
    log(`  execute: no task assignments found, lead works directly`);
    addTurn(transcript, lead.name, 'lead', '[Lead produced plan but no parseable task assignments. Lead should do the work directly in the review phase.]', estimateTurnCost('sonnet'));
  } else {
    log(`  execute: ${taskAssignments.length} tasks in parallel...`);

    // Run all assigned workers in parallel
    const workerPromises = taskAssignments.map(({ agent, task }) => {
      log(`    ${agent.name}: ${task.slice(0, 60)}...`);
      return runIndependentAgent({
        agentName: agent.name, agentPath: agent.path, role: agent.role,
        squadName: squad.name, model: options.model || modelForRole(agent.role),
        task, squadContext, cwd: squadCwd,
      }).then(output => ({ agent, output }));
    });

    const workerResults = await Promise.all(workerPromises);

    for (const { agent, output } of workerResults) {
      if (output.startsWith('[ERROR]')) {
        writeLine(`  ${colors.yellow}[WARN] ${agent.name}: ${output.slice(0, 80)}${RESET}`);
      }
      addTurn(transcript, agent.name, agent.role, output, estimateTurnCost(options.model || 'sonnet'));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 3: REVIEW — Lead evaluates worker output
  // ═══════════════════════════════════════════════════════════════════

  log(`  review: ${lead.name}...`);

  const reviewPrompt = `Review the work done by your team. The conversation transcript shows what each worker produced.

1. Check if workers actually committed code (PR numbers, commit SHAs)
2. Merge PRs that are ready: \`gh pr merge --squash --delete-branch --auto\`
3. Update goals.md if a goal was achieved
4. Update state.md with what was accomplished

End with:
## STATUS: DONE
Summary: [what was achieved]`;

  const reviewOutput = await runIndependentAgent({
    agentName: lead.name, agentPath: lead.path, role: 'lead',
    squadName: squad.name, model: options.model || modelForRole('lead'),
    task: reviewPrompt, squadContext: `${squadContext}\n\n${serializeTranscript(transcript)}`,
    cwd: squadCwd,
  });
  addTurn(transcript, lead.name, 'lead', reviewOutput, estimateTurnCost(options.model || 'sonnet'));

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

    const verifyPrompt = `Verify the work from this cycle. The transcript shows the plan and worker outputs.

Check every PR and deliverable:
1. Build: does it pass?
2. Conflicts: is the PR mergeable?
3. Review comments: are ALL automated review comments addressed?
4. Correctness: does it match what the lead asked for?

End with:
## VERDICT: APPROVED (all checks pass)
or
## VERDICT: REJECTED (which check failed and why)`;

    const verifyOutput = await runIndependentAgent({
      agentName: verifier.name, agentPath: verifier.path, role: 'verifier',
      squadName: squad.name, model: options.model || modelForRole('verifier'),
      task: verifyPrompt, squadContext: `${squadContext}\n\n${serializeTranscript(transcript)}`,
      cwd: squadCwd,
    });
    addTurn(transcript, verifier.name, 'verifier', verifyOutput, estimateTurnCost(options.model || 'haiku'));
  }

  // Determine final convergence
  const finalConv = detectConvergence(transcript, maxTurns, costCeiling);

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
    input_tokens: 0,   // token-level data not available from spawned agents
    output_tokens: transcript.turns.length > 0 ? transcript.turns.reduce((acc, t) => acc + t.content.length, 0) : 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: transcript.totalCost,
    context_tokens: 0,
    task: options.task,
    goals_before: Object.keys(goalsBefore).length > 0 ? goalsBefore : undefined,
    goals_after: Object.keys(goalsAfterFinal).length > 0 ? goalsAfterFinal : undefined,
    goals_changed: goalsChanged.length > 0 ? goalsChanged : undefined,
  };
  logObservability(obsRecord);

  return {
    transcript,
    turnCount: transcript.turns.length,
    totalCost: transcript.totalCost,
    converged: finalConv.converged, // reflect actual convergence status
    reason: finalConv.reason || 'Cycle complete (plan → execute → review → verify)',
  };
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

  // If no assignments parsed but workers exist, assign all workers the lead's full plan
  if (assignments.length === 0 && availableAgents.length > 0) {
    const workers = availableAgents.filter(a => a.role === 'worker');
    for (const worker of workers) {
      assignments.push({
        agent: worker,
        task: `The lead produced this plan. Execute the most important task:\n\n${planOutput.slice(0, 3000)}`,
      });
    }
  }

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
