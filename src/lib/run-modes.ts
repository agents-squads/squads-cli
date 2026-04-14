/**
 * Squad execution modes: autopilot, squad loop, lead mode, and post-evaluation.
 * Extracted from commands/run.ts to reduce its size.
 */

import { join, dirname } from 'path';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import {
  type RunOptions,
  DEFAULT_TIMEOUT_MINUTES,
  TOOL_USE_PROVIDERS,
} from './run-types.js';
import {
  checkClaudeCliAvailable,
} from './run-utils.js';
import {
  executeWithClaude,
  executeWithProvider,
} from './execution-engine.js';
import { runAgent } from './agent-runner.js';
import {
  findSquadsDir,
  findProjectRoot,
  loadSquad,
} from './squad-parser.js';
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
} from './squad-loop.js';
import {
  loadCognitionState,
  saveCognitionState,
  seedBeliefsIfEmpty,
  runCognitionCycle,
} from './cognition.js';
import {
  runConversation,
  type ConversationOptions,
} from './workflow.js';
import {
  pushCognitionSignal,
} from './api-client.js';
import { getBotGhEnv } from './github.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from './terminal.js';
import {
  getCLIConfig,
  isProviderCLIAvailable,
} from './llm-clis.js';
import { classifyAgent } from './conversation.js';
import { parseAgentFrontmatter } from './run-context.js';

// ── Post-run evaluation ─────────────────────────────────────────────
// After any squad run, dispatch the COO (company-lead) to evaluate outputs.
// This is the feedback loop that makes the system learn.

const EVAL_TIMEOUT_MINUTES = 15;

/**
 * Find an agent with `role: coo` or `role: company-lead` in its frontmatter,
 * searching across all squads. Returns null if none found.
 */
