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

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { spawn } from 'child_process';
import { homedir } from 'os';

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
} from './run-context.js';
import {
  buildAgentEnv,
  resolveGuardrailSettings,
} from './execution-engine.js';
import { type ExecutionContext } from './run-types.js';
import { getBotGhEnv } from './github.js';
import { generateExecutionId, getClaudeModelAlias } from './run-utils.js';
import { colors, RESET, writeLine, bold } from './terminal.js';

// =============================================================================
// Configuration
// =============================================================================

export interface ConversationOptions {
  task?: string;
  maxTurns?: number;
  costCeiling?: number;
  verbose?: boolean;
  model?: string;
  /** Token budget for the squad (output tokens). Default: 50K */
  tokenBudget?: number;
}

/** Default output token budget per squad. Lead should plan within this. */
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

  const agentEnv = buildAgentEnv(cleanEnv as Record<string, string>, execContext, { ghToken: botGhToken });

  const claudeArgs: string[] = ['--print'];
  if (process.env.SQUADS_SKIP_PERMISSIONS === '1') {
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

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      const output = Buffer.concat(chunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim();
      // Detect quota hit — Claude returns this when rate limited
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

    child.on('error', (err) => resolve(`[ERROR] ${agentName} failed to spawn: ${err.message}`));
    setTimeout(() => { child.kill('SIGTERM'); resolve(`[ERROR] ${agentName} timed out after 8 minutes`); }, 8 * 60 * 1000);
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

  const tokenBudget = options.tokenBudget || DEFAULT_TOKEN_BUDGET;
  const costCeiling = options.costCeiling || DEFAULT_COST_CEILING;
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

  log(`${squad.name}: ${allAgents.length} agents (${leads.length}L ${scanners.length}S ${workers.length}W ${verifiers.length}V) budget: ${Math.round(tokenBudget / 1000)}K tokens`);

  // Build squad context once (shared by all agents)
  const contextRole: ContextRole = lead.name.includes('company-lead') ? 'coo' : 'lead';
  const squadContext = gatherSquadContext(squad.name, lead.name, {
    agentPath: lead.path, role: contextRole,
  });

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 1: PLAN — Lead scopes work within budget
  // ═══════════════════════════════════════════════════════════════════

  log(`  plan: ${lead.name}...`);

  const workerNames = workers.map(w => w.name).join(', ') || '(no workers — do the work yourself)';
  const scannerNames = scanners.map(s => s.name).join(', ');

  const planPrompt = `You are ${lead.name} (lead) in squad ${squad.name}.

Read your full agent definition at ${lead.path} and follow its instructions.

## Your Job: PLAN this cycle

You have a token budget of ${Math.round(tokenBudget / 1000)}K output tokens for the whole squad.
Each worker task uses ~5-10K tokens. Plan accordingly — max ${Math.floor(tokenBudget / 10000)} tasks.

Available workers: ${workerNames}
Available scanners: ${scannerNames || '(none)'}

1. Read feedback.md — address corrections FIRST
2. Read goals.md — pick the TOP priority goal for this cycle
3. Check the repo: open issues, open PRs, recent commits
4. Create a PLAN with specific task assignments

## Output Format

\`\`\`plan
GOAL: [which goal this cycle advances]
TASKS:
- worker: [worker-name] | task: [specific instruction with issue number or PR number]
- worker: [worker-name] | task: [specific instruction]
${scannerNames ? '- scanner: [scanner-name] | task: [what to scan for]' : ''}
\`\`\`

Then end with:
## STATUS: CONTINUE

${squadContext}`;

  const planOutput = await runIndependentAgent({
    agentName: lead.name, agentPath: lead.path, role: 'lead',
    squadName: squad.name, model: options.model || modelForRole('lead'),
    task: options.task || planPrompt, squadContext: '', cwd: squadCwd,
  });
  addTurn(transcript, lead.name, 'lead', planOutput, estimateTurnCost(options.model || 'sonnet'));

  // Quota detection — if plan hit the API limit, stop immediately
  if (planOutput.includes('[QUOTA]') || planOutput.includes('hit your limit')) {
    return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: false, reason: 'Quota limit reached' };
  }

  // Check if lead declared done immediately (nothing to do)
  const conv = detectConvergence(transcript, maxTurns, costCeiling);
  if (conv.converged) {
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
  return {
    transcript,
    turnCount: transcript.turns.length,
    totalCost: transcript.totalCost,
    converged: finalConv.converged || true, // plan→execute→review→verify is always one pass
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
    // Give the first worker the whole plan as context
    const firstWorker = availableAgents.find(a => a.role === 'worker');
    if (firstWorker) {
      assignments.push({
        agent: firstWorker,
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
