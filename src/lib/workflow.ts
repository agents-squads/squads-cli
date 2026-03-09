/**
 * Squad Conversation Workflow — Orchestrates multi-agent conversations.
 *
 * Lead briefs → scanners discover → workers execute → lead reviews →
 * loop until convergence or budget exhausted.
 *
 * CLI manages turns (deterministic), lead manages content (creative).
 */

import { join } from 'path';
import { existsSync, writeFileSync, mkdirSync } from 'fs';;
import { execSync } from 'child_process';;

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

// =============================================================================
// Configuration
// =============================================================================

export interface ConversationOptions {
  /** Override lead's briefing with a founder directive */
  task?: string;
  /** Maximum turns before stopping (default: 20) */
  maxTurns?: number;
  /** Cost ceiling in USD (default: 25) */
  costCeiling?: number;
  /** Verbose logging */
  verbose?: boolean;
  /** Model override for all agents */
  model?: string;
}

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_COST_CEILING = 25;

// =============================================================================
// Agent Turn Execution
// =============================================================================

interface AgentTurnConfig {
  agentName: string;
  agentPath: string;
  role: AgentRole;
  squadName: string;
  model: string;
  transcript: Transcript;
  task?: string;
  /** Working directory for the agent process (defaults to process.cwd()) */
  cwd?: string;
}

/**
 * Execute a single agent turn via `claude --print`.
 * Returns the agent's text output.
 */
function executeAgentTurn(config: AgentTurnConfig): string {
  const { agentName, agentPath, role, squadName, model: _model, transcript, task } = config;

  // Build the prompt: agent definition + transcript context + role instructions
  const transcriptContext = serializeTranscript(transcript);

  let roleInstructions: string;
  switch (role) {
    case 'lead':
      if (transcript.turns.length === 0 && task) {
        // First turn with founder directive — replaces lead briefing
        roleInstructions = `## Founder Directive\n\n${task}\n\nBrief the team on this directive. Set priorities and assign work.`;
      } else if (transcript.turns.length === 0) {
        roleInstructions = `## Your Role: Lead\n\nYou are starting a new squad session. Brief the team:\n1. Review open issues and PRs\n2. Set priorities for this session\n3. Assign work to workers\n4. Be specific about what each worker should do`;
      } else {
        roleInstructions = `## Your Role: Lead (Review)\n\nReview the work done so far. Either:\n- Request specific changes from workers\n- Approve and signal completion if quality is sufficient\n- Merge PRs that pass CI using \`gh pr merge --squash --delete-branch\``;
      }
      break;
    case 'scanner':
      roleInstructions = `## Your Role: Scanner\n\nScan for issues, gaps, and opportunities. Report findings concisely. Do NOT fix anything — just discover and report.`;
      break;
    case 'worker':
      roleInstructions = `## Your Role: Worker\n\nExecute the work assigned by the lead. Create branches, write code, open PRs to develop. Be focused and efficient.`;
      break;
    case 'verifier':
      roleInstructions = `## Your Role: Verifier\n\nVerify that work meets quality standards. Check PRs, run tests, validate output. Report pass/fail with specifics.`;
      break;
  }

  const prompt = `You are ${agentName} (${role}) in squad ${squadName}.

Read your full agent definition at ${agentPath} and follow its instructions.

${roleInstructions}

${transcriptContext}

IMPORTANT:
- Be concise. Your output becomes part of a shared transcript.
- Reference specific issue numbers, PR numbers, and file paths.
- If you create a PR, include the PR number in your output.
- If there's nothing to do, say "Nothing to do" clearly.
- When done, summarize what you did in 2-3 sentences.`;

  // Resolve model: CLI override > role default
  const resolvedModel = config.model || modelForRole(role);

  // Execute via claude --print (captures output)
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  try {
    const output = execSync(
      `claude --print --dangerously-skip-permissions --model ${resolvedModel} -- '${escapedPrompt}'`,
      {
        cwd: config.cwd || process.cwd(),
        timeout: 15 * 60 * 1000, // 15 min per turn
        maxBuffer: 10 * 1024 * 1024, // 10MB
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDECODE: '', // Allow nested sessions
          ANTHROPIC_API_KEY: undefined, // Use Max subscription
        },
      }
    );
    return output.trim();
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    // If the command produced output before failing, use it
    if (error.stdout && error.stdout.trim().length > 0) {
      return error.stdout.trim();
    }
    return `[ERROR] Agent ${agentName} failed: ${error.message || 'unknown error'}`;
  }
}

