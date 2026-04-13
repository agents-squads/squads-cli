import { join } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  listSquads,
  findSimilarSquads,
} from '../lib/squad-parser.js';
import {
  type RunOptions,
  TOOL_USE_PROVIDERS,
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
import { findMemoryDir } from '../lib/memory.js';
import { statSync } from 'fs';
import { runPostEvaluation, runAutopilot, runLeadMode, runSequentialMode } from '../lib/run-modes.js';

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

  // MODE 0: Org cycle — run all squads as a coordinated system
  if (target === '--org' || options.org) {
    const { scanOrg, planOrgCycle, displayOrgScan, displayPlan } = await import('../lib/org-cycle.js');

    writeLine();
    const focusLabel = options.focus ? ` ${bold}[${options.focus}]${RESET}` : '';
    writeLine(`  ${gradient('squads')} ${colors.dim}org cycle${RESET}${focusLabel}`);
    writeLine();

    // Step 1: SCAN
    const scan = scanOrg();
    displayOrgScan(scan);

    // Step 2: PLAN
    const plan = planOrgCycle(scan);
    if (plan.length === 0) {
      writeLine(`  ${colors.dim}No squads to run.${RESET}\n`);
      return;
    }
    displayPlan(plan);

    if (options.dryRun) {
      writeLine(`  ${colors.dim}[dry-run] Would run ${plan.length} squad leads in order above.${RESET}\n`);
      return;
    }

    // Step 3: EXECUTE — all planned squads run in parallel
    // Each squad targets its own repo, so no conflicts.
    // Users can define custom wave ordering via SQUAD.md `wave:` field in the future.

    const waves: string[][] = [
      plan.map(s => s.squad),
    ];

    // Resume support: load quota-skipped squads from previous run
    const resumeFile = join(process.cwd(), '.agents', 'observability', 'resume.json');
    let resumeSquads: Set<string> | null = null;
    if (options.resume && existsSync(resumeFile)) {
      try {
        const data = JSON.parse(readFileSync(resumeFile, 'utf-8'));
        resumeSquads = new Set(data.squads as string[]);
        writeLine(`  ${bold}Resuming${RESET} ${resumeSquads.size} squads from quota stop: ${[...resumeSquads].join(', ')}`);
      } catch { /* invalid file, run full cycle */ }
    }

    const cycleStart = Date.now();
    const results: Array<{ squad: string; agent: string; status: string; durationMs: number; turnCount?: number; totalCost?: number; converged?: boolean }> = [];

    // Snapshot all goals before execution
    const { snapshotGoals, diffGoals, queryExecutions } = await import('../lib/observability.js');
    const allGoalsBefore: Record<string, Record<string, string>> = {};
    for (const s of plan) {
      allGoalsBefore[s.squad] = snapshotGoals(s.squad);
    }

    // Build set of planned squads for filtering
    const plannedSquads = new Set(plan.map(s => s.squad));

    // Check skip logic
    const today = new Date().toISOString().slice(0, 10);
    const todayExecs = queryExecutions({ since: `${today}T00:00:00Z`, limit: 500 });
    const completedTodayMap = new Map<string, string>();
    for (const e of todayExecs) {
      if (e.status === 'completed' && e.agent?.includes('lead')) {
        if (!completedTodayMap.has(e.squad) || e.ts > completedTodayMap.get(e.squad)!) {
          completedTodayMap.set(e.squad, e.ts);
        }
      }
    }

    function shouldSkip(squadName: string): boolean {
      if (options.force) return false;
      const lastRun = completedTodayMap.get(squadName);
      if (!lastRun) return false;
      const memoryDir = findMemoryDir();
      if (memoryDir) {
        const goalsPath = join(memoryDir, squadName, 'goals.md');
        const priPath = join(memoryDir, squadName, 'priorities.md');
        try {
          const lastRunMs = new Date(lastRun).getTime();
          const goalsMtime = existsSync(goalsPath) ? statSync(goalsPath).mtimeMs : 0;
          const priMtime = existsSync(priPath) ? statSync(priPath).mtimeMs : 0;
          if (goalsMtime > lastRunMs || priMtime > lastRunMs) return false;
        } catch { return false; }
      }
      return true;
    }

    async function runSquadConversation(squadName: string): Promise<typeof results[0]> {
      const s = plan.find(p => p.squad === squadName);
      if (!s || !s.lead) return { squad: squadName, agent: 'unknown', status: 'skipped', durationMs: 0 };

      if (shouldSkip(squadName)) {
        writeLine(`  ${colors.dim}skip  ${squadName} (completed today, goals unchanged)${RESET}`);
        return { squad: squadName, agent: s.lead, status: 'skipped', durationMs: 0 };
      }

      const squad = loadSquad(squadName);
      if (!squad) {
        writeLine(`  ${colors.red}${squadName}: squad not found${RESET}`);
        return { squad: squadName, agent: s.lead, status: 'failed', durationMs: 0 };
      }

      const runStart = Date.now();
      try {
        const convOptions: ConversationOptions = {
          task: options.task,
          maxTurns: options.maxTurns,
          costCeiling: options.costCeiling,
          verbose: options.verbose,
          model: options.model,
          focus: (options.focus as ConversationOptions['focus']) || undefined,
        };

        const result = await runConversation(squad, convOptions);
        saveTranscript(result.transcript);

        const status = result.converged ? 'converged' : 'completed';
        writeLine(`  ${result.converged ? icons.success : icons.warning} ${squadName}: ${result.reason} ${colors.dim}(${result.turnCount}t, ~$${result.totalCost.toFixed(2)})${RESET}`);
        return {
          squad: squadName, agent: s.lead, status,
          durationMs: Date.now() - runStart,
          turnCount: result.turnCount, totalCost: result.totalCost, converged: result.converged,
        };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        writeLine(`  ${colors.red}${squadName} failed: ${errMsg.slice(0, 80)}${RESET}`);
        return { squad: squadName, agent: s.lead, status: 'failed', durationMs: Date.now() - runStart };
      }
    }

    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      const wave = waves[waveIdx];
      // If resuming, only run squads that were skipped last time
      const waveSquads = wave.filter(s => plannedSquads.has(s) && (!resumeSquads || resumeSquads.has(s)));
      if (waveSquads.length === 0) continue;

      const waveNum = waveIdx + 1;
      writeLine();
      writeLine(`  ${bold}Wave ${waveNum}${RESET} ${colors.dim}(${waveSquads.join(', ')})${RESET}`);

      // Run all squads in this wave in parallel
      const waveResults = await Promise.all(
        waveSquads.map(s => runSquadConversation(s))
      );
      results.push(...waveResults);

      // Quota detection: if any squad in this wave got "hit your limit" responses,
      // stop the cycle — remaining waves will produce empty results.
      const quotaHit = waveResults.some(r => {
        // Check transcripts for quota messages
        const convDir = join(process.cwd(), '.agents', 'conversations', r.squad);
        try {
          const files = readdirSync(convDir).sort().reverse();
          if (files.length > 0) {
            const latest = readFileSync(join(convDir, files[0]), 'utf-8');
            return latest.includes('hit your limit') || latest.includes('rate limit') || latest.includes('[QUOTA]') || latest.includes('Quota limit reached');
          }
        } catch { /* no transcript */ }
        return false;
      });

      if (quotaHit) {
        const remainingWaves = waves.slice(waveIdx + 1).flat().filter(s => plannedSquads.has(s) && (!resumeSquads || resumeSquads.has(s)));
        if (remainingWaves.length > 0) {
          writeLine(`\n  ${colors.red}Quota limit reached.${RESET} Skipping ${remainingWaves.length} remaining squads.`);
          writeLine(`  ${colors.dim}Resume later: squads run --org --resume${RESET}`);
          for (const s of remainingWaves) {
            results.push({ squad: s, agent: 'unknown', status: 'quota-skipped', durationMs: 0 });
          }
          // Save skipped squads for resume
          try {
            const obsDir = join(process.cwd(), '.agents', 'observability');
            if (!existsSync(obsDir)) mkdirSync(obsDir, { recursive: true });
            writeFileSync(resumeFile, JSON.stringify({
              squads: remainingWaves,
              stoppedAt: new Date().toISOString(),
              waveIdx: waveIdx + 1,
            }));
          } catch { /* best effort */ }
          break; // Exit wave loop
        }
      }

    }

    // Clear resume file if cycle completed without quota hit
    const quotaSkipped = results.filter(r => r.status === 'quota-skipped').length;
    if (quotaSkipped === 0 && existsSync(resumeFile)) {
      try { unlinkSync(resumeFile); } catch { /* best effort */ }
    }

    // Step 4: REPORT — compare goals before and after
    const totalMs = Date.now() - cycleStart;
    const completed = results.filter(r => r.status === 'completed').length;
    const failed = results.filter(r => r.status === 'failed').length;

    const totalCostAll = results.reduce((s, r) => s + (r.totalCost || 0), 0);
    const totalTurns = results.reduce((s, r) => s + (r.turnCount || 0), 0);

    writeLine();
    writeLine(`  ${bold}Org Cycle Complete${RESET}`);
    writeLine(`  Duration: ${Math.round(totalMs / 60000)}m | Squads: ${completed} done, ${failed} failed | ~$${totalCostAll.toFixed(0)} | ${totalTurns} turns`);
    writeLine();

    for (const r of results) {
      const icon = r.status === 'converged' ? `${colors.green}conv${RESET}`
        : r.status === 'completed' ? `${colors.green}done${RESET}`
        : r.status === 'skipped' ? `${colors.dim}skip${RESET}`
        : `${colors.red}fail${RESET}`;
      const meta = r.turnCount ? `${r.turnCount}t ~$${(r.totalCost || 0).toFixed(2)}` : '';
      writeLine(`  ${icon}  ${r.squad.padEnd(18)} ${colors.dim}${Math.round(r.durationMs / 1000)}s  ${meta}${RESET}`);
    }

    // Goal changes summary
    let totalGoalChanges = 0;
    const goalSummary: string[] = [];
    for (const s of plan) {
      const after = snapshotGoals(s.squad);
      const changes = diffGoals(allGoalsBefore[s.squad] || {}, after);
      if (changes.length > 0) {
        totalGoalChanges += changes.length;
        for (const c of changes) {
          goalSummary.push(`  ${colors.green}${s.squad}${RESET}: ${c.name} ${colors.dim}${c.before} → ${c.after}${RESET}`);
        }
      }
    }

    if (goalSummary.length > 0) {
      writeLine();
      writeLine(`  ${bold}Goal Changes${RESET} (${totalGoalChanges})`);
      for (const line of goalSummary) writeLine(line);
    } else {
      writeLine();
      writeLine(`  ${colors.dim}No goal changes this cycle.${RESET}`);
    }
    writeLine();

    return;
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
    const runStartMs = Date.now();
    let hadError = false;
    try {
      await runSquad(squad, squadsDir, options);
      // Post-run COO evaluation (default on, --no-eval to skip)
      await runPostEvaluation([squad.name], options);
    } catch (err) {
      hadError = true;
      throw err;
    } finally {
      await track(Events.CLI_RUN_COMPLETE, {
        exit_code: hadError ? 1 : 0,
        duration_ms: Date.now() - runStartMs,
        agent_count: squad.agents?.length ?? 1,
        had_error: hadError,
      });
    }
  } else {
    // Try to find as an agent
    const agents = listAgents(squadsDir);
    const agent = agents.find(a => a.name === target);

    if (agent && agent.filePath) {
      // Extract squad name from path
      const pathParts = agent.filePath.split('/');
      const squadIdx = pathParts.indexOf('squads');
      const resolvedSquadName = squadIdx >= 0 ? pathParts[squadIdx + 1] : 'unknown';
      const runStartMs = Date.now();
      let hadError = false;
      try {
        await runAgent(agent.name, agent.filePath, resolvedSquadName, options);
        // Post-run COO evaluation for the squad this agent belongs to
        await runPostEvaluation([resolvedSquadName], options);
      } catch (err) {
        hadError = true;
        throw err;
      } finally {
        await track(Events.CLI_RUN_COMPLETE, {
          exit_code: hadError ? 1 : 0,
          duration_ms: Date.now() - runStartMs,
          agent_count: 1,
          had_error: hadError,
        });
      }
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
      // Determine provider for mode selection
      const squadProvider = options.provider || squad?.providers?.default || 'anthropic';

      if (options.execute && !TOOL_USE_PROVIDERS.has(squadProvider)) {
        // Sequential mode for providers without tool use (Ollama, Codex, etc.)
        await runSequentialMode(squad, squadsDir, squadProvider, options);
      } else if (options.execute) {
        // Default: Run squad as multi-agent conversation
        // Lead briefs → scanners discover → workers execute → lead reviews → converge
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
        const squadProvider2 = options.provider || squad?.providers?.default || 'anthropic';
        const modeLabel = TOOL_USE_PROVIDERS.has(squadProvider2)
          ? 'conversation (lead → scan → work → review → verify)'
          : `sequential (${squadProvider2} — agents run one at a time)`;
        writeLine(`  ${colors.dim}Default mode: ${modeLabel}${RESET}`);
        writeLine();
        for (const agent of squad.agents) {
          writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
        }
        writeLine();
        writeLine(`  ${colors.dim}Run:${RESET}`);
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
