/**
 * Squad execution modes: autopilot (daemon), squad loop, lead mode, and post-evaluation.
 * The autopilot mode is the unified daemon: cron routines + intelligence scoring + outcome tracking.
 * Consolidated from commands/daemon.ts, commands/autonomous.ts, and the original runAutopilot().
 */

import { spawn, execSync } from 'child_process';
import { join } from 'path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  mkdirSync,
  appendFileSync,
  openSync,
} from 'fs';
import { homedir } from 'os';
import {
  type RunOptions,
  DEFAULT_TIMEOUT_MINUTES,
} from './run-types.js';
import {
  checkClaudeCliAvailable,
  getProjectRoot,
} from './run-utils.js';
import {
  executeWithClaude,
  executeWithProvider,
} from './execution-engine.js';
import {
  checkLocalCooldown,
  DEFAULT_SCHEDULED_COOLDOWN_MS,
} from './execution-log.js';
import { runAgent } from './agent-runner.js';
import {
  findSquadsDir,
  loadSquad,
} from './squad-parser.js';
import {
  type LoopState,
  MIN_PHANTOM_DURATION_MS,
  loadLoopState,
  saveLoopState,
  getSquadRepos,
  scoreSquads,
  checkCooldown,
  classifyRunOutcome,
  checkNewPRs,
  getPRsWithReviewFeedback,
  buildReviewTask,
  pushMemorySignals,
  slackNotify,
  computePhases,
  scoreSquadsForPhase,
} from './squad-loop.js';
import {
  recordArtifacts,
  gradeExecution,
  pollOutcomes,
  computeAllScorecards,
} from './outcomes.js';
import {
  loadCognitionState,
  saveCognitionState,
  seedBeliefsIfEmpty,
  runCognitionCycle,
} from './cognition.js';
import {
  runConversation,
  saveTranscript,
  type ConversationOptions,
} from './workflow.js';
import {
  reportExecutionStart,
  reportConversationResult,
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
import { getBridgeUrl } from './env-config.js';
import { classifyAgent } from './conversation.js';
import {
  cronMatches,
  getNextCronRun,
  parseCooldown,
  collectRoutines,
  loadCooldowns,
  saveCooldowns,
} from './cron.js';
import ora from 'ora';

// ── Daemon state directory (from autonomous.ts) ─────────────────────

const DAEMON_DIR = join(homedir(), '.squads');
const PID_FILE = join(DAEMON_DIR, 'autonomous.pid');
const DAEMON_LOG = join(DAEMON_DIR, 'autonomous.log');
const PAUSE_FILE = join(DAEMON_DIR, 'autonomous.paused');

// Configuration from env vars
const MAX_CONCURRENT = parseInt(process.env.SQUADS_MAX_CONCURRENT || '5');
const AGENT_TIMEOUT_MIN = parseInt(process.env.SQUADS_AGENT_TIMEOUT || '30');
const EVAL_INTERVAL_SEC = parseInt(process.env.SQUADS_EVAL_INTERVAL || '60');
const AUTO_PAUSE_THRESHOLD = 5;

// ── Daemon lifecycle (from autonomous.ts) ────────────────────────────

function daemonLog(msg: string): void {
  const ts = new Date().toISOString();
  try {
    appendFileSync(DAEMON_LOG, `[${ts}] ${msg}\n`);
  } catch {
    /* Can't log — ignore */
  }
}

/**
 * Check if the daemon is paused.
 */
export function isDaemonPaused(): { paused: boolean; reason?: string; since?: string } {
  if (!existsSync(PAUSE_FILE)) return { paused: false };
  try {
    const data = JSON.parse(readFileSync(PAUSE_FILE, 'utf-8'));
    return { paused: true, reason: data.reason, since: data.since };
  } catch {
    return { paused: true, reason: 'unknown' };
  }
}

/**
 * Pause the daemon. It stays running but won't spawn new agents.
 */
export function pauseDaemon(reason: string): void {
  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true });
  }
  writeFileSync(PAUSE_FILE, JSON.stringify({
    reason,
    since: new Date().toISOString(),
  }));
  daemonLog(`PAUSED: ${reason}`);
}

