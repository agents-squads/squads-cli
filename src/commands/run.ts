import ora from 'ora';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  loadAgentDefinition,
  parseAgentProvider,
  listSquads,
  findSimilarSquads,
} from '../lib/squad-parser.js';
import {
  type RunOptions,
  type ExecutionContext,
  DEFAULT_TIMEOUT_MINUTES,
  SOFT_DEADLINE_RATIO,
} from '../lib/run-types.js';
import {
  generateExecutionId,
  detectTaskType,
  getProjectRoot,
  formatDuration,
  checkClaudeCliAvailable,
} from '../lib/run-utils.js';
import {
  buildContextFromSquad,
  validateExecution,
  formatViolations,
  ExecutionRequest
} from '../lib/permissions.js';
import {
  DEFAULT_SCHEDULED_COOLDOWN_MS,
  checkPreflightGates,
  fetchLearnings,
  logExecution,
  updateExecutionStatus,
  checkLocalCooldown,
  emitExecutionEvent,
} from '../lib/execution-log.js';
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
import { runCloudDispatch } from '../lib/cloud-dispatch.js';
import { runConversation, saveTranscript, type ConversationOptions } from '../lib/workflow.js';
import { reportExecutionStart, reportConversationResult, pushCognitionSignal } from '../lib/api-client.js';
import { getBotGhEnv } from '../lib/github.js';
import {
  verifyExecution,
  preflightExecutorCheck,
  executeWithClaude,
  executeWithProvider,
} from '../lib/execution-engine.js';
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
const DRYRUN_DEF_MAX_CHARS = 500;
const DRYRUN_CONTEXT_MAX_CHARS = 800;

// registerContextWithBridge, checkPreflightGates, fetchLearnings, logExecution,
// updateExecutionStatus, getLastExecutionTime, checkLocalCooldown, emitExecutionEvent
// → moved to src/lib/execution-log.ts

// autoCommitAgentWork, verifyExecution, preflightExecutorCheck, executeWithClaude,
// executeWithProvider, buildAgentEnv, logVerboseExecution, resolveTargetRepoRoot,
// createAgentWorktree, cleanupWorktree, buildDetachedShellScript, prepareLogFiles,
// executeForeground, executeWatch, ExecuteWithClaudeOptions
// → moved to src/lib/execution-engine.ts

// runCloudDispatch → moved to src/lib/cloud-dispatch.ts

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
      writeLine(`  ${colors.dim}Run \`squads status\` to see available squads and agents.${RESET}`);
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

  // Determine provider
  const provider = options.provider || squad?.providers?.default || 'anthropic';
  const isAnthropic = provider === 'anthropic';

  if (isAnthropic) {
    const claudeAvailable = await checkClaudeCliAvailable();
    if (!claudeAvailable) {
      writeLine(`  ${colors.yellow}Claude CLI not found${RESET}`);
      writeLine(`  ${colors.dim}Install: npm install -g @anthropic-ai/claude-code${RESET}`);
      return;
    }
  } else {
    if (!isProviderCLIAvailable(provider)) {
      const cliConfig = getCLIConfig(provider);
      writeLine(`  ${colors.yellow}${cliConfig?.displayName || provider} CLI not found${RESET}`);
      if (cliConfig?.install) {
        writeLine(`  ${colors.dim}Install: ${cliConfig.install}${RESET}`);
      }
      return;
    }
  }

  // Determine execution mode (foreground is default, background is opt-in)
  const isBackground = options.background === true && !options.watch;
  const isWatch = options.watch === true;
  const isForeground = !isBackground && !isWatch;

  const modeText = isBackground ? ' (background)' : isWatch ? ' (watch)' : '';
  const providerDisplay = isAnthropic ? 'Claude' : (getCLIConfig(provider)?.displayName || provider);
  writeLine(`  ${gradient('Launching')} lead session${modeText} with ${providerDisplay}...`);
  writeLine();

  try {
    // Find lead agent name from agent files or use default
    const leadAgentName = agentFiles.find(a => a.name.includes('lead'))?.name || `${squad.dir}-lead`;

    let result: string;
    if (isAnthropic) {
      result = await executeWithClaude(prompt, {
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
    } else {
      result = await executeWithProvider(provider, prompt, {
        verbose: options.verbose,
        foreground: isForeground || isWatch,
        squadName: squad.dir,
        agentName: leadAgentName,
      });
    }

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

// checkClaudeCliAvailable → imported from run-utils.ts
// preflightExecutorCheck → moved to src/lib/execution-engine.ts

// ExecuteWithClaudeOptions, buildAgentEnv, logVerboseExecution, resolveTargetRepoRoot,
// createAgentWorktree, cleanupWorktree, buildDetachedShellScript, prepareLogFiles,
// executeForeground, executeWatch, executeWithClaude, executeWithProvider
// → moved to src/lib/execution-engine.ts

export async function runSquadCommand(
  squadName: string,
  options: RunOptions
): Promise<void> {
  return runCommand(squadName, options);
}
