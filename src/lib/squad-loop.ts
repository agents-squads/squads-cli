/**
 * squad-loop — shared state, scoring, and utility logic for the daemon
 * and any other command that needs squad-loop intelligence.
 *
 * Extracted from daemon.ts so that `squads run` can reuse the same
 * state management, scoring, cooldowns, and post-run reactions.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  findSquadsDir,
  listSquads,
  loadSquad,
} from './squad-parser.js';
import { findMemoryDir } from './memory.js';
import { getOutcomeScoreModifier } from './outcomes.js';
import {
  colors,
  RESET,
  writeLine,
} from './terminal.js';

// ── Constants ────────────────────────────────────────────────────────

/** Runs completing faster than this are phantom (no real work done). */
export const PHANTOM_THRESHOLD_MS = 5000;

/** Minimum duration to consider a run as real work (used by daemon). */
export const MIN_PHANTOM_DURATION_MS = 30 * 1000;

// ── Types ────────────────────────────────────────────────────────────

export interface GhIssue {
  number: number;
  title: string;
  labels: string[];
  repo: string;
}

export interface SquadSignal {
  squad: string;
  score: number;       // 0-100 urgency
  reason: string;
  agent?: string;      // specific agent to run, or undefined for squad conversation
  issues: GhIssue[];
}

export interface ReviewComment {
  author: string;
  body: string;
  path?: string;
  createdAt: string;
}

export interface PRWithReviews {
  number: number;
  title: string;
  branch: string;
  repo: string;
  comments: ReviewComment[];
}

// ── Loop State ───────────────────────────────────────────────────────

const STATE_DIR = join(homedir(), '.squads', 'daemon');
const STATE_FILE = join(STATE_DIR, 'state.json');

export interface LoopState {
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
  cooldowns: Record<string, number>; // squad:agent → timestamp of last dispatch
}

export function defaultState(): LoopState {
  return {
    lastCycle: '',
    dailyCost: 0,
    dailyCostDate: new Date().toISOString().slice(0, 10),
    recentRuns: [],
    failCounts: {},
    cooldowns: {},
  };
}

export function loadLoopState(): LoopState {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(STATE_FILE)) return defaultState();
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    // Ensure new fields exist for backward compatibility
    if (!raw.cooldowns) raw.cooldowns = {};
    return raw as LoopState;
  } catch {
    return defaultState();
  }
}

