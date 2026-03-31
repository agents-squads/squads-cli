/**
 * Squad Conversation Workflow — Orchestrates multi-agent conversations.
 *
 * Lead briefs → scanners discover → workers execute → lead reviews →
 * loop until convergence or budget exhausted.
 *
 * Each agent runs as a full Claude Code session with tool access
 * (git, gh, Read, Write, etc.) via `claude --print --allowedTools`.
 */

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { execSync } from 'child_process';
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
import { colors, RESET, writeLine } from './terminal.js';

// =============================================================================
// Configuration
// =============================================================================

export interface ConversationOptions {
  task?: string;
  maxTurns?: number;
  costCeiling?: number;
  verbose?: boolean;
  model?: string;
}

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_COST_CEILING = 25;

// =============================================================================
// Agent Turn Execution (with tools)
// =============================================================================

interface AgentTurnConfig {
  agentName: string;
  agentPath: string;
  role: AgentRole;
  squadName: string;
  model: string;
  transcript: Transcript;
  task?: string;
  cwd?: string;
}

/**
 * Execute a single agent turn via `claude --print --allowedTools`.
 * Agent has full tool access (git, gh, Read, Write, etc.) AND
 * we capture the output for the conversation transcript.
 */
async function executeAgentTurn(config: AgentTurnConfig): Promise<string> {
  const { agentName, agentPath, role, squadName, transcript, task } = config;

  // Build prompt: role instructions + squad context + transcript
  const transcriptContext = transcript.turns.length > 0
    ? `\n== CONVERSATION SO FAR ==\n${serializeTranscript(transcript)}\n== END CONVERSATION ==`
    : '';

  const contextRole: ContextRole = agentName.includes('company-lead') ? 'coo' : (role as ContextRole);
  const squadContext = gatherSquadContext(squadName, agentName, {
    agentPath, role: contextRole,
  });

  // Load role instructions
  const rolesPath = join(dirname(agentPath), '..', '..', 'config', 'conversation-roles.md');
  const rolesContent = existsSync(rolesPath) ? readFileSync(rolesPath, 'utf-8') : '';

  let roleInstructions: string;
  if (task && transcript.turns.length === 0) {
    roleInstructions = `## Founder Directive\n\n${task}`;
  } else {
    const sectionName = role === 'lead'
      ? (transcript.turns.length === 0 ? 'Lead (first turn)' : 'Lead (review turn)')
      : role.charAt(0).toUpperCase() + role.slice(1);
    const sectionMatch = rolesContent.match(new RegExp(`## ${sectionName}\\n([\\s\\S]*?)(?=\\n## |$)`));
    roleInstructions = sectionMatch ? `## Your Role: ${role}\n\n${sectionMatch[1].trim()}` : `## Your Role: ${role}`;
  }

  const formatMatch = rolesContent.match(/## Output Format[\s\S]*$/);
  const outputFormat = formatMatch ? formatMatch[0] : '';

  const prompt = `You are ${agentName} (${role}) in squad ${squadName}.

Read your full agent definition at ${agentPath} and follow its instructions.

${roleInstructions}
${squadContext}
${transcriptContext}

${outputFormat}`;

  // Resolve model
  const resolvedModel = config.model || modelForRole(role);
  const claudeModel = getClaudeModelAlias(resolvedModel) || resolvedModel;

  // Build env with bot token + squad credentials
  const { CLAUDECODE: _cc, ANTHROPIC_API_KEY: _ak, ...cleanEnv } = process.env;

  let botGhToken: string | undefined;
  try {
    const ghEnv = await getBotGhEnv();
    botGhToken = ghEnv.GH_TOKEN;
  } catch { /* falls back to user auth */ }

  const taskTypeMap: Record<AgentRole, ExecutionContext['taskType']> = {
    lead: 'lead', scanner: 'research', worker: 'execution', verifier: 'evaluation',
  };
  const execContext: ExecutionContext = {
    squad: squadName,
    agent: agentName,
    taskType: taskTypeMap[role] || 'execution',
    trigger: 'scheduled',
    executionId: generateExecutionId(),
  };

  const agentEnv = buildAgentEnv(cleanEnv as Record<string, string>, execContext, {
    ghToken: botGhToken,
  });

  // Build claude args: --print for output capture + --allowedTools for tool access
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

  // Inject guardrail hooks
  const cwd = config.cwd || process.cwd();
  const guardrailPath = resolveGuardrailSettings(cwd);
  if (guardrailPath) claudeArgs.push('--settings', guardrailPath);

  if (claudeModel) claudeArgs.push('--model', claudeModel);
  // Prompt via stdin to avoid OS arg length limits

  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn('claude', claudeArgs, {
      cwd,
      env: agentEnv,
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
      if (output.length > 0) {
        resolve(output);
      } else if (code !== 0) {
        resolve(`[ERROR] Agent ${agentName} exited with code ${code}${stderr ? ': ' + stderr.slice(0, 200) : ''}`);
      } else {
        resolve(`[${agentName} completed with no output]`);
      }
    });

    child.on('error', (err) => {
      resolve(`[ERROR] Agent ${agentName} failed to spawn: ${err.message}`);
    });

    // Timeout: 20 min per turn
    setTimeout(() => {
      child.kill('SIGTERM');
      resolve(`[ERROR] Agent ${agentName} timed out after 20 minutes`);
    }, 20 * 60 * 1000);
  });
}

