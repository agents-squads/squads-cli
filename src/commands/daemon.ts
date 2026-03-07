/**
 * squads daemon — persistent intelligence loop.
 *
 * Watches the org, decides what to run, dispatches agents,
 * monitors results, and reacts (merge, retry, escalate).
 *
 * This is the product: incremental smartness, not 200 agents.
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  findSquadsDir,
  listSquads,
} from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { getBotGhEnv } from '../lib/github.js';
import {
  colors,
  bold,
  RESET,
  icons,
  writeLine,
} from '../lib/terminal.js';

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

interface SquadSignal {
  squad: string;
  score: number;       // 0-100 urgency
  reason: string;
  agent?: string;      // specific agent to run, or undefined for squad conversation
  issues: GhIssue[];
}

interface GhIssue {
  number: number;
  title: string;
  labels: string[];
  repo: string;
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

// ── State file ───────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.squads', 'daemon');
const STATE_FILE = join(STATE_DIR, 'state.json');

interface DaemonState {
  lastCycle: string;
  dailyCost: number;
  dailyCostDate: string;
  recentRuns: Array<{
    squad: string;
    agent: string;
    at: string;
    result: 'completed' | 'failed' | 'timeout';
    durationMs: number;
  }>;
  failCounts: Record<string, number>; // squad:agent → consecutive failures
}

function loadState(): DaemonState {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) {
    return {
      lastCycle: '',
      dailyCost: 0,
      dailyCostDate: new Date().toISOString().slice(0, 10),
      recentRuns: [],
      failCounts: {},
    };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {
      lastCycle: '',
      dailyCost: 0,
      dailyCostDate: new Date().toISOString().slice(0, 10),
      recentRuns: [],
      failCounts: {},
    };
  }
}

function saveState(state: DaemonState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Intelligence: Gather signals ─────────────────────────────────────

function getOpenIssues(repo: string): GhIssue[] {
  try {
    const raw = execSync(
      `gh issue list -R ${repo} --state open --json number,title,labels --limit 20`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...botGhEnv } },
    );
    const issues = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      labels: Array<{ name: string }>;
    }>;
    return issues.map(i => ({
      number: i.number,
      title: i.title,
      labels: i.labels.map(l => l.name),
      repo,
    }));
  } catch {
    return [];
  }
}

function getOpenPRs(repo: string): Array<{ number: number; title: string; branch: string; checks: string }> {
  try {
    const raw = execSync(
      `gh pr list -R ${repo} --state open --json number,title,headRefName,statusCheckRollup --limit 10`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...botGhEnv } },
    );
    const prs = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      headRefName: string;
      statusCheckRollup: Array<{ conclusion: string }> | null;
    }>;
    return prs.map(pr => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      checks: pr.statusCheckRollup?.every(c => c.conclusion === 'SUCCESS') ? 'passing' : 'pending',
    }));
  } catch {
    return [];
  }
}

function getLastRunAge(squad: string, agent: string): number | null {
  const memDir = findMemoryDir();
  if (!memDir) return null;

  const execPath = join(memDir, squad, agent, 'executions.md');
  if (!existsSync(execPath)) return null;

  try {
    const content = readFileSync(execPath, 'utf-8');
    // Find the last timestamp
    const timestamps = content.match(/\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\*\*/g);
    if (!timestamps || timestamps.length === 0) return null;

    const last = timestamps[timestamps.length - 1].replace(/\*\*/g, '');
    const lastDate = new Date(last);
    return Date.now() - lastDate.getTime();
  } catch {
    return null;
  }
}

// ── Intelligence: Score squads ───────────────────────────────────────

const SQUAD_REPOS: Record<string, string> = {
  cli: 'agents-squads/squads-cli',
  website: 'agents-squads/agents-squads-web',
  console: 'agents-squads/squads-console',
  product: 'agents-squads/hq',
};