export function saveLoopState(state: LoopState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Outcome classification ───────────────────────────────────────────

/**
 * Classify how a run ended based on exit code and wall-clock duration.
 *
 * - completed: exit 0 and ran long enough to do real work
 * - failed:    non-zero exit
 * - skipped:   exit 0 but finished suspiciously fast (phantom)
 */
export function classifyRunOutcome(
  exitCode: number,
  durationMs: number,
): 'completed' | 'failed' | 'skipped' {
  if (exitCode !== 0) return 'failed';
  if (durationMs < MIN_PHANTOM_DURATION_MS) return 'skipped';
  return 'completed';
}

// ── Cooldowns ────────────────────────────────────────────────────────

/**
 * Check whether a squad/agent pair is still in cooldown.
 * Returns true if the pair can run (cooldown expired or never set).
 */
export function checkCooldown(
  state: LoopState,
  squad: string,
  agentType: string,
  cooldownMs: number,
): boolean {
  const key = `${squad}:${agentType}`;
  const lastDispatch = state.cooldowns[key];
  if (lastDispatch === undefined) return true;
  return Date.now() - lastDispatch >= cooldownMs;
}

// ── Intelligence: GitHub queries ─────────────────────────────────────

export function getOpenIssues(repo: string, ghEnv: Record<string, string> = {}): GhIssue[] {
  try {
    const raw = execSync(
      `gh issue list -R ${repo} --state open --json number,title,labels --limit 20`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
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

export function getOpenPRs(
  repo: string,
  ghEnv: Record<string, string> = {},
): Array<{ number: number; title: string; branch: string; checks: string }> {
  try {
    const raw = execSync(
      `gh pr list -R ${repo} --state open --json number,title,headRefName,statusCheckRollup --limit 10`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
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

// ── Execution helpers ────────────────────────────────────────────────

export function getLastRunAge(squad: string, agent: string): number | null {
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

// ── Escalation check ────────────────────────────────────────────────

/**
 * Check if a squad has unresolved escalations (blocked/needs-human issues).
 * If so, the squad should be paused — no point dispatching agents that can't work.
 */
export function hasUnresolvedEscalation(
  repo: string,
  ghEnv: Record<string, string> = {},
): { blocked: boolean; issue?: { number: number; title: string } } {
  try {
    const raw = execSync(
      `gh issue list -R ${repo} --label "blocked" --state open --json number,title --limit 1`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
    );
    const issues = JSON.parse(raw) as Array<{ number: number; title: string }>;
    if (issues.length > 0) {
      return { blocked: true, issue: issues[0] };
    }

    // Also check needs-human label
    const raw2 = execSync(
      `gh issue list -R ${repo} --label "needs-human" --state open --json number,title --limit 1`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
    );
    const issues2 = JSON.parse(raw2) as Array<{ number: number; title: string }>;
    if (issues2.length > 0) {
      return { blocked: true, issue: issues2[0] };
    }

    return { blocked: false };
  } catch {
    return { blocked: false }; // Can't check = assume not blocked
  }
}

// ── Squad scoring ────────────────────────────────────────────────────

/**
 * Build squad→repo mapping dynamically from SQUAD.md `repo:` fields.
 * Falls back to detecting org from git remote + squad name conventions.
 */
export function getSquadRepos(): Record<string, string> {
  const repos: Record<string, string> = {};
  const squadsDir = findSquadsDir();
  if (!squadsDir) return repos;

  try {
    const squads = listSquads(squadsDir);
    for (const squad of squads) {
      const squadMd = join(squadsDir, squad, 'SQUAD.md');
      if (!existsSync(squadMd)) continue;

      const content = readFileSync(squadMd, 'utf-8');
      const repoMatch = content.match(/^repo:\s*(.+)/m);
      if (repoMatch) {
        repos[squad] = repoMatch[1].trim();
      }
    }
  } catch {
    // Fall back to empty — scoring will skip squads without repos
  }

  return repos;
}

export function scoreSquads(
  state: LoopState,
  squadRepos: Record<string, string>,
  ghEnv: Record<string, string> = {},
): SquadSignal[] {
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
      const repo = squadRepos[squadName];

      // Skip squads with unresolved escalations — don't waste tokens
      if (repo) {
        const escalation = hasUnresolvedEscalation(repo, ghEnv);
        if (escalation.blocked) {
          signals.push({
            squad: squadName,
            score: 0,
            reason: `PAUSED: unresolved escalation #${escalation.issue?.number} — ${escalation.issue?.title}`,
            issues: [],
          });
          continue;
        }
      }

      const issues = repo ? getOpenIssues(repo, ghEnv) : [];

      let score = 0;
      let reason = '';
      const CONVERSATION_ISSUE_THRESHOLD = 3;
      const CONVERSATION_COOLDOWN_MS = 48 * 60 * 60 * 1000;
      const lastConvAge = getLastRunAge(squadName, 'conversation');
      const conversationStale =
        lastConvAge === null || lastConvAge > CONVERSATION_COOLDOWN_MS;
      const useConversation =
        issues.length >= CONVERSATION_ISSUE_THRESHOLD && conversationStale;

      const targetAgent: string | undefined = useConversation
        ? undefined
        : 'issue-solver';

      if (repo) {
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
      } else {
        reason = 'no repo configured — staleness-based dispatch';
      }

      if (useConversation) {
        score += 10;
        reason += ' → conversation mode';
      }

      const agentForStaleness = targetAgent ?? 'conversation';
      const lastAge = getLastRunAge(squadName, agentForStaleness);
      if (lastAge !== null) {
        const hoursAgo = lastAge / (1000 * 60 * 60);
        if (hoursAgo > 48) {
          score += 20;
          reason += ` (stale: ${Math.floor(hoursAgo)}h since last run)`;
        } else if (hoursAgo > 24) {
          score += 10;
          reason += ` (${Math.floor(hoursAgo)}h since last run)`;
        } else if (hoursAgo < 2) {
          score -= 30;
          reason += ` (ran ${Math.floor(hoursAgo * 60)}m ago)`;
        }
      } else if (!repo) {
        score += 15;
        reason += ' (never run)';
      }

      const failKey = `${squadName}:${agentForStaleness}`;
      const failures = state.failCounts[failKey] || 0;
      if (failures >= 3) {
        score -= 40;
        reason += ` (${failures} consecutive failures — needs human)`;
      } else if (failures >= 1) {
        score -= 10 * failures;
      }

      const outcomeModifier = getOutcomeScoreModifier(squadName, agentForStaleness);
      if (outcomeModifier !== 0) {
        score += outcomeModifier;
        reason += ` (outcome: ${outcomeModifier > 0 ? '+' : ''}${outcomeModifier})`;
      }

      if (score > 0 && (issues.length > 0 || !repo)) {
        signals.push({ squad: squadName, score, reason, agent: targetAgent, issues });
      }
    } catch {
      continue;
    }
  }

  signals.sort((a, b) => b.score - a.score);
  return signals;
}

// ── Post-run reactions ───────────────────────────────────────────────

export function checkNewPRs(
  repo: string,
  sinceMins: number = 30,
  ghEnv: Record<string, string> = {},
): Array<{ number: number; title: string }> {
  try {
    const raw = execSync(
      `gh pr list -R ${repo} --state open --json number,title,createdAt --limit 5`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
    );
    const prs = JSON.parse(raw) as Array<{ number: number; title: string; createdAt: string }>;
    const cutoff = Date.now() - sinceMins * 60 * 1000;
    return prs.filter(pr => new Date(pr.createdAt).getTime() > cutoff);
  } catch {
    return [];
  }
}

/**
 * Extract the first `#<digits>` issue reference from a `--task` directive
 * (e.g. "Fix agents-squads/squads-cli#951 ..." → 951). Returns null if the
 * task text doesn't reference an issue number.
 */
export function parseIssueNumberFromTask(task: string): number | null {
  const match = task.match(/#(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Deliver-and-stop gate (#951): check whether a PR already exists (open or
 * merged) that addresses the given issue number — so a scoped `--task`
 * conversation can stop once the work has already landed, instead of running
 * more turns against an issue someone else (or a prior cycle) already closed.
 */
export function checkPrForIssue(
  repo: string,
  issueNumber: number,
  ghEnv: Record<string, string> = {},
): { number: number; title: string } | null {
  try {
    const raw = execSync(
      `gh pr list -R ${repo} --state all --json number,title,body,state --limit 30`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
    );
    const prs = JSON.parse(raw) as Array<{ number: number; title: string; body: string; state: string }>;
    // Closing keywords ONLY (#971): a bare `#N` matched casual cross-references
    // ("tracked in #957", "the A4 gate false-positive (#971)") and stopped runs
    // whose work nobody had done — including, recursively, the run dispatched
    // to fix this very bug. Same keyword family as close-linked-issues.yml.
    const pattern = new RegExp(
      '\\b(?:clos(?:e|es|ed)|fix(?:es|ed)?|resolv(?:e|es|ed))\\s*:?\\s+#' + issueNumber + '\\b',
      'i',
    );
    const match = prs.find(
      pr => (pr.state === 'OPEN' || pr.state === 'MERGED') &&
        (pattern.test(pr.title) || pattern.test(pr.body || '')),
    );
    return match ? { number: match.number, title: match.title } : null;
  } catch {
    return null;
  }
}

/**
 * Get open PRs with unaddressed review comments (from Gemini, humans, etc).
 * Skips comments from our own bot to avoid feedback loops.
 */
export function getPRsWithReviewFeedback(
  repo: string,
  ghEnv: Record<string, string> = {},
): PRWithReviews[] {
  try {
    const prsRaw = execSync(
      `gh pr list -R ${repo} --state open --author "agents-squads[bot]" --json number,title,headRefName --limit 10`,
      { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
    );
    const prs = JSON.parse(prsRaw) as Array<{ number: number; title: string; headRefName: string }>;

    const results: PRWithReviews[] = [];

    for (const pr of prs) {
      try {
        const reviewsRaw = execSync(
          `gh api repos/${repo}/pulls/${pr.number}/comments --jq '.[] | {author: .user.login, body: .body, path: .path, createdAt: .created_at}'`,
          { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
        );

        const issueCommentsRaw = execSync(
          `gh api repos/${repo}/issues/${pr.number}/comments --jq '.[] | {author: .user.login, body: .body, createdAt: .created_at}'`,
          { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...ghEnv } },
        );

        const comments: ReviewComment[] = [];

        for (const line of [...reviewsRaw.split('\n'), ...issueCommentsRaw.split('\n')]) {
          if (!line.trim()) continue;
          try {
            const comment = JSON.parse(line) as ReviewComment;
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
export function buildReviewTask(pr: PRWithReviews): string {
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

// ── Slack ────────────────────────────────────────────────────────────

export async function slackNotify(message: string): Promise<void> {
  try {
    const envPath = join(homedir(), 'agents-squads', 'hq', '.env');
    if (!existsSync(envPath)) return;

    const env = readFileSync(envPath, 'utf-8');
    const tokenMatch = env.match(/SLACK_BOT_TOKEN=(.+)/);
    if (!tokenMatch) return;

    const token = tokenMatch[1].trim();
    const founderId = 'U0A6NQ3U0JG';

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ channel: founderId, text: message }),
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Silent — Slack is best-effort
  }
}

// ── Phase Computation ─────────────────────────────────────────────────

/**
 * Compute execution phases from squad depends_on declarations.
 * Performs topological sort with cycle detection.
 *
 * Rules:
 * - No depends_on = phase 0 (runs first)
 * - depends_on: ["*"] = last phase (evaluation)
 * - Circular deps = grouped into same phase
 * - Missing deps = warned and ignored
 *
 * @returns Map from phase number to array of squad names in that phase
 */
export function computePhases(squadNames?: string[]): Map<number, string[]> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return new Map([[0, squadNames || []]]);

  // Load all squads and their depends_on
  const names = squadNames || listSquads(squadsDir);
  const deps = new Map<string, string[]>();
  const starSquads: string[] = []; // depends_on: ["*"]

  for (const name of names) {
    const squad = loadSquad(name);
    if (!squad) continue;

    if (squad.depends_on && squad.depends_on.length === 1 && squad.depends_on[0] === '*') {
      starSquads.push(name);
      continue;
    }

    // Filter out deps that reference squads not in our set
    const validDeps = (squad.depends_on || []).filter(d => names.includes(d));
    if (squad.depends_on) {
      const invalid = squad.depends_on.filter(d => d !== '*' && !names.includes(d));
      if (invalid.length > 0) {
        writeLine(`  ${colors.dim}warn: ${name} depends_on unknown squads: ${invalid.join(', ')}${RESET}`);
      }
    }
    deps.set(name, validDeps);
  }

  // Topological sort with cycle detection (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>(); // dep -> dependents

  for (const [squad, squadDeps] of deps) {
    if (!inDegree.has(squad)) inDegree.set(squad, 0);
    for (const dep of squadDeps) {
      if (!adjList.has(dep)) adjList.set(dep, []);
      adjList.get(dep)!.push(squad);
      inDegree.set(squad, (inDegree.get(squad) || 0) + 1);
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
    }
  }

  // Also ensure squads with no deps and not in adjList are included
  for (const [squad] of deps) {
    if (!inDegree.has(squad)) inDegree.set(squad, 0);
  }

  const phases = new Map<number, string[]>();
  let phase = 0;
  const processed = new Set<string>();

  // Process phases until all squads are assigned
  const remaining = new Set([...deps.keys()]);

  while (remaining.size > 0) {
    // Find all squads with in-degree 0 (no unresolved deps)
    const ready: string[] = [];
    for (const squad of remaining) {
      if ((inDegree.get(squad) || 0) <= 0) {
        ready.push(squad);
      }
    }

    if (ready.length === 0) {
      // Cycle detected — group remaining into current phase
      const cycled = [...remaining];
      if (!phases.has(phase)) phases.set(phase, []);
      phases.get(phase)!.push(...cycled);
      for (const s of cycled) processed.add(s);
      break;
    }

    phases.set(phase, ready);
    for (const squad of ready) {
      processed.add(squad);
      remaining.delete(squad);
      // Decrement in-degree for dependents
      for (const dependent of (adjList.get(squad) || [])) {
        inDegree.set(dependent, (inDegree.get(dependent) || 0) - 1);
      }
    }
    phase++;
  }

  // Star squads go in the last phase
  if (starSquads.length > 0) {
    phases.set(phase, starSquads);
  }

  return phases;
}

/**
 * Score only squads in a specific phase.
 * Wrapper around scoreSquads that filters to phase members.
 */
export function scoreSquadsForPhase(
  phaseSquads: string[],
  state: LoopState,
  squadRepos: Record<string, string>,
  ghEnv: Record<string, string>,
): SquadSignal[] {
  const allSignals = scoreSquads(state, squadRepos, ghEnv);
  return allSignals.filter(s => phaseSquads.includes(s.squad));
}

/**
 * Tier 2: fetch pending triggers from the API.
 * Falls back to local scoring if API unavailable.
 */
export async function fetchTriggersFromApi(): Promise<SquadSignal[] | null> {
  try {
    const { isTier2, getTierSync } = await import('./tier-detect.js');
    if (!isTier2()) return null;

    const apiUrl = getTierSync().urls.api;
    if (!apiUrl) return null;

    const response = await fetch(`${apiUrl}/triggers/pending`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;

    const triggers = await response.json() as Array<{
      squad: string;
      agent: string;
      trigger_name: string;
      priority: number;
      context: Record<string, unknown>;
    }>;

    return triggers.map(t => ({
      squad: t.squad,
      score: t.priority * 10,
      reason: `Trigger: ${t.trigger_name}`,
      issues: [],
      agent: t.agent,
      context: t.context,
    }));
  } catch {
    return null; // API unavailable — caller should fall back to local scoring
  }
}