function findCooAgent(squadsDir: string): { agentName: string; agentPath: string; squadName: string } | null {
  let squadDirs: string[];
  try {
    squadDirs = readdirSync(squadsDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch { return null; }

  for (const squadName of squadDirs) {
    const squadPath = join(squadsDir, squadName);
    let files: string[];
    try {
      files = readdirSync(squadPath).filter(f => f.endsWith('.md') && f !== 'SQUAD.md');
    } catch { continue; }

    for (const file of files) {
      const agentPath = join(squadPath, file);
      const fm = parseAgentFrontmatter(agentPath);
      const role = (fm.agent_role || '').trim().toLowerCase();
      if (role === 'coo' || role === 'company-lead') {
        return { agentName: file.replace(/\.md$/, ''), agentPath, squadName };
      }
    }
  }
  return null;
}

/**
 * Run the COO evaluation after squad execution.
 * Dispatches company-lead with a scoped evaluation task for the squads that just ran.
 * Generates feedback.md and active-work.md per squad.
 */
export async function runPostEvaluation(
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

  // Find any agent with role: coo in frontmatter across all squads
  const coo = findCooAgent(squadsDir);
  if (!coo) {
    if (options.verbose) {
      writeLine(`  ${colors.dim}Skipping evaluation: no agent with role: coo found${RESET}`);
    }
    return;
  }

  const squadList = squadsRun.join(', ');
  writeLine();
  writeLine(`  ${gradient('eval')} ${colors.dim}COO evaluating: ${squadList}${RESET}`);

  // Load evaluation protocol from markdown (single source of truth)
  const evalProtocolPath = join(findProjectRoot() || '', '.agents', 'config', 'coo-evaluation.md');
  const evalProtocol = existsSync(evalProtocolPath) ? readFileSync(evalProtocolPath, 'utf-8') : '';
  const evalTask = `Post-run evaluation for: ${squadList}.\n\n${evalProtocol}`;

  await runAgent(coo.agentName, coo.agentPath, coo.squadName, {
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
export async function runAutopilot(
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
export async function runLeadMode(
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

  // Block lead mode for providers without tool use support
  const squadProvider = options.provider || squad?.providers?.default || 'anthropic';
  if (!TOOL_USE_PROVIDERS.has(squadProvider)) {
    const cliConfig = getCLIConfig(squadProvider);
    const providerName = cliConfig?.displayName || squadProvider;
    writeLine(`  ${icons.warning} ${colors.yellow}Lead mode requires tool-use support (Claude, Gemini)${RESET}`);
    writeLine(`  ${colors.dim}${providerName} cannot spawn sub-agents via Task tool.${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Options:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --provider ${squadProvider}  ${colors.dim}← sequential mode (recommended)${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}/${agentFiles[0]?.name || 'agent'}${RESET} --provider ${squadProvider}  ${colors.dim}← single agent${RESET}`);
    writeLine();
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

  // Build the lead prompt from template (no prompts in TypeScript — CLAUDE.md rule)
  const timeoutMins = options.timeout || DEFAULT_TIMEOUT_MINUTES;
  const agentList = agentFiles.map(a => `- ${a.name}: ${a.role}`).join('\n');
  const agentPaths = agentFiles.map(a => `- ${a.name}: ${a.path}`).join('\n');

  // Load lead mode protocol from markdown
  const leadProtocolPath = join(findProjectRoot() || '', '.agents', 'config', 'lead-mode.md');
  const leadProtocol = existsSync(leadProtocolPath) ? readFileSync(leadProtocolPath, 'utf-8') : '';

  // Template resolution: dist/templates (built) or repo-root/templates (dev/test)
  const leadDistPath = join(__dirname, '..', 'templates', 'prompts', 'lead-mode.md');
  const leadRootPath = join(__dirname, '..', '..', 'templates', 'prompts', 'lead-mode.md');
  const leadTemplatePath = existsSync(leadDistPath) ? leadDistPath : leadRootPath;
  const leadTemplate = existsSync(leadTemplatePath)
    ? readFileSync(leadTemplatePath, 'utf-8')
    : 'You are the Lead of the {{SQUAD_NAME}} squad. Plan and delegate work.';
  const prompt = leadTemplate
    .replaceAll('{{SQUAD_NAME}}', squad.name)
    .replaceAll('{{MISSION}}', squad.mission || 'Execute squad operations efficiently.')
    .replaceAll('{{AGENT_LIST}}', agentList)
    .replaceAll('{{AGENT_PATHS}}', agentPaths)
    .replaceAll('{{LEAD_PROTOCOL}}', leadProtocol);

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

// ── Sequential mode ──────────────────────────────────────────────────
// For providers without tool-use (Ollama, Codex, etc.): run each agent
// one at a time. No output chaining — each agent reads its own context.

/**
 * Run all squad agents sequentially with a non-tool-use provider.
 * Each agent runs in foreground, one at a time (Ollama saturates hardware).
 */
export async function runSequentialMode(
  squad: NonNullable<ReturnType<typeof loadSquad>>,
  squadsDir: string,
  provider: string,
  options: RunOptions,
): Promise<void> {
  const cliConfig = getCLIConfig(provider);
  const providerName = cliConfig?.displayName || provider;

  const agentFiles = squad.agents
    .map(a => ({
      name: a.name,
      role: a.role || '',
      path: join(squadsDir, squad.dir, `${a.name}.md`),
    }))
    .filter(a => existsSync(a.path));

  if (agentFiles.length === 0) {
    writeLine(`  ${icons.error} ${colors.red}No agent files found${RESET}`);
    return;
  }

  writeLine(`  ${bold}Sequential mode${RESET} ${colors.dim}(${providerName} — agents run one at a time)${RESET}`);
  writeLine();

  for (const agent of agentFiles) {
    writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
  }
  writeLine();

  if (!options.execute) {
    writeLine(`  ${colors.dim}Run sequentially:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --provider ${provider}`);
    writeLine();
    return;
  }

  const startMs = Date.now();
  let completed = 0;
  let failed = 0;

  for (let i = 0; i < agentFiles.length; i++) {
    const agent = agentFiles[i];
    const label = `[${i + 1}/${agentFiles.length}]`;
    writeLine(`  ${colors.dim}${label}${RESET} Running ${colors.cyan}${agent.name}${RESET}...`);

    try {
      // Read agent definition for the prompt
      const definition = readFileSync(agent.path, 'utf-8');

      // Build prompt: agent definition + squad context
      const { gatherSquadContext } = await import('./run-context.js');
      const context = gatherSquadContext(squad.dir, agent.name, {
        verbose: options.verbose,
        agentPath: agent.path,
      });

      const prompt = `${definition}\n${context}`;

      await executeWithProvider(provider, prompt, {
        verbose: options.verbose,
        foreground: true,
        squadName: squad.dir,
        agentName: agent.name,
        model: options.model,
      });

      completed++;
      writeLine(`  ${icons.success} ${colors.dim}${label}${RESET} ${agent.name} ${colors.green}complete${RESET}`);
    } catch (err) {
      failed++;
      writeLine(`  ${icons.error} ${colors.dim}${label}${RESET} ${agent.name} ${colors.red}failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
    }

    writeLine();
  }

  const elapsed = Math.round((Date.now() - startMs) / 1000);
  writeLine(`  ${gradient('Sequential run complete')} ${colors.dim}(${completed} ok, ${failed} failed, ${elapsed}s)${RESET}`);
  writeLine();
}
