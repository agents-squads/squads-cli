/**
 * squads daemon — persistent intelligence loop.
 *
 * Watches the org, decides what to run, dispatches agents,
 * monitors results, and reacts (merge, retry, escalate).
 *
 * This is the product: incremental smartness, not 200 agents.
 */

import { spawn } from 'child_process';
import { getBotGhEnv } from '../lib/github.js';
import {
  recordArtifacts,
  gradeExecution,
  pollOutcomes,
  computeAllScorecards,
} from '../lib/outcomes.js';
import {
  colors,
  bold,
  RESET,
  icons,
  writeLine,
} from '../lib/terminal.js';
import {
  MIN_PHANTOM_DURATION_MS,
  loadLoopState,
  saveLoopState,
  getSquadRepos,
  scoreSquads,
  checkNewPRs,
  getPRsWithReviewFeedback,
  buildReviewTask,
  slackNotify,
} from '../lib/squad-loop.js';

// Bot environment for gh CLI commands (populated on first cycle)
let botGhEnv: Record<string, string> = {};

// ── Types ────────────────────────────────────────────────────────────

interface DaemonOptions {
  interval: number;   // minutes between cycles
  maxParallel: number;
  dryRun: boolean;
  verbose: boolean;
  once: boolean;       // run one cycle and exit
  budget: number;      // max $/day
}

interface RunningJob {
  squad: string;
  agent: string;
  pid: number;
  startedAt: number;
  process: ReturnType<typeof spawn>;
}

interface CycleResult {
  dispatched: string[];
  completed: string[];
  failed: string[];
  skipped: string[];
  costEstimate: number;
}

// ── Dispatch: Run agents ─────────────────────────────────────────────

function dispatchAgent(
  squad: string,
  agent: string,
  task?: string,
): RunningJob {
  const args = ['run', squad, '-a', agent];
  if (task) args.push('--task', task);

  const proc = spawn('squads', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  return {
    squad,
    agent,
    pid: proc.pid || 0,
    startedAt: Date.now(),
    process: proc,
  };
}

/** Dispatch a full squad conversation (squads run <squad>) instead of a single agent. */
function dispatchConversation(squad: string): RunningJob {
  const proc = spawn('squads', ['run', squad], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  return {
    squad,
    agent: 'conversation',
    pid: proc.pid || 0,
    startedAt: Date.now(),
    process: proc,
  };
}

function waitForJob(job: RunningJob, timeoutMs: number = 20 * 60 * 1000): Promise<'completed' | 'failed' | 'timeout'> {
  return new Promise((resolve) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { job.process.kill('SIGTERM'); } catch { /* ignore */ }
        resolve('timeout');
      }
    }, timeoutMs);

    job.process.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(code === 0 ? 'completed' : 'failed');
      }
    });

    job.process.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve('failed');
      }
    });
  });
}

// ── Main cycle ───────────────────────────────────────────────────────