// =============================================================================
// Conversation Orchestrator
// =============================================================================

interface ClassifiedAgent {
  name: string;
  role: AgentRole;
  path: string;
}

function buildTurnPlan(squad: Squad, squadsDir: string): ClassifiedAgent[] {
  const agents: ClassifiedAgent[] = [];
  for (const agent of squad.agents) {
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
 * Run a full squad conversation with tool-capable agents.
 *
 * Turn order per cycle:
 * 1. Lead briefs (or founder directive on first turn)
 * 2. Scanners discover (cycle 1 only)
 * 3. Workers execute (with full tool access)
 * 4. Lead reviews worker output
 * 5. Verifiers check
 * 6. Check convergence → loop or exit
 */
export async function runConversation(
  squad: Squad,
  options: ConversationOptions = {},
): Promise<ConversationResult> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    return {
      transcript: createTranscript(squad.name),
      turnCount: 0, totalCost: 0, converged: true,
      reason: 'No squads directory found',
    };
  }

  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
  const costCeiling = options.costCeiling || DEFAULT_COST_CEILING;
  const transcript = createTranscript(squad.name);

  // Resolve squad's working directory from repo field
  let squadCwd = process.cwd();
  if (squad.repo) {
    const repoName = squad.repo.split('/').pop();
    if (repoName) {
      const reposRoot = join(squadsDir, '..', '..', '..');
      const candidatePath = join(reposRoot, repoName);
      if (existsSync(candidatePath)) {
        squadCwd = candidatePath;
      }
    }
  }

  // Classify agents
  const allAgents = buildTurnPlan(squad, squadsDir);
  const leads = allAgents.filter(a => a.role === 'lead');
  const scanners = allAgents.filter(a => a.role === 'scanner');
  const workers = allAgents.filter(a => a.role === 'worker');
  const verifiers = allAgents.filter(a => a.role === 'verifier');

  if (leads.length === 0) {
    return {
      transcript, turnCount: 0, totalCost: 0, converged: true,
      reason: 'No lead agent found',
    };
  }

  const lead = leads[0];
  const log = (msg: string) => {
    writeLine(`  ${colors.dim}${msg}${RESET}`);
  };

  log(`${squad.name}: ${allAgents.length} agents (${leads.length}L ${scanners.length}S ${workers.length}W ${verifiers.length}V)`);

  // === CYCLE LOOP ===
  let cycleCount = 0;
  const MAX_CYCLES = 5;

  while (cycleCount < MAX_CYCLES) {
    cycleCount++;

    // Step 1: Lead briefs
    log(`  cycle ${cycleCount}: ${lead.name} (lead)...`);
    const leadOutput = await executeAgentTurn({
      agentName: lead.name, agentPath: lead.path, role: 'lead',
      squadName: squad.name, model: options.model || modelForRole('lead'),
      transcript, task: cycleCount === 1 ? options.task : undefined, cwd: squadCwd,
    });
    addTurn(transcript, lead.name, 'lead', leadOutput, estimateTurnCost(options.model || 'sonnet'));

    let conv = detectConvergence(transcript, maxTurns, costCeiling);
    if (conv.converged) {
      return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
    }

    // Step 2: Scanners (cycle 1 only, sequential)
    if (cycleCount === 1 && scanners.length > 0) {
      for (const scanner of scanners) {
        log(`  cycle ${cycleCount}: ${scanner.name} (scanner)...`);
        const output = await executeAgentTurn({
          agentName: scanner.name, agentPath: scanner.path, role: 'scanner',
          squadName: squad.name, model: options.model || modelForRole('scanner'),
          transcript, cwd: squadCwd,
        });
        addTurn(transcript, scanner.name, 'scanner', output, estimateTurnCost(options.model || 'haiku'));
      }

      conv = detectConvergence(transcript, maxTurns, costCeiling);
      if (conv.converged) {
        return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
      }
    }

    // Step 3: Workers execute (sequential — each sees previous worker's output)
    for (const worker of workers) {
      log(`  cycle ${cycleCount}: ${worker.name} (worker)...`);
      const output = await executeAgentTurn({
        agentName: worker.name, agentPath: worker.path, role: 'worker',
        squadName: squad.name, model: options.model || modelForRole('worker'),
        transcript, cwd: squadCwd,
      });
      if (output.startsWith('[ERROR]')) {
        writeLine(`  ${colors.yellow}[WARN] ${worker.name}: ${output.slice(0, 80)}${RESET}`);
      }
      addTurn(transcript, worker.name, 'worker', output, estimateTurnCost(options.model || 'sonnet'));
    }

    conv = detectConvergence(transcript, maxTurns, costCeiling);
    if (conv.converged) {
      return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
    }

    // Step 4: Lead reviews
    log(`  cycle ${cycleCount}: ${lead.name} (review)...`);
    const reviewOutput = await executeAgentTurn({
      agentName: lead.name, agentPath: lead.path, role: 'lead',
      squadName: squad.name, model: options.model || modelForRole('lead'),
      transcript, cwd: squadCwd,
    });
    addTurn(transcript, lead.name, 'lead', reviewOutput, estimateTurnCost(options.model || 'sonnet'));

    conv = detectConvergence(transcript, maxTurns, costCeiling);
    if (conv.converged) {
      return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
    }

    // Step 5: Verifiers
    for (const verifier of verifiers) {
      log(`  cycle ${cycleCount}: ${verifier.name} (verifier)...`);
      const output = await executeAgentTurn({
        agentName: verifier.name, agentPath: verifier.path, role: 'verifier',
        squadName: squad.name, model: options.model || modelForRole('verifier'),
        transcript, cwd: squadCwd,
      });
      addTurn(transcript, verifier.name, 'verifier', output, estimateTurnCost(options.model || 'haiku'));
    }

    if (verifiers.length > 0) {
      conv = detectConvergence(transcript, maxTurns, costCeiling);
      if (conv.converged) {
        return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
      }
    }
  }

  return {
    transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost,
    converged: false, reason: `Max cycles reached (${MAX_CYCLES})`,
  };
}

// =============================================================================
// Transcript Persistence
// =============================================================================

export function saveTranscript(transcript: Transcript): string | null {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;

  const convDir = join(squadsDir, '..', 'conversations', transcript.squad);
  if (!existsSync(convDir)) {
    mkdirSync(convDir, { recursive: true });
  }

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
