/**
 * Outcome tracking — observes GitHub for artifact outcomes.
 *
 * Polls issues/PRs created by agent runs to determine if work
 * was productive (merged, closed) or wasteful (abandoned, unmerged).
 * Uses `gh` CLI for GitHub queries — no API keys needed.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ── Types ────────────────────────────────────────────────────────────

export interface ArtifactRef {
  repo: string;
  number: number;
}

export interface OutcomeRecord {
  executionId: string;
  squad: string;
  agent: string;
  completedAt: string;
  costUsd: number;
  artifacts: {
    issuesCreated: ArtifactRef[];
    prsCreated: ArtifactRef[];
    commits: number;
  };
  outcomes: {
    issuesClosed: number;
    issuesOpen: number;
    prsMerged: number;
    prsClosedUnmerged: number;
    prsOpen: number;
    ciPassFirstPush: boolean | null;
    reviewCycleHours: number | null;
  };
  lastPolledAt: string;
  settled: boolean;
}

export interface AgentScorecard {
  squad: string;
  agent: string;
  period: '7d' | '30d';
  executions: number;
  wasteRate: number;
  mergeRate: number;
  issueResolutionRate: number;
  ciPassRate: number;
  avgReviewCycleHours: number;
  costPerOutcome: number;
}

// ── Storage ──────────────────────────────────────────────────────────

const OUTCOMES_DIR = join(homedir(), '.squads', 'daemon');
const OUTCOMES_FILE = join(OUTCOMES_DIR, 'outcomes.json');

interface OutcomesData {
  records: OutcomeRecord[];
  scorecards: AgentScorecard[];
  lastUpdated: string;
}

function loadOutcomes(): OutcomesData {
  if (!existsSync(OUTCOMES_DIR)) mkdirSync(OUTCOMES_DIR, { recursive: true });
  if (!existsSync(OUTCOMES_FILE)) {
    return { records: [], scorecards: [], lastUpdated: '' };
  }
  try {
    return JSON.parse(readFileSync(OUTCOMES_FILE, 'utf-8'));
  } catch {
    return { records: [], scorecards: [], lastUpdated: '' };
  }
}

function saveOutcomes(data: OutcomesData): void {
  if (!existsSync(OUTCOMES_DIR)) mkdirSync(OUTCOMES_DIR, { recursive: true });
  data.lastUpdated = new Date().toISOString();
  writeFileSync(OUTCOMES_FILE, JSON.stringify(data, null, 2));
}

// ── GitHub helpers ───────────────────────────────────────────────────

function ghExec(cmd: string, env?: Record<string, string>): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Find PRs created by the bot in the last N minutes for a repo.
 */
function findRecentBotPRs(
  repo: string,
  sinceMins: number,
  ghEnv?: Record<string, string>,
): ArtifactRef[] {
  const raw = ghExec(
    `gh pr list -R ${repo} --author "agents-squads[bot]" --state all --json number,createdAt --limit 10`,
    ghEnv,
  );
  if (!raw) return [];

  try {
    const prs = JSON.parse(raw) as Array<{ number: number; createdAt: string }>;
    const cutoff = Date.now() - sinceMins * 60 * 1000;
    return prs
      .filter(pr => new Date(pr.createdAt).getTime() > cutoff)
      .map(pr => ({ repo, number: pr.number }));
  } catch {
    return [];
  }
}

/**
 * Find issues created by the bot in the last N minutes for a repo.
 */
function findRecentBotIssues(
  repo: string,
  sinceMins: number,
  ghEnv?: Record<string, string>,
): ArtifactRef[] {
  const raw = ghExec(
    `gh issue list -R ${repo} --author "agents-squads[bot]" --state all --json number,createdAt --limit 10`,
    ghEnv,
  );
  if (!raw) return [];

  try {
    const issues = JSON.parse(raw) as Array<{ number: number; createdAt: string }>;
    const cutoff = Date.now() - sinceMins * 60 * 1000;
    return issues
      .filter(i => new Date(i.createdAt).getTime() > cutoff)
      .map(i => ({ repo, number: i.number }));
  } catch {
    return [];
  }
}

/**
 * Count commits on the default branch in the last N minutes.
 */
function countRecentCommits(
  repo: string,
  sinceMins: number,
  ghEnv?: Record<string, string>,
): number {
  const since = new Date(Date.now() - sinceMins * 60 * 1000).toISOString();
  const raw = ghExec(
    `gh api repos/${repo}/commits --jq 'length' -f since="${since}" -f per_page=50`,
    ghEnv,
  );
  return raw ? parseInt(raw, 10) || 0 : 0;
}

// ── Core functions ───────────────────────────────────────────────────

/**
 * Record artifacts created by a completed agent run.
 * Called after each `squads run` finishes in the daemon.
 */
