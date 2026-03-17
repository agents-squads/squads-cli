import { join } from 'path';
import { existsSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  listSquads,
  findSimilarSquads,
} from '../lib/squad-parser.js';
import {
  type RunOptions,
} from '../lib/run-types.js';
import {
  preflightExecutorCheck,
} from '../lib/execution-engine.js';
import { track, Events, flushEvents } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { runCloudDispatch } from '../lib/cloud-dispatch.js';
import { runConversation, saveTranscript, type ConversationOptions } from '../lib/workflow.js';
import { reportExecutionStart, reportConversationResult, pushCognitionSignal } from '../lib/api-client.js';
import { runAgent } from '../lib/agent-runner.js';
import { runPostEvaluation, runAutopilot, runLeadMode } from '../lib/run-modes.js';

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

export async function runSquadCommand(
  squadName: string,
  options: RunOptions
): Promise<void> {
  return runCommand(squadName, options);
}