/**
 * Resume the daemon after a pause.
 */
export function resumeDaemon(): void {
  try {
    unlinkSync(PAUSE_FILE);
  } catch {
    /* not paused */
  }
  daemonLog('RESUMED');
}

/**
 * Check if the daemon process is running.
 */
export function isDaemonRunning(): { running: boolean; pid?: number } {
  if (!existsSync(PID_FILE)) return { running: false };

  const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim());
  if (isNaN(pid)) return { running: false };

  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    // Stale PID file
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return { running: false };
  }
}

/**
 * Stop the running daemon.
 */
export function stopDaemon(): boolean {
  const status = isDaemonRunning();
  if (!status.running || !status.pid) return false;

  try {
    process.kill(status.pid, 'SIGTERM');
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the .agents/logs directory for running agent tracking.
 */
function getLogsDir(): string | null {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return null;
  return join(squadsDir, '..', 'logs');
}

/**
 * Count currently running agents by checking PID files.
 */
export function getRunningAgents(): {
  squad: string;
  agent: string;
  pid: number;
  startedAt: number;
  logFile: string;
}[] {
  const logsDir = getLogsDir();
  if (!logsDir || !existsSync(logsDir)) return [];

  const running: {
    squad: string;
    agent: string;
    pid: number;
    startedAt: number;
    logFile: string;
  }[] = [];

  let squadDirs: string[];
  try {
    squadDirs = readdirSync(logsDir);
  } catch {
    return [];
  }

  for (const squadDir of squadDirs) {
    const squadPath = join(logsDir, squadDir);
    let files: string[];
    try {
      files = readdirSync(squadPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.pid')) continue;

      const pidPath = join(squadPath, file);
      try {
        const pid = parseInt(readFileSync(pidPath, 'utf-8').trim());
        if (isNaN(pid)) continue;

        // Check if process is alive
        try {
          process.kill(pid, 0);
        } catch {
          // Process dead — clean up orphan PID file
          try { unlinkSync(pidPath); } catch { /* ignore */ }
          continue;
        }

        const match = file.match(/^(.+)-(\d+)\.pid$/);
        if (!match) continue;

        running.push({
          squad: squadDir,
          agent: match[1],
          pid,
          startedAt: parseInt(match[2]),
          logFile: pidPath.replace('.pid', '.log'),
        });
      } catch {
        continue;
      }
    }
  }

  return running;
}

/**
 * Show daemon status: running state, agents, next routines.
 */
export async function showDaemonStatus(): Promise<void> {
  const daemon = isDaemonRunning();
  const routines = collectRoutines();
  const enabled = routines.filter(r => r.enabled !== false);
  const running = getRunningAgents();

  writeLine(`\n  ${bold}Daemon Status${RESET}\n`);

  // Daemon status
  const pauseStatus = isDaemonPaused();
  if (daemon.running) {
    if (pauseStatus.paused) {
      writeLine(`  ${colors.yellow}●${RESET} Daemon paused ${colors.dim}(PID ${daemon.pid})${RESET}`);
      writeLine(`    ${colors.yellow}${pauseStatus.reason || 'No reason given'}${RESET} ${colors.dim}since ${pauseStatus.since || 'unknown'}${RESET}`);
    } else {
      writeLine(`  ${colors.green}●${RESET} Daemon running ${colors.dim}(PID ${daemon.pid})${RESET}`);
    }
  } else {
    writeLine(`  ${colors.red}●${RESET} Daemon not running`);
  }
  writeLine();

  // Running agents
  if (running.length > 0) {
    writeLine(`  ${colors.cyan}Running Agents${RESET}`);
    for (const agent of running) {
      const runtimeMin = Math.round((Date.now() - agent.startedAt) / 60000);
      const timeoutWarning = runtimeMin > AGENT_TIMEOUT_MIN * 0.8 ? ` ${colors.yellow}!${RESET}` : '';
      writeLine(`  ${colors.green}●${RESET} ${colors.cyan}${agent.squad}${RESET}/${agent.agent} ${colors.dim}${runtimeMin}min${RESET}${timeoutWarning} ${colors.dim}PID ${agent.pid}${RESET}`);
    }
    writeLine();
  }

  // Routine summary
  writeLine(`  ${colors.cyan}Routines${RESET}`);
  writeLine(`  ${enabled.length} enabled / ${routines.length} total, ${running.length}/${MAX_CONCURRENT} running`);
  writeLine();

  // Next upcoming runs
  if (enabled.length > 0) {
    writeLine(`  ${colors.cyan}Next Runs${RESET}`);

    const now = new Date();
    const nextRuns: { squad: string; routine: string; agent: string; nextRun: Date }[] = [];

    for (const r of enabled) {
      const next = getNextCronRun(r.schedule, now);
      for (const agent of r.agents) {
        nextRuns.push({ squad: r.squad, routine: r.name, agent, nextRun: next });
      }
    }

    nextRuns
      .sort((a, b) => a.nextRun.getTime() - b.nextRun.getTime())
      .slice(0, 10)
      .forEach(run => {
        const timeStr = run.nextRun.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const dateStr = run.nextRun.toDateString() === now.toDateString()
          ? 'today'
          : run.nextRun.toLocaleDateString([], { month: 'short', day: 'numeric' });
        writeLine(`  ${colors.dim}${timeStr} ${dateStr}${RESET} ${colors.cyan}${run.squad}${RESET}/${run.agent}`);
      });
  }

  writeLine();
  writeLine(`  ${colors.dim}Commands:${RESET}`);
  writeLine(`  ${colors.dim}$ squads run                Start daemon${RESET}`);
  writeLine(`  ${colors.dim}$ squads run --stop         Stop daemon${RESET}`);
  writeLine(`  ${colors.dim}$ squads run --pause        Pause (quota/manual)${RESET}`);
  writeLine(`  ${colors.dim}$ squads run --resume       Resume after pause${RESET}`);
  writeLine(`  ${colors.dim}$ tail -f ${DAEMON_LOG}${RESET}`);
  writeLine();
}

/**
 * Start the daemon as a detached background process.
 */
export async function startDaemon(): Promise<void> {
  const status = isDaemonRunning();
  if (status.running) {
    writeLine(`  ${colors.yellow}Daemon already running (PID ${status.pid})${RESET}`);
    writeLine(`  ${colors.dim}Log: ${DAEMON_LOG}${RESET}`);
    return;
  }

  if (!existsSync(DAEMON_DIR)) {
    mkdirSync(DAEMON_DIR, { recursive: true });
  }

  const routines = collectRoutines().filter(r => r.enabled !== false);
  if (routines.length === 0) {
    writeLine(`  ${colors.yellow}No enabled routines found.${RESET}`);
    writeLine(`  ${colors.dim}Add routines to SQUAD.md files under ### Routines section.${RESET}`);
    // Continue anyway — daemon also does scoring-based dispatch
  }

  // If we're being invoked as the daemon itself (via env var)
  if (process.env.SQUADS_DAEMON === '1') {
    writeFileSync(PID_FILE, process.pid.toString());
    await daemonLoop();
    await new Promise(() => {}); // Keep alive
    return;
  }

  // Spawn a detached daemon process
  if (!existsSync(DAEMON_LOG)) {
    writeFileSync(DAEMON_LOG, '');
  }
  const logFd = openSync(DAEMON_LOG, 'a');

  const child = spawn(
    process.execPath,
    [process.argv[1], 'run'],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, SQUADS_DAEMON: '1' },
    }
  );
  child.unref();

  // Wait for PID file to appear
  await new Promise(resolve => setTimeout(resolve, 2000));

  const check = isDaemonRunning();
  if (check.running) {
    writeLine(`\n  ${colors.green}Daemon started (PID ${check.pid})${RESET}`);
  } else {
    writeLine(`\n  ${colors.red}Daemon failed to start. Check log:${RESET}`);
    writeLine(`  ${colors.dim}$ tail -20 ${DAEMON_LOG}${RESET}`);
  }

  writeLine(`  ${colors.dim}Log: ${DAEMON_LOG}${RESET}`);

  // Show scheduled routines
  if (routines.length > 0) {
    writeLine(`\n  ${colors.cyan}Routines${RESET}`);
    for (const r of routines) {
      const next = getNextCronRun(r.schedule);
      const timeStr = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      writeLine(`  ${colors.green}●${RESET} ${colors.cyan}${r.squad}${RESET}/${r.name} ${colors.dim}${r.schedule} → ${timeStr}${RESET}`);
    }
    writeLine(`\n  ${colors.dim}${routines.length} routines, max ${MAX_CONCURRENT} concurrent${RESET}`);
  }

  writeLine(`  ${colors.dim}Stop: squads run --stop${RESET}`);
  writeLine(`  ${colors.dim}Monitor: tail -f ${DAEMON_LOG}${RESET}\n`);
}

/**
 * The daemon loop: evaluates cron routines + enforces timeouts.
 * Runs as a long-lived detached process.
 */
async function daemonLoop(): Promise<void> {
  daemonLog('Daemon started');

  const lastSpawned = loadCooldowns();
  let consecutiveFailures = 0;

  const tick = async () => {
    try {
      const pauseStatus = isDaemonPaused();
      const running = getRunningAgents();

      // Enforce timeouts on running agents (even when paused)
      for (const agent of running) {
        const runtimeMin = (Date.now() - agent.startedAt) / 60000;
        if (runtimeMin > AGENT_TIMEOUT_MIN) {
          daemonLog(`TIMEOUT: ${agent.squad}/${agent.agent} (PID ${agent.pid}, ${Math.round(runtimeMin)}min)`);
          const pidFile = agent.logFile.replace('.log', '.pid');
          try {
            process.kill(agent.pid, 'SIGTERM');
            try { unlinkSync(pidFile); } catch { /* ignore */ }
          } catch { /* already dead */ }
        }
      }

      if (pauseStatus.paused) return; // Don't spawn while paused

      const now = new Date();
      now.setSeconds(0, 0);

      const routines = collectRoutines().filter(r => r.enabled !== false);

      for (const routine of routines) {
        if (!cronMatches(routine.schedule, now)) continue;

        for (const agentName of routine.agents) {
          const key = `${routine.squad}/${agentName}`;

          // Cooldown check
          if (routine.cooldown) {
            const last = lastSpawned.get(key);
            const cooldownMs = parseCooldown(routine.cooldown);
            if (last && Date.now() - last < cooldownMs) continue;
          }

          // Already running check
          const alreadyRunning = running.some(
            r => r.squad === routine.squad && r.agent === agentName
          );
          if (alreadyRunning) continue;

          // Concurrency check
          if (getRunningAgents().length >= MAX_CONCURRENT) {
            daemonLog(`SKIP: ${key} — concurrency limit (${MAX_CONCURRENT})`);
            continue;
          }

          // Spawn
          daemonLog(`SPAWN: ${key} (routine: ${routine.name})`);
          try {
            const modelFlag = routine.model ? `--model ${routine.model}` : '';
            execSync(
              `squads run ${routine.squad}/${agentName} --background ${modelFlag} --trigger scheduled`,
              {
                cwd: process.cwd(),
                stdio: 'ignore',
                timeout: 10000,
                env: { ...process.env, CLAUDECODE: '' },
              }
            );
            lastSpawned.set(key, Date.now());
            saveCooldowns(lastSpawned);
            consecutiveFailures = 0;
            daemonLog(`SPAWNED: ${key}`);
          } catch (err) {
            consecutiveFailures++;
            daemonLog(`ERROR: Failed to spawn ${key} (${consecutiveFailures}/${AUTO_PAUSE_THRESHOLD}): ${err}`);

            if (consecutiveFailures >= AUTO_PAUSE_THRESHOLD) {
              pauseDaemon(`Auto-paused: ${consecutiveFailures} consecutive spawn failures (likely quota exhausted)`);
              daemonLog(`AUTO-PAUSED: ${consecutiveFailures} consecutive failures. Run 'squads run --resume' when quota resets.`);
            }
          }
        }
      }
    } catch (err) {
      daemonLog(`TICK ERROR: ${err}`);
    }
  };

  await tick();
  setInterval(tick, EVAL_INTERVAL_SEC * 1000);

  const cleanup = (signal: string) => {
    daemonLog(`Received ${signal}, shutting down`);
    saveCooldowns(lastSpawned);
    try { unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));
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

    // ── Outcome tracking (from daemon.ts) ──
    // Poll outcomes for unsettled records, recompute scorecards
    const pollResult = pollOutcomes(ghEnv);
    if (pollResult.polled > 0 && options.verbose) {
      writeLine(`  ${colors.dim}Polled ${pollResult.polled} artifact(s), ${pollResult.settled} newly settled${RESET}`);
    }
    computeAllScorecards('7d');

    // Grade completed squad loops and push quality signals
    for (const name of completed) {
      const repo = squadRepos[name];
      if (!repo) continue;

      const record = recordArtifacts({
        executionId: `autopilot_${name}_${cycleStart}`,
        squad: name,
        agent: 'squad-loop',
        completedAt: new Date().toISOString(),
        costUsd: 1.0,
        repo,
      }, ghEnv);

      if (record) {
        const { grade, reason } = gradeExecution(record);
        pushCognitionSignal({
          source: 'execution',
          signal_type: 'execution_quality',
          value: { A: 4, B: 3, C: 2, D: 1, F: 0 }[grade] ?? 0,
          unit: 'quality_score',
          data: { grade, reason, cost_usd: 1.0 },
          entity_type: 'squad',
          entity_id: name,
          confidence: 0.9,
        });

        if (options.verbose) {
          const gradeColor = grade <= 'B' ? colors.green : grade >= 'D' ? colors.red : colors.yellow;
          writeLine(`    ${gradeColor}${name} Grade: ${grade}${RESET} ${colors.dim}${reason}${RESET}`);
        }
      }

      // Check for new PRs from this squad
      const newPRs = checkNewPRs(repo, 30, ghEnv);
      if (newPRs.length > 0) {
        writeLine(`  ${icons.success} ${colors.cyan}${name}${RESET} created ${newPRs.length} PR(s):`);
        for (const pr of newPRs) {
          writeLine(`    ${colors.dim}#${pr.number} ${pr.title}${RESET}`);
        }
      }
    }

    // ── PR review reaction (from daemon.ts) ──
    // Dispatch agents to address review feedback on bot PRs
    if (!options.dryRun) {
      for (const repo of Object.values(squadRepos)) {
        if (budget > 0 && state.dailyCost >= budget) break;

        const prsWithFeedback = getPRsWithReviewFeedback(repo, ghEnv);
        for (const pr of prsWithFeedback) {
          const squad = Object.entries(squadRepos).find(([, r]) => r === repo)?.[0];
          if (!squad) continue;
          if (budget > 0 && state.dailyCost >= budget) break;

          const task = buildReviewTask(pr);
          writeLine(`  ${icons.running} Addressing ${pr.comments.length} review comment(s) on ${colors.cyan}${squad}${RESET} PR #${pr.number}`);

          try {
            const squadsDir2 = findSquadsDir();
            if (squadsDir2) {
              const solverPath = join(squadsDir2, squad, 'issue-solver.md');
              if (existsSync(solverPath)) {
                await runAgent('issue-solver', solverPath, squad, {
                  ...options,
                  task,
                  background: false,
                  eval: false,
                });
              }
            }
            state.dailyCost += 0.50;
          } catch (err) {
            writeLine(`  ${icons.error} ${colors.red}Review-fix failed for ${squad} PR #${pr.number}${RESET}`);
          }
        }
      }
    }

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
    if (dispatchedSquadNames.length > 0) {
      await runPostEvaluation(dispatchedSquadNames, options);
    }

    // ── Cognition: learn from this cycle ──
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