export function recordArtifacts(
  exec: {
    executionId: string;
    squad: string;
    agent: string;
    completedAt: string;
    costUsd: number;
    repo?: string;
  },
  ghEnv?: Record<string, string>,
): OutcomeRecord | null {
  if (!exec.repo) return null;

  const data = loadOutcomes();

  // Don't double-record
  if (data.records.some(r => r.executionId === exec.executionId)) return null;

  // Look for artifacts created in the last 30 minutes (typical agent run window)
  const prs = findRecentBotPRs(exec.repo, 30, ghEnv);
  const issues = findRecentBotIssues(exec.repo, 30, ghEnv);
  const commits = countRecentCommits(exec.repo, 30, ghEnv);

  const record: OutcomeRecord = {
    executionId: exec.executionId,
    squad: exec.squad,
    agent: exec.agent,
    completedAt: exec.completedAt,
    costUsd: exec.costUsd,
    artifacts: {
      issuesCreated: issues,
      prsCreated: prs,
      commits,
    },
    outcomes: {
      issuesClosed: 0,
      issuesOpen: issues.length,
      prsMerged: 0,
      prsClosedUnmerged: 0,
      prsOpen: prs.length,
      ciPassFirstPush: null,
      reviewCycleHours: null,
    },
    lastPolledAt: new Date().toISOString(),
    settled: prs.length === 0 && issues.length === 0, // No artifacts = settled immediately
  };

  data.records.push(record);

  // Trim to last 200 records
  if (data.records.length > 200) {
    data.records = data.records.slice(-200);
  }

  saveOutcomes(data);
  return record;
}

/**
 * Poll GitHub for outcome updates on unsettled records.
 * Rate-limited to 30 API calls per cycle.
 */
export function pollOutcomes(ghEnv?: Record<string, string>): {
  polled: number;
  settled: number;
} {
  const data = loadOutcomes();
  const unsettled = data.records.filter(r => !r.settled);
  let apiCalls = 0;
  let newlySettled = 0;
  const MAX_CALLS = 30;

  for (const record of unsettled) {
    if (apiCalls >= MAX_CALLS) break;

    let allTerminal = true;

    // Check PRs
    for (const pr of record.artifacts.prsCreated) {
      if (apiCalls >= MAX_CALLS) break;
      apiCalls++;

      const raw = ghExec(
        `gh pr view ${pr.number} -R ${pr.repo} --json state,mergedAt,createdAt,statusCheckRollup`,
        ghEnv,
      );
      if (!raw) { allTerminal = false; continue; }

      try {
        const prData = JSON.parse(raw) as {
          state: string;
          mergedAt: string | null;
          createdAt: string;
          statusCheckRollup: Array<{ conclusion: string }> | null;
        };

        if (prData.state === 'MERGED') {
          record.outcomes.prsMerged++;
          record.outcomes.prsOpen = Math.max(0, record.outcomes.prsOpen - 1);

          // Calculate review cycle hours
          if (prData.mergedAt && prData.createdAt) {
            const created = new Date(prData.createdAt).getTime();
            const merged = new Date(prData.mergedAt).getTime();
            record.outcomes.reviewCycleHours = (merged - created) / (1000 * 60 * 60);
          }

          // CI pass on first push
          if (record.outcomes.ciPassFirstPush === null && prData.statusCheckRollup) {
            record.outcomes.ciPassFirstPush = prData.statusCheckRollup.every(
              c => c.conclusion === 'SUCCESS',
            );
          }
        } else if (prData.state === 'CLOSED') {
          record.outcomes.prsClosedUnmerged++;
          record.outcomes.prsOpen = Math.max(0, record.outcomes.prsOpen - 1);
        } else {
          allTerminal = false; // Still open
        }
      } catch {
        allTerminal = false;
      }
    }

    // Check issues
    for (const issue of record.artifacts.issuesCreated) {
      if (apiCalls >= MAX_CALLS) break;
      apiCalls++;

      const raw = ghExec(
        `gh issue view ${issue.number} -R ${issue.repo} --json state`,
        ghEnv,
      );
      if (!raw) { allTerminal = false; continue; }

      try {
        const issueData = JSON.parse(raw) as { state: string };
        if (issueData.state === 'CLOSED') {
          record.outcomes.issuesClosed++;
          record.outcomes.issuesOpen = Math.max(0, record.outcomes.issuesOpen - 1);
        } else {
          allTerminal = false;
        }
      } catch {
        allTerminal = false;
      }
    }

    // Mark settled if all artifacts reached terminal state
    if (allTerminal && record.artifacts.prsCreated.length + record.artifacts.issuesCreated.length > 0) {
      record.settled = true;
      newlySettled++;
    }

    // Also settle records older than 30 days regardless
    const age = Date.now() - new Date(record.completedAt).getTime();
    if (age > 30 * 24 * 60 * 60 * 1000) {
      record.settled = true;
      if (!allTerminal) newlySettled++;
    }

    record.lastPolledAt = new Date().toISOString();
  }

  saveOutcomes(data);
  return { polled: apiCalls, settled: newlySettled };
}