function scoreSquads(state: DaemonState): SquadSignal[] {
  const signals: SquadSignal[] = [];
  const squadsDir = findSquadsDir();
  if (!squadsDir) return signals;

  let squads: string[];
  try {
    squads = listSquads(squadsDir);
  } catch {
    return signals;
  }

  for (const squadName of squads) {
    try {
      const repo = SQUAD_REPOS[squadName];
      if (!repo) continue; // Only score squads with repos we can check

      const issues = getOpenIssues(repo);

      // Score based on signals
      let score = 0;
      let reason = '';
      const targetAgent = 'issue-solver'; // default worker

      // P0/P1 issues = highest priority
      const p0Issues = issues.filter(i =>
        i.labels.some(l => l.includes('P0') || l.includes('priority:P0')),
      );
      const p1Issues = issues.filter(i =>
        i.labels.some(l => l.includes('P1') || l.includes('priority:P1')),
      );

      if (p0Issues.length > 0) {
        score += 80;
        reason = `${p0Issues.length} P0 issues: ${p0Issues[0].title}`;
      } else if (p1Issues.length > 0) {
        score += 60;
        reason = `${p1Issues.length} P1 issues: ${p1Issues[0].title}`;
      } else if (issues.length > 0) {
        score += 30;
        reason = `${issues.length} open issues`;
      }

      // Staleness bonus: haven't run recently
      const lastAge = getLastRunAge(squadName, targetAgent);
      if (lastAge !== null) {
        const hoursAgo = lastAge / (1000 * 60 * 60);
        if (hoursAgo > 48) {
          score += 20;
          reason += ` (stale: ${Math.floor(hoursAgo)}h since last run)`;
        } else if (hoursAgo > 24) {
          score += 10;
          reason += ` (${Math.floor(hoursAgo)}h since last run)`;
        } else if (hoursAgo < 2) {
          // Recently ran — penalize
          score -= 30;
          reason += ` (ran ${Math.floor(hoursAgo * 60)}m ago)`;
        }
      }

      // Consecutive failure penalty
      const failKey = `${squadName}:${targetAgent}`;
      const failures = state.failCounts[failKey] || 0;
      if (failures >= 3) {
        score -= 40;
        reason += ` (${failures} consecutive failures — needs human)`;
      } else if (failures >= 1) {
        score -= 10 * failures;
      }

      // Only include squads with positive scores and actual work
      if (score > 0 && issues.length > 0) {
        signals.push({ squad: squadName, score, reason, agent: targetAgent, issues });
      }
    } catch {
      // Skip squads that error during scoring
      continue;
    }
  }

  // Sort by score descending
  signals.sort((a, b) => b.score - a.score);
  return signals;
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

// ── React: Post-run actions ──────────────────────────────────────────

function checkNewPRs(repo: string, sinceMins: number = 30): Array<{ number: number; title: string }> {
  try {
    const raw = execSync(
      `gh pr list -R ${repo} --state open --json number,title,createdAt --limit 5`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...botGhEnv } },
    );
    const prs = JSON.parse(raw) as Array<{ number: number; title: string; createdAt: string }>;
    const cutoff = Date.now() - sinceMins * 60 * 1000;
    return prs.filter(pr => new Date(pr.createdAt).getTime() > cutoff);
  } catch {
    return [];
  }
}

interface ReviewComment {
  author: string;
  body: string;
  path?: string;
  createdAt: string;
}

interface PRWithReviews {
  number: number;
  title: string;
  branch: string;
  repo: string;
  comments: ReviewComment[];
}

/**
 * Get open PRs with unaddressed review comments (from Gemini, humans, etc).
 * Skips comments from our own bot to avoid feedback loops.
 */