/**
 * Async version of executeAgentTurn for parallel execution.
 * Same logic, but returns a Promise instead of blocking.
 */
function executeAgentTurnAsync(config: AgentTurnConfig): Promise<string> {
  const { agentName, agentPath, role, squadName, model: _model, transcript, task } = config;

  let roleInstructions = '';
  switch (role) {
    case 'lead':
      roleInstructions = task
        ? `FOUNDER DIRECTIVE: ${task}\n\nBrief the team on this directive. Assign specific tasks to scanners and workers.`
        : 'Review the conversation so far. Assess worker output. Direct next actions or declare convergence.';
      break;
    case 'scanner':
      roleInstructions = 'Scan for issues, data, or signals relevant to the lead\'s brief. Report findings concisely.';
      break;
    case 'worker':
      roleInstructions = 'Execute the specific task assigned by the lead. Produce concrete output (PRs, issues, content, analysis).';
      break;
    case 'verifier':
      roleInstructions = 'Verify the worker\'s output meets quality standards. Check for errors, omissions, and alignment with goals.';
      break;
  }

  const transcriptContext = transcript.turns.length > 0
    ? `\n== CONVERSATION SO FAR ==\n${serializeTranscript(transcript)}\n== END CONVERSATION ==`
    : '';

  const resolvedModel = config.model || modelForRole(role);
  const prompt = `You are ${agentName} (${role}) in squad ${squadName}.

Read your full agent definition at ${agentPath} and follow its instructions.

${roleInstructions}

${transcriptContext}

IMPORTANT:
- Be concise. Your output becomes part of a shared transcript.
- Reference specific issue numbers, PR numbers, and file paths.
- If you create a PR, include the PR number in your output.
- If there's nothing to do, say "Nothing to do" clearly.
- When done, summarize what you did in 2-3 sentences.`;

  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  return new Promise((resolve) => {
    exec(
      `claude --print --dangerously-skip-permissions --model ${resolvedModel} -- '${escapedPrompt}'`,
      {
        cwd: config.cwd || process.cwd(),
        timeout: 15 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf-8',
        env: {
          ...process.env,
          CLAUDECODE: '',
          ANTHROPIC_API_KEY: undefined as unknown as string,
        },
      },
      (error, stdout, _stderr) => {
        if (stdout && stdout.trim().length > 0) {
          resolve(stdout.trim());
        } else if (error) {
          resolve(`[ERROR] Agent ${agentName} failed: ${error.message || 'unknown error'}`);
        } else {
          resolve('[No output]');
        }
      }
    );
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

/**
 * Build the turn order for a squad conversation.
 * Returns agents grouped by role in execution order.
 */
function buildTurnPlan(squad: Squad, squadsDir: string): ClassifiedAgent[] {
  const agents: ClassifiedAgent[] = [];

  for (const agent of squad.agents) {
    const role = classifyAgent(agent.name, agent.role);
    if (!role) continue; // Unclassified agents are excluded

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
 * Run a full squad conversation.
 *
 * Turn order per cycle:
 * 1. Lead briefs (or founder directive on first turn)
 * 2. Scanners discover (parallel-safe but run sequentially for simplicity)
 * 3. Workers execute
 * 4. Lead reviews
 * 5. Verifiers check (if workers produced output)
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
      turnCount: 0,
      totalCost: 0,
      converged: true,
      reason: 'No squads directory found',
    };
  }

  const maxTurns = options.maxTurns || DEFAULT_MAX_TURNS;
  const costCeiling = options.costCeiling || DEFAULT_COST_CEILING;
  const transcript = createTranscript(squad.name);

  // Resolve squad's working directory from repo field (e.g. "org/squads-cli" → sibling repo dir)
  // squadsDir = /path/to/hq/.agents/squads → go up 3 levels to get parent of project root
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

  // Classify all agents
  const allAgents = buildTurnPlan(squad, squadsDir);
  const leads = allAgents.filter(a => a.role === 'lead');
  const scanners = allAgents.filter(a => a.role === 'scanner');
  const workers = allAgents.filter(a => a.role === 'worker');
  const verifiers = allAgents.filter(a => a.role === 'verifier');

  if (leads.length === 0) {
    return {
      transcript,
      turnCount: 0,
      totalCost: 0,
      converged: true,
      reason: 'No lead agent found — cannot orchestrate conversation',
    };
  }

  const lead = leads[0]; // Primary lead
  const log = (msg: string) => {
    if (options.verbose) {
      const ts = new Date().toISOString().slice(11, 19);
      process.stderr.write(`  [${ts}] ${msg}\n`);
    }
  };

  log(`Conversation: ${squad.name} | ${allAgents.length} agents | max ${maxTurns} turns | $${costCeiling} ceiling`);
  log(`  Lead: ${lead.name} | Scanners: ${scanners.map(s => s.name).join(', ') || 'none'} | Workers: ${workers.map(w => w.name).join(', ') || 'none'} | Verifiers: ${verifiers.map(v => v.name).join(', ') || 'none'}`);

  // === CYCLE LOOP ===
  let cycleCount = 0;
  const MAX_CYCLES = 5; // Safety: max 5 full cycles (lead→scan→work→review→verify)

  while (cycleCount < MAX_CYCLES) {
    cycleCount++;
    log(`\n--- Cycle ${cycleCount} ---`);

    // Step 1: Lead briefs
    log(`Turn ${transcript.turns.length + 1}: ${lead.name} (lead)`);
    const leadOutput = executeAgentTurn({
      agentName: lead.name,
      agentPath: lead.path,
      role: 'lead',
      squadName: squad.name,
      model: options.model || modelForRole('lead'),
      transcript,
      task: cycleCount === 1 ? options.task : undefined,
      cwd: squadCwd,
    });
    addTurn(transcript, lead.name, 'lead', leadOutput, estimateTurnCost(options.model || 'sonnet'));

    // Check convergence after lead
    let conv = detectConvergence(transcript, maxTurns, costCeiling);
    if (conv.converged) {
      log(`Converged after lead: ${conv.reason}`);
      return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
    }

    // Step 2: Scanners (only on first cycle) — run in parallel
    if (cycleCount === 1 && scanners.length > 0) {
      if (scanners.length === 1) {
        log(`Turn ${transcript.turns.length + 1}: ${scanners[0].name} (scanner)`);
        const output = executeAgentTurn({
          agentName: scanners[0].name,
          agentPath: scanners[0].path,
          role: 'scanner',
          squadName: squad.name,
          model: options.model || modelForRole('scanner'),
          transcript,
          cwd: squadCwd,
        });
        addTurn(transcript, scanners[0].name, 'scanner', output, estimateTurnCost(options.model || 'haiku'));
      } else {
        log(`Turns ${transcript.turns.length + 1}-${transcript.turns.length + scanners.length}: ${scanners.map(s => s.name).join(', ')} (scanners, parallel)`);
        const scannerPromises = scanners.map(scanner =>
          executeAgentTurnAsync({
            agentName: scanner.name,
            agentPath: scanner.path,
            role: 'scanner',
            squadName: squad.name,
            model: options.model || modelForRole('scanner'),
            transcript, // snapshot — all scanners see same context
            cwd: squadCwd,
          }).then(output => ({ agent: scanner, output }))
        );
        const scannerResults = await Promise.all(scannerPromises);
        for (const { agent, output } of scannerResults) {
          addTurn(transcript, agent.name, 'scanner', output, estimateTurnCost(options.model || 'haiku'));
        }
      }

      conv = detectConvergence(transcript, maxTurns, costCeiling);
      if (conv.converged) {
        return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
      }
    }

    // Step 3: Workers execute — run in parallel if multiple
    if (workers.length === 1) {
      log(`Turn ${transcript.turns.length + 1}: ${workers[0].name} (worker)`);
      const output = executeAgentTurn({
        agentName: workers[0].name,
        agentPath: workers[0].path,
        role: 'worker',
        squadName: squad.name,
        model: options.model || modelForRole('worker'),
        transcript,
        cwd: squadCwd,
      });
      if (output.startsWith('[ERROR]')) {
        process.stderr.write(`  [WARN] Worker ${workers[0].name} errored: ${output}\n`);
      }
      addTurn(transcript, workers[0].name, 'worker', output, estimateTurnCost(options.model || 'sonnet'));
    } else if (workers.length > 1) {
      log(`Turns ${transcript.turns.length + 1}-${transcript.turns.length + workers.length}: ${workers.map(w => w.name).join(', ')} (workers, parallel)`);
      const workerPromises = workers.map(worker =>
        executeAgentTurnAsync({
          agentName: worker.name,
          agentPath: worker.path,
          role: 'worker',
          squadName: squad.name,
          model: options.model || modelForRole('worker'),
          transcript, // snapshot — all workers see same context
          cwd: squadCwd,
        }).then(output => ({ agent: worker, output }))
      );
      const workerResults = await Promise.all(workerPromises);
      for (const { agent, output } of workerResults) {
        if (output.startsWith('[ERROR]')) {
          process.stderr.write(`  [WARN] Worker ${agent.name} errored: ${output}\n`);
        }
        addTurn(transcript, agent.name, 'worker', output, estimateTurnCost(options.model || 'sonnet'));
      }
    }

    conv = detectConvergence(transcript, maxTurns, costCeiling);
    if (conv.converged) {
      return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
    }

    // Step 4: Lead reviews worker output
    log(`Turn ${transcript.turns.length + 1}: ${lead.name} (lead review)`);
    const reviewOutput = executeAgentTurn({
      agentName: lead.name,
      agentPath: lead.path,
      role: 'lead',
      squadName: squad.name,
      model: options.model || modelForRole('lead'),
      transcript,
      cwd: squadCwd,
    });
    addTurn(transcript, lead.name, 'lead', reviewOutput, estimateTurnCost(options.model || 'sonnet'));

    conv = detectConvergence(transcript, maxTurns, costCeiling);
    if (conv.converged) {
      return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
    }

    // Step 5: Verifiers — run in parallel if multiple
    if (verifiers.length === 1) {
      log(`Turn ${transcript.turns.length + 1}: ${verifiers[0].name} (verifier)`);
      const output = executeAgentTurn({
        agentName: verifiers[0].name,
        agentPath: verifiers[0].path,
        role: 'verifier',
        squadName: squad.name,
        model: options.model || modelForRole('verifier'),
        transcript,
        cwd: squadCwd,
      });
      addTurn(transcript, verifiers[0].name, 'verifier', output, estimateTurnCost(options.model || 'haiku'));
    } else if (verifiers.length > 1) {
      log(`Turns ${transcript.turns.length + 1}-${transcript.turns.length + verifiers.length}: ${verifiers.map(v => v.name).join(', ')} (verifiers, parallel)`);
      const verifierPromises = verifiers.map(verifier =>
        executeAgentTurnAsync({
          agentName: verifier.name,
          agentPath: verifier.path,
          role: 'verifier',
          squadName: squad.name,
          model: options.model || modelForRole('verifier'),
          transcript,
          cwd: squadCwd,
        }).then(output => ({ agent: verifier, output }))
      );
      const verifierResults = await Promise.all(verifierPromises);
      for (const { agent, output } of verifierResults) {
        addTurn(transcript, agent.name, 'verifier', output, estimateTurnCost(options.model || 'haiku'));
      }
    }

    if (verifiers.length > 0) {
      conv = detectConvergence(transcript, maxTurns, costCeiling);
      if (conv.converged) {
        return { transcript, turnCount: transcript.turns.length, totalCost: transcript.totalCost, converged: true, reason: conv.reason };
      }
    }
  }

  return {
    transcript,
    turnCount: transcript.turns.length,
    totalCost: transcript.totalCost,
    converged: false,
    reason: `Max cycles reached (${MAX_CYCLES})`,
  };
}

// =============================================================================
// Transcript Persistence
// =============================================================================

/** Save conversation transcript to .agents/conversations/{squad}/ */
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
    '',
    '---',
    '',
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