async function runCycle(options: DaemonOptions): Promise<CycleResult> {
  // Refresh bot token for gh CLI calls
  botGhEnv = await getBotGhEnv();

  const state = loadLoopState();
  const today = new Date().toISOString().slice(0, 10);
  const result: CycleResult = {
    dispatched: [],
    completed: [],
    failed: [],
    skipped: [],
    costEstimate: 0,
  };

  // Reset daily cost counter
  if (state.dailyCostDate !== today) {
    state.dailyCost = 0;
    state.dailyCostDate = today;
  }

  // Check budget (0 = unlimited, subscription mode)
  if (options.budget > 0 && state.dailyCost >= options.budget) {
    writeLine(`  ${icons.warning} ${colors.yellow}Daily budget reached ($${state.dailyCost.toFixed(2)}/$${options.budget})${RESET}`);
    saveLoopState(state);
    return result;
  }

  // Poll outcomes for unsettled records
  const pollResult = pollOutcomes(botGhEnv);
  if (pollResult.polled > 0) {
    writeLine(`  ${colors.dim}Polled ${pollResult.polled} artifact(s), ${pollResult.settled} newly settled${RESET}`);
  }

  // Recompute scorecards
  computeAllScorecards('7d');

  // Gather intelligence
  writeLine(`  ${colors.dim}Scanning org state...${RESET}`);
  const squadRepos = getSquadRepos();
  const signals = scoreSquads(state, squadRepos, botGhEnv);

  if (signals.length === 0) {
    writeLine(`  ${colors.dim}No squads need attention${RESET}`);
    saveLoopState(state);
    return result;
  }

  if (options.verbose) {
    writeLine(`  ${colors.dim}Scored ${signals.length} squads${RESET}`);
  }

  // Show what we found
  writeLine(`  ${bold}Signals:${RESET}`);
  for (const sig of signals.slice(0, 8)) {
    const scoreColor = sig.score >= 60 ? colors.red : sig.score >= 30 ? colors.yellow : colors.dim;
    writeLine(`  ${scoreColor}[${sig.score}]${RESET} ${colors.cyan}${sig.squad}${RESET} ${colors.dim}${sig.reason}${RESET}`);
  }
  writeLine();

  // Pick top N to dispatch
  const toDispatch = signals
    .filter(s => s.score > 0)
    .slice(0, options.maxParallel);

  if (toDispatch.length === 0) {
    writeLine(`  ${colors.dim}All signals below threshold${RESET}`);
    saveLoopState(state);
    return result;
  }

  if (options.dryRun) {
    writeLine(`  ${colors.yellow}[DRY RUN] Would dispatch:${RESET}`);
    for (const sig of toDispatch) {
      const label = sig.agent ?? 'conversation';
      writeLine(`    ${colors.cyan}${sig.squad}/${label}${RESET} — ${sig.reason}`);
    }
    saveLoopState(state);
    return result;
  }

  // Dispatch agents
  const jobs: RunningJob[] = [];
  for (const sig of toDispatch) {
    let job: RunningJob;

    if (sig.agent === undefined) {
      // Conversation mode: `squads run <squad>` — coordinates all agents
      writeLine(`  ${icons.running} Dispatching ${colors.cyan}${sig.squad}/conversation${RESET} (${sig.issues.length} issues)`);
      job = dispatchConversation(sig.squad);
    } else {
      // Single-agent mode: target a specific agent (usually issue-solver)
      const topIssue = sig.issues[0];
      const task = topIssue
        ? `Fix issue #${topIssue.number}: ${topIssue.title}`
        : undefined;
      writeLine(`  ${icons.running} Dispatching ${colors.cyan}${sig.squad}/${sig.agent}${RESET}${task ? ` → #${topIssue?.number}` : ''}`);
      job = dispatchAgent(sig.squad, sig.agent, task);
    }

    jobs.push(job);
    result.dispatched.push(`${sig.squad}/${job.agent}`);
  }

  writeLine(`  ${colors.dim}${jobs.length} agents running. Waiting...${RESET}`);
  writeLine();

  // Wait for all jobs (parallel)
  const outcomes = await Promise.all(
    jobs.map(async (job) => {
      const outcome = await waitForJob(job);
      const durationMs = Date.now() - job.startedAt;
      const durationMin = Math.floor(durationMs / 60000);
      const key = `${job.squad}:${job.agent}`;

      // Update state
      state.recentRuns.push({
        squad: job.squad,
        agent: job.agent,
        at: new Date().toISOString(),
        result: outcome,
        durationMs,
      });

      // Minimum duration threshold: runs completing in <30s did no real work.
      // Count them as "skipped" (phantom completion) to avoid masking health issues.
      const effectiveOutcome =
        outcome === 'completed' && durationMs < MIN_PHANTOM_DURATION_MS
          ? 'skipped'
          : outcome;

      // Track failures
      if (effectiveOutcome === 'failed' || effectiveOutcome === 'timeout') {
        state.failCounts[key] = (state.failCounts[key] || 0) + 1;
        result.failed.push(`${job.squad}/${job.agent}`);
        writeLine(`  ${icons.error} ${colors.red}${job.squad}/${job.agent}${RESET} ${effectiveOutcome} (${durationMin}m)`);
      } else if (effectiveOutcome === 'skipped') {
        // Phantom completion: don't reset fail counts, don't record as success
        result.skipped.push(`${job.squad}/${job.agent}`);
        writeLine(`  ${icons.warning} ${colors.yellow}${job.squad}/${job.agent}${RESET} skipped (instant exit: ${durationMs}ms — no work done)`);
      } else {
        state.failCounts[key] = 0; // Reset on success
        result.completed.push(`${job.squad}/${job.agent}`);
        writeLine(`  ${icons.success} ${colors.green}${job.squad}/${job.agent}${RESET} completed (${durationMin}m)`);
      }

      // Estimate cost (~$0.50 per agent run average, but zero for phantom runs)
      const estimatedCost = effectiveOutcome === 'skipped' ? 0 : 0.50;
      state.dailyCost += estimatedCost;
      result.costEstimate += estimatedCost;

      // Record artifacts for outcome tracking (only real completions)
      if (effectiveOutcome === 'completed') {
        const repo = squadRepos[job.squad];
        if (repo) {
          const record = recordArtifacts({
            executionId: `daemon_${job.squad}_${job.agent}_${job.startedAt}`,
            squad: job.squad,
            agent: job.agent,
            completedAt: new Date().toISOString(),
            costUsd: estimatedCost,
            repo,
          }, botGhEnv);

          // Grade the execution quality
          if (record) {
            const { grade, reason } = gradeExecution(record);

            if (options.verbose) {
              const gradeColor = grade <= 'B' ? colors.green : grade >= 'D' ? colors.red : colors.yellow;
              writeLine(`    ${gradeColor}Grade: ${grade}${RESET} ${colors.dim}${reason}${RESET}`);
            }
          }
        }
      }

      return { job, outcome: effectiveOutcome, durationMs };
    }),
  );

  // Trim recent runs to last 50
  state.recentRuns = state.recentRuns.slice(-50);
  state.lastCycle = new Date().toISOString();
  saveLoopState(state);

  // React: check for new PRs
  writeLine();
  for (const { job, outcome } of outcomes) {
    if (outcome !== 'completed') continue;
    const repo = squadRepos[job.squad];
    if (!repo) continue;
    const newPRs = checkNewPRs(repo, 30, botGhEnv);
    if (newPRs.length > 0) {
      writeLine(`  ${icons.success} ${colors.cyan}${job.squad}${RESET} created ${newPRs.length} PR(s):`);
      for (const pr of newPRs) {
        writeLine(`    ${colors.dim}#${pr.number} ${pr.title}${RESET}`);
      }
    }
  }

  // React: check for review feedback on bot PRs (Gemini, humans, etc.)
  if (!options.dryRun) {
    const reviewJobs: RunningJob[] = [];

    for (const repo of Object.values(squadRepos)) {
      const prsWithFeedback = getPRsWithReviewFeedback(repo, botGhEnv);
      for (const pr of prsWithFeedback) {
        // Find which squad owns this repo
        const squad = Object.entries(squadRepos).find(([, r]) => r === repo)?.[0];
        if (!squad) continue;

        // Check budget (0 = unlimited)
        if (options.budget > 0 && state.dailyCost >= options.budget) break;

        const task = buildReviewTask(pr);
        writeLine(`  ${icons.running} Addressing ${pr.comments.length} review comment(s) on ${colors.cyan}${squad}${RESET} PR #${pr.number}`);

        const job = dispatchAgent(squad, 'issue-solver', task);
        reviewJobs.push(job);
        result.dispatched.push(`${squad}/issue-solver (review #${pr.number})`);
      }
    }

    // Wait for review-fix jobs
    if (reviewJobs.length > 0) {
      writeLine(`  ${colors.dim}${reviewJobs.length} review-fix agent(s) running...${RESET}`);
      for (const job of reviewJobs) {
        const outcome = await waitForJob(job);
        const durationMs = Date.now() - job.startedAt;
        const durationMin = Math.floor(durationMs / 60000);

        if (outcome === 'completed') {
          result.completed.push(`${job.squad}/review-fix`);
          writeLine(`  ${icons.success} ${colors.green}${job.squad}/review-fix${RESET} completed (${durationMin}m)`);
        } else {
          result.failed.push(`${job.squad}/review-fix`);
          writeLine(`  ${icons.error} ${colors.red}${job.squad}/review-fix${RESET} ${outcome} (${durationMin}m)`);
        }

        state.dailyCost += 0.50;
        result.costEstimate += 0.50;
      }
    }
  }

  saveLoopState(state);

  // Slack notifications: only on failures and escalations (not routine completions)
  if (result.failed.length > 0) {
    const summary = [
      `*Daemon cycle — failures detected*`,
      `Failed: ${result.failed.join(', ')}`,
      result.completed.length > 0 ? `Completed: ${result.completed.join(', ')}` : '',
      `Est. cost: $${result.costEstimate.toFixed(2)} (daily: $${state.dailyCost.toFixed(2)}${options.budget > 0 ? '/$' + options.budget : ''})`,
    ].filter(Boolean).join('\n');
    slackNotify(summary);
  }

  // Escalate persistent failures
  for (const [key, count] of Object.entries(state.failCounts)) {
    if (count >= 3) {
      slackNotify(`🚨 *Escalation*: ${key} has failed ${count} times consecutively. Needs human attention.`);
    }
  }

  return result;
}

// ── Command ──────────────────────────────────────────────────────────

export async function daemonCommand(options: {
  interval?: string;
  parallel?: string;
  dryRun?: boolean;
  verbose?: boolean;
  once?: boolean;
  budget?: string;
}): Promise<void> {
  const config: DaemonOptions = {
    interval: parseInt(options.interval || '30', 10),
    maxParallel: parseInt(options.parallel || '2', 10),
    dryRun: options.dryRun || false,
    verbose: options.verbose || false,
    once: options.once || false,
    budget: parseFloat(options.budget || '0'),
  };

  writeLine();
  writeLine(`  ${bold}squads daemon${RESET}`);
  const budgetLabel = config.budget > 0 ? `Budget: $${config.budget}/day` : 'Subscription (no budget limit)';
  writeLine(`  ${colors.dim}Interval: ${config.interval}m | Parallel: ${config.maxParallel} | ${budgetLabel}${config.dryRun ? ' | DRY RUN' : ''}${RESET}`);
  writeLine();

  // First cycle
  const result = await runCycle(config);

  if (config.once) {
    writeLine();
    writeLine(`  ${colors.dim}Single cycle complete. Dispatched: ${result.dispatched.length}, Completed: ${result.completed.length}, Failed: ${result.failed.length}${RESET}`);
    writeLine();
    return;
  }

  // Continuous loop
  writeLine();
  writeLine(`  ${colors.dim}Next cycle in ${config.interval} minutes. Ctrl+C to stop.${RESET}`);

  const loop = async () => {
    while (true) {
      await new Promise(resolve => setTimeout(resolve, config.interval * 60 * 1000));
      writeLine();
      writeLine(`  ${colors.dim}─── Cycle ${new Date().toISOString()} ───${RESET}`);
      await runCycle(config);
      writeLine(`  ${colors.dim}Next cycle in ${config.interval} minutes.${RESET}`);
    }
  };

  await loop();
}