/**
 * Compute scorecard for an agent over a time period.
 */
export function computeScorecard(
  squad: string,
  agent: string,
  period: '7d' | '30d',
): AgentScorecard | null {
  const data = loadOutcomes();
  const periodMs = period === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - periodMs;

  const records = data.records.filter(
    r => r.squad === squad && r.agent === agent &&
         new Date(r.completedAt).getTime() > cutoff,
  );

  if (records.length === 0) return null;

  const totalPRs = records.reduce((sum, r) => sum + r.artifacts.prsCreated.length, 0);
  const mergedPRs = records.reduce((sum, r) => sum + r.outcomes.prsMerged, 0);
  const unmergedPRs = records.reduce((sum, r) => sum + r.outcomes.prsClosedUnmerged, 0);
  const totalIssues = records.reduce((sum, r) => sum + r.artifacts.issuesCreated.length, 0);
  const closedIssues = records.reduce((sum, r) => sum + r.outcomes.issuesClosed, 0);
  const totalCost = records.reduce((sum, r) => sum + r.costUsd, 0);

  // Waste = runs with zero artifacts
  const wasteRuns = records.filter(
    r => r.artifacts.prsCreated.length === 0 &&
         r.artifacts.issuesCreated.length === 0 &&
         r.artifacts.commits === 0,
  ).length;

  // CI pass rate
  const ciRecords = records.filter(r => r.outcomes.ciPassFirstPush !== null);
  const ciPassed = ciRecords.filter(r => r.outcomes.ciPassFirstPush === true).length;

  // Avg review cycle
  const reviewCycles = records
    .filter(r => r.outcomes.reviewCycleHours !== null)
    .map(r => r.outcomes.reviewCycleHours!);
  const avgReviewCycleHours = reviewCycles.length > 0
    ? reviewCycles.reduce((a, b) => a + b, 0) / reviewCycles.length
    : 0;

  // Cost per outcome (issues closed + PRs merged)
  const outcomes = closedIssues + mergedPRs;

  return {
    squad,
    agent,
    period,
    executions: records.length,
    wasteRate: records.length > 0 ? wasteRuns / records.length : 0,
    mergeRate: totalPRs > 0 ? mergedPRs / totalPRs : 0,
    issueResolutionRate: totalIssues > 0 ? closedIssues / totalIssues : 0,
    ciPassRate: ciRecords.length > 0 ? ciPassed / ciRecords.length : 0,
    avgReviewCycleHours,
    costPerOutcome: outcomes > 0 ? totalCost / outcomes : totalCost,
  };
}

/**
 * Compute scorecards for all agents that have outcome data.
 */
export function computeAllScorecards(period: '7d' | '30d' = '7d'): AgentScorecard[] {
  const data = loadOutcomes();
  const periodMs = period === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - periodMs;

  // Find unique squad/agent combos in period
  const agents = new Set<string>();
  for (const r of data.records) {
    if (new Date(r.completedAt).getTime() > cutoff) {
      agents.add(`${r.squad}/${r.agent}`);
    }
  }

  const scorecards: AgentScorecard[] = [];
  for (const key of agents) {
    const [squad, agent] = key.split('/');
    const card = computeScorecard(squad, agent, period);
    if (card) scorecards.push(card);
  }

  // Sort by executions descending
  scorecards.sort((a, b) => b.executions - a.executions);

  // Persist
  data.scorecards = scorecards;
  saveOutcomes(data);

  return scorecards;
}

/**
 * Get cached scorecards (no recompute).
 */
export function getScorecards(): AgentScorecard[] {
  return loadOutcomes().scorecards;
}

/**
 * Get all outcome records.
 */
export function getOutcomeRecords(): OutcomeRecord[] {
  return loadOutcomes().records;
}

/**
 * Apply outcome-based score modifiers to daemon squad scoring.
 * Returns a score adjustment (positive or negative).
 */
export function getOutcomeScoreModifier(squad: string, agent: string): number {
  const scorecards = getScorecards();
  const card = scorecards.find(s => s.squad === squad && s.agent === agent);

  // Minimum data threshold: need 3+ executions for modifiers
  if (!card || card.executions < 3) return 0;

  let modifier = 0;

  // High waste rate penalty
  if (card.wasteRate > 0.5) modifier -= 30;

  // Low merge rate penalty
  if (card.mergeRate < 0.3 && card.executions >= 3) modifier -= 20;

  // High performance bonus
  if (card.mergeRate > 0.7 && card.issueResolutionRate > 0.5) modifier += 15;

  // Expensive + low-scoring penalty
  if (card.costPerOutcome > 5) modifier -= 10;

  return modifier;
}