function getPRsWithReviewFeedback(repo: string): PRWithReviews[] {
  try {
    // Get open PRs authored by the bot
    const prsRaw = execSync(
      `gh pr list -R ${repo} --state open --author "agents-squads[bot]" --json number,title,headRefName --limit 10`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...botGhEnv } },
    );
    const prs = JSON.parse(prsRaw) as Array<{ number: number; title: string; headRefName: string }>;

    const results: PRWithReviews[] = [];

    for (const pr of prs) {
      try {
        // Get review comments (inline code review comments)
        const reviewsRaw = execSync(
          `gh api repos/${repo}/pulls/${pr.number}/comments --jq '.[] | {author: .user.login, body: .body, path: .path, createdAt: .created_at}'`,
          { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...botGhEnv } },
        );

        // Get issue comments (top-level PR comments like Gemini summaries)
        const issueCommentsRaw = execSync(
          `gh api repos/${repo}/issues/${pr.number}/comments --jq '.[] | {author: .user.login, body: .body, createdAt: .created_at}'`,
          { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...botGhEnv } },
        );

        const comments: ReviewComment[] = [];

        // Parse JSONL output (one JSON object per line)
        for (const line of [...reviewsRaw.split('\n'), ...issueCommentsRaw.split('\n')]) {
          if (!line.trim()) continue;
          try {
            const comment = JSON.parse(line) as ReviewComment;
            // Skip our own bot's comments to avoid loops
            if (comment.author === 'agents-squads[bot]') continue;
            comments.push(comment);
          } catch {
            continue;
          }
        }

        if (comments.length > 0) {
          results.push({
            number: pr.number,
            title: pr.title,
            branch: pr.headRefName,
            repo,
            comments,
          });
        }
      } catch {
        continue;
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Build a task directive from review feedback for an agent to address.
 */
function buildReviewTask(pr: PRWithReviews): string {
  const commentSummary = pr.comments
    .map(c => {
      const location = c.path ? ` (${c.path})` : '';
      return `- ${c.author}${location}: ${c.body.slice(0, 300)}`;
    })
    .join('\n');

  return [
    `Address review feedback on PR #${pr.number}: ${pr.title}`,
    `Branch: ${pr.branch}`,
    ``,
    `Review comments to address:`,
    commentSummary,
    ``,
    `Checkout the branch, fix the issues, commit, and push.`,
  ].join('\n');
}

function slackNotify(message: string): void {
  try {
    const envPath = join(homedir(), 'agents-squads', 'hq', '.env');
    if (!existsSync(envPath)) return;

    const env = readFileSync(envPath, 'utf-8');
    const tokenMatch = env.match(/SLACK_BOT_TOKEN=(.+)/);
    if (!tokenMatch) return;

    const token = tokenMatch[1].trim();
    // Founder's DM channel
    const founderId = 'U0A6NQ3U0JG';

    execSync(
      `curl -s -X POST https://slack.com/api/chat.postMessage \
        -H "Authorization: Bearer ${token}" \
        -H "Content-Type: application/json" \
        -d '${JSON.stringify({ channel: founderId, text: message }).replace(/'/g, "'\\''")}'`,
      { timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch {
    // Silent — Slack is best-effort
  }
}

// ── Main cycle ───────────────────────────────────────────────────────

async function runCycle(options: DaemonOptions): Promise<CycleResult> {
  // Refresh bot token for gh CLI calls
  botGhEnv = await getBotGhEnv();

  const state = loadState();
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

  // Check budget
  if (state.dailyCost >= options.budget) {
    writeLine(`  ${icons.warning} ${colors.yellow}Daily budget reached ($${state.dailyCost.toFixed(2)}/$${options.budget})${RESET}`);
    saveState(state);
    return result;
  }

  // Gather intelligence
  writeLine(`  ${colors.dim}Scanning org state...${RESET}`);
  const signals = scoreSquads(state);

  if (signals.length === 0) {
    writeLine(`  ${colors.dim}No squads need attention${RESET}`);
    saveState(state);
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
    saveState(state);
    return result;
  }

  if (options.dryRun) {
    writeLine(`  ${colors.yellow}[DRY RUN] Would dispatch:${RESET}`);
    for (const sig of toDispatch) {
      writeLine(`    ${colors.cyan}${sig.squad}/${sig.agent}${RESET} — ${sig.reason}`);
    }
    saveState(state);
    return result;
  }

  // Dispatch agents
  const jobs: RunningJob[] = [];
  for (const sig of toDispatch) {
    // Build task from top issue
    const topIssue = sig.issues[0];
    const task = topIssue
      ? `Fix issue #${topIssue.number}: ${topIssue.title}`
      : undefined;

    writeLine(`  ${icons.running} Dispatching ${colors.cyan}${sig.squad}/${sig.agent}${RESET}${task ? ` → #${topIssue?.number}` : ''}`);
    const job = dispatchAgent(sig.squad, sig.agent || 'issue-solver', task);
    jobs.push(job);
    result.dispatched.push(`${sig.squad}/${sig.agent}`);
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

      // Track failures
      if (outcome === 'failed' || outcome === 'timeout') {
        state.failCounts[key] = (state.failCounts[key] || 0) + 1;
        result.failed.push(`${job.squad}/${job.agent}`);
        writeLine(`  ${icons.error} ${colors.red}${job.squad}/${job.agent}${RESET} ${outcome} (${durationMin}m)`);
      } else {
        state.failCounts[key] = 0; // Reset on success
        result.completed.push(`${job.squad}/${job.agent}`);
        writeLine(`  ${icons.success} ${colors.green}${job.squad}/${job.agent}${RESET} completed (${durationMin}m)`);
      }

      // Estimate cost (~$0.50 per agent run average)
      const estimatedCost = 0.50;
      state.dailyCost += estimatedCost;
      result.costEstimate += estimatedCost;

      return { job, outcome, durationMs };
    }),
  );

  // Trim recent runs to last 50
  state.recentRuns = state.recentRuns.slice(-50);
  state.lastCycle = new Date().toISOString();
  saveState(state);

  // React: check for new PRs
  writeLine();
  for (const { job, outcome } of outcomes) {
    if (outcome !== 'completed') continue;
    const repo = SQUAD_REPOS[job.squad];
    if (!repo) continue;
    const newPRs = checkNewPRs(repo, 30);
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

    for (const repo of Object.values(SQUAD_REPOS)) {
      const prsWithFeedback = getPRsWithReviewFeedback(repo);
      for (const pr of prsWithFeedback) {
        // Find which squad owns this repo
        const squad = Object.entries(SQUAD_REPOS).find(([, r]) => r === repo)?.[0];
        if (!squad) continue;

        // Check budget
        if (state.dailyCost >= options.budget) break;

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

  saveState(state);

  // Slack summary
  if (result.completed.length > 0 || result.failed.length > 0) {
    const summary = [
      `*Daemon cycle complete*`,
      result.completed.length > 0 ? `Completed: ${result.completed.join(', ')}` : '',
      result.failed.length > 0 ? `Failed: ${result.failed.join(', ')}` : '',
      `Est. cost: $${result.costEstimate.toFixed(2)} (daily: $${state.dailyCost.toFixed(2)}/$${options.budget})`,
    ].filter(Boolean).join('\n');
    slackNotify(summary);
  }

  // Escalate persistent failures
  for (const [key, count] of Object.entries(state.failCounts)) {
    if (count >= 3) {
      slackNotify(`*Escalation*: ${key} has failed ${count} times consecutively. Needs human attention.`);
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
    budget: parseFloat(options.budget || '10'),
  };

  writeLine();
  writeLine(`  ${bold}squads daemon${RESET}`);
  writeLine(`  ${colors.dim}Interval: ${config.interval}m | Parallel: ${config.maxParallel} | Budget: $${config.budget}/day${config.dryRun ? ' | DRY RUN' : ''}${RESET}`);
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
