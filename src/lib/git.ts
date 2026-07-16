import { execSync, exec } from 'child_process';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { promisify } from 'util';
import { colors, RESET, writeLine } from './terminal.js';

const execAsync = promisify(exec);

// ── Repo-scoped git identity fallback (#980) ─────────────────────────
//
// Fresh machines with no `user.name`/`user.email` configured (locally or
// globally) make every git write squads performs fail with "Author identity
// unknown" — `squads init`'s scaffold commit, `squads run`'s worktree/harvest
// commits, memory sync, etc. Rather than touching the user's git config
// (never — trust-model law), every write applies this fallback identity
// commit-scoped via `-c user.name=... -c user.email=...` ONLY when no
// identity is configured for the repo.

const FALLBACK_GIT_USER_NAME = 'squads';
const FALLBACK_GIT_USER_EMAIL = 'squads-agent@localhost';

let hasPrintedIdentityFallbackHint = false;

/**
 * Returns inline `-c user.name=... -c user.email=...` flags for a git
 * invocation when `repoRoot` has no configured identity (checked the same
 * way git itself resolves it — repo-local, then global, then system config),
 * or '' when an identity is already configured. Never writes to any git
 * config file — the returned flags are scoped to the single invocation they
 * are passed to.
 */
export function gitIdentityArgs(repoRoot: string): string {
  try {
    const email = execSync('git config user.email', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (email) return '';
  } catch {
    // `git config user.email` exits non-zero when unset at every level
    // (local/global/system) — fall through to the fallback identity.
  }

  printGitIdentityFallbackHintOnce();
  return `-c user.name='${FALLBACK_GIT_USER_NAME}' -c user.email='${FALLBACK_GIT_USER_EMAIL}'`;
}

function printGitIdentityFallbackHintOnce(): void {
  if (hasPrintedIdentityFallbackHint) return;
  hasPrintedIdentityFallbackHint = true;
  writeLine(
    `  ${colors.dim}using fallback git identity for agent commits — set yours: git config --global user.email you@example.com${RESET}`
  );
}

/** Test-only: clear the one-time hint flag between test cases. */
export function resetGitIdentityFallbackHintForTests(): void {
  hasPrintedIdentityFallbackHint = false;
}

export interface GitStatus {
  isGitRepo: boolean;
  hasRemote: boolean;
  remoteName?: string;
  remoteUrl?: string;
  branch?: string;
  isDirty: boolean;
  uncommittedCount: number;
}

/**
 * Check git status - synchronous version for backwards compatibility
 */
export function checkGitStatus(cwd: string = process.cwd()): GitStatus {
  const status: GitStatus = {
    isGitRepo: false,
    hasRemote: false,
    isDirty: false,
    uncommittedCount: 0,
  };

  // Check if .git directory exists
  if (!existsSync(join(cwd, '.git'))) {
    return status;
  }

  status.isGitRepo = true;

  try {
    // Run all git commands in parallel using a single combined command
    // This reduces 3 sequential execSync calls to 1
    const combined = execSync(
      'echo "BRANCH:" && git rev-parse --abbrev-ref HEAD && echo "REMOTES:" && git remote -v && echo "STATUS:" && git status --porcelain',
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
    );

    // Parse combined output
    const branchMatch = combined.match(/BRANCH:\n(.+)\n/);
    if (branchMatch) {
      status.branch = branchMatch[1].trim();
    }

    const remotesMatch = combined.match(/REMOTES:\n([\s\S]*?)STATUS:/);
    if (remotesMatch) {
      const remotes = remotesMatch[1].trim();
      if (remotes) {
        status.hasRemote = true;
        const lines = remotes.split('\n');
        if (lines.length > 0) {
          const parts = lines[0].split(/\s+/);
          status.remoteName = parts[0];
          status.remoteUrl = parts[1];
        }
      }
    }

    const statusMatch = combined.match(/STATUS:\n([\s\S]*?)$/);
    if (statusMatch) {
      const statusOutput = statusMatch[1].trim();
      if (statusOutput) {
        status.isDirty = true;
        status.uncommittedCount = statusOutput.split('\n').filter(l => l.trim()).length;
      }
    }

  } catch {
    // Git commands failed, but we know it's a git repo
  }

  return status;
}

/**
 * Check git status - async version with parallel git commands
 */
export async function checkGitStatusAsync(cwd: string = process.cwd()): Promise<GitStatus> {
  const status: GitStatus = {
    isGitRepo: false,
    hasRemote: false,
    isDirty: false,
    uncommittedCount: 0,
  };

  // Check if .git directory exists
  if (!existsSync(join(cwd, '.git'))) {
    return status;
  }

  status.isGitRepo = true;

  try {
    // Run all git commands in parallel
    const [branchResult, remotesResult, statusResult] = await Promise.all([
      execAsync('git rev-parse --abbrev-ref HEAD', { cwd, timeout: 5000 }).catch(() => ({ stdout: '' })),
      execAsync('git remote -v', { cwd, timeout: 5000 }).catch(() => ({ stdout: '' })),
      execAsync('git status --porcelain', { cwd, timeout: 5000 }).catch(() => ({ stdout: '' })),
    ]);

    status.branch = branchResult.stdout.trim();

    const remotes = remotesResult.stdout.trim();
    if (remotes) {
      status.hasRemote = true;
      const lines = remotes.split('\n');
      if (lines.length > 0) {
        const parts = lines[0].split(/\s+/);
        status.remoteName = parts[0];
        status.remoteUrl = parts[1];
      }
    }

    const statusOutput = statusResult.stdout.trim();
    if (statusOutput) {
      status.isDirty = true;
      status.uncommittedCount = statusOutput.split('\n').filter(l => l.trim()).length;
    }

  } catch {
    // Git commands failed, but we know it's a git repo
  }

  return status;
}

export function initGitRepo(cwd: string = process.cwd()): boolean {
  try {
    execSync('git init', { cwd, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function getRepoName(remoteUrl?: string): string | null {
  if (!remoteUrl) return null;

  // Handle various remote URL formats
  // git@github.com:user/repo.git
  // https://github.com/user/repo.git
  const match = remoteUrl.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return match ? match[1] : null;
}

// Multi-repo git performance stats
export interface GitPerformanceStats {
  totalCommits: number;
  commitsByDay: Map<string, number>;  // date string -> count
  commitsByAuthor: Map<string, number>;
  commitsByRepo: Map<string, number>;
  activeDays: number;
  avgCommitsPerDay: number;
  peakDay: { date: string; count: number } | null;
  repos: RepoStats[];
  recentCommits: CommitInfo[];  // Most recent commits across all repos
}

export interface RepoStats {
  name: string;
  path: string;
  commits: number;
  lastCommit: string;
  authors: string[];
}

export interface CommitInfo {
  hash: string;
  author: string;
  date: string;
  message: string;
  repo: string;
}

const SQUAD_REPOS = ['hq', 'agents-squads-web', 'squads-cli', 'company', 'product', 'engineering', 'research', 'intelligence', 'customer', 'finance', 'marketing'];

// Squad to repo mapping for GitHub stats
const SQUAD_REPO_MAP: Record<string, string[]> = {
  website: ['agents-squads-web'],
  product: ['squads-cli'],
  engineering: ['hq', 'squads-cli'],
  research: ['research'],
  intelligence: ['intelligence'],
  customer: ['customer'],
  finance: ['finance'],
  company: ['company', 'hq'],
  marketing: ['marketing', 'agents-squads-web'],
};

// Label patterns that map to squads
const SQUAD_LABELS: Record<string, string[]> = {
  website: ['website', 'web', 'frontend', 'ui'],
  product: ['product', 'cli', 'feature'],
  engineering: ['engineering', 'infra', 'backend', 'bug'],
  research: ['research', 'analysis'],
  intelligence: ['intel', 'monitoring'],
  customer: ['customer', 'sales', 'lead'],
  finance: ['finance', 'cost', 'billing'],
  company: ['company', 'strategy'],
  marketing: ['marketing', 'content', 'seo'],
};

export interface GitHubStats {
  prsOpened: number;
  prsMerged: number;
  issuesClosed: number;
  issuesOpen: number;
  bySquad: Map<string, SquadGitHubStats>;
}

export interface SquadGitHubStats {
  prsOpened: number;
  prsMerged: number;
  issuesClosed: number;
  issuesOpen: number;
  commits: number;
  recentIssues: { title: string; number: number; state: string }[];
  recentPRs: { title: string; number: number; merged: boolean }[];
}

export async function getGitHubStats(basePath: string, days: number = 30): Promise<GitHubStats> {
  const stats: GitHubStats = {
    prsOpened: 0,
    prsMerged: 0,
    issuesClosed: 0,
    issuesOpen: 0,
    bySquad: new Map(),
  };

  // Initialize squad stats
  for (const squad of Object.keys(SQUAD_REPO_MAP)) {
    stats.bySquad.set(squad, {
      prsOpened: 0,
      prsMerged: 0,
      issuesClosed: 0,
      issuesOpen: 0,
      commits: 0,
      recentIssues: [],
      recentPRs: [],
    });
  }

  const repos = ['hq', 'agents-squads-web'];
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  for (const repo of repos) {
    const repoPath = join(basePath, repo);
    if (!existsSync(repoPath)) continue;

    try {
      // Get PRs
      const prsOutput = execSync(
        `gh pr list --state all --json number,title,createdAt,mergedAt,labels --limit 100 2>/dev/null`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const prs = JSON.parse(prsOutput || '[]');

      for (const pr of prs) {
        const created = new Date(pr.createdAt);
        if (created < new Date(since)) continue;

        stats.prsOpened++;
        if (pr.mergedAt) stats.prsMerged++;

        // Detect squad from labels or title
        const squad = detectSquadFromPR(pr, repo);
        const squadStats = stats.bySquad.get(squad);
        if (squadStats) {
          squadStats.prsOpened++;
          if (pr.mergedAt) squadStats.prsMerged++;
          if (squadStats.recentPRs.length < 3) {
            squadStats.recentPRs.push({
              title: pr.title,
              number: pr.number,
              merged: !!pr.mergedAt,
            });
          }
        }
      }

      // Get Issues
      const issuesOutput = execSync(
        `gh issue list --state all --json number,title,state,closedAt,labels --limit 100 2>/dev/null`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const issues = JSON.parse(issuesOutput || '[]');

      for (const issue of issues) {
        const squad = detectSquadFromIssue(issue, repo);
        const squadStats = stats.bySquad.get(squad);

        if (issue.state === 'CLOSED') {
          const closed = new Date(issue.closedAt);
          if (closed >= new Date(since)) {
            stats.issuesClosed++;
            if (squadStats) {
              squadStats.issuesClosed++;
            }
          }
        } else {
          stats.issuesOpen++;
          if (squadStats) {
            squadStats.issuesOpen++;
            if (squadStats.recentIssues.length < 3) {
              squadStats.recentIssues.push({
                title: issue.title,
                number: issue.number,
                state: issue.state,
              });
            }
          }
        }
      }
    } catch {
      // gh not available or not in repo
    }
  }

  // Add commit counts per squad
  const gitStats = await getMultiRepoGitStats(basePath, days);
  for (const [repo, commits] of gitStats.commitsByRepo) {
    // Map repo to squad
    for (const [squad, repos] of Object.entries(SQUAD_REPO_MAP)) {
      if (repos.includes(repo)) {
        const squadStats = stats.bySquad.get(squad);
        if (squadStats) {
          squadStats.commits += commits;
        }
      }
    }
  }

  return stats;
}

/**
 * Optimized GitHub stats - fetches PRs and issues in parallel across repos
 * Uses a single combined gh api call per repo for better performance
 */
export function getGitHubStatsOptimized(basePath: string, days: number = 30): GitHubStats {
  const stats: GitHubStats = {
    prsOpened: 0,
    prsMerged: 0,
    issuesClosed: 0,
    issuesOpen: 0,
    bySquad: new Map(),
  };

  // Initialize squad stats
  for (const squad of Object.keys(SQUAD_REPO_MAP)) {
    stats.bySquad.set(squad, {
      prsOpened: 0,
      prsMerged: 0,
      issuesClosed: 0,
      issuesOpen: 0,
      commits: 0,
      recentIssues: [],
      recentPRs: [],
    });
  }

  const repos = ['hq', 'agents-squads-web'];
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Fetch all data in parallel using a single combined command
  const results: { repo: string; prs: unknown[]; issues: unknown[] }[] = [];

  for (const repo of repos) {
    const repoPath = join(basePath, repo);
    if (!existsSync(repoPath)) continue;

    try {
      // Use a single shell command to get both PRs and issues
      // This reduces the number of gh CLI invocations from 4 to 2
      const output = execSync(
        `echo '{"prs":' && gh pr list --state all --json number,title,createdAt,mergedAt,labels --limit 50 2>/dev/null && echo ',"issues":' && gh issue list --state all --json number,title,state,closedAt,labels --limit 50 2>/dev/null && echo '}'`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
      );

      // Parse the combined output (handle edge cases)
      const prsMatch = output.match(/"prs":(\[.*?\]),"issues":/s);
      const issuesMatch = output.match(/"issues":(\[.*?\])\s*\}/s);

      const prs = prsMatch ? JSON.parse(prsMatch[1]) : [];
      const issues = issuesMatch ? JSON.parse(issuesMatch[1]) : [];

      results.push({ repo, prs, issues });
    } catch {
      // Fallback: try individual calls with short timeout
      try {
        const prsOutput = execSync(
          `gh pr list --state all --json number,title,createdAt,mergedAt,labels --limit 50 2>/dev/null`,
          { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        );
        const issuesOutput = execSync(
          `gh issue list --state all --json number,title,state,closedAt,labels --limit 50 2>/dev/null`,
          { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
        );
        results.push({
          repo,
          prs: JSON.parse(prsOutput || '[]'),
          issues: JSON.parse(issuesOutput || '[]'),
        });
      } catch {
        // Skip this repo
      }
    }
  }

  // Process results
  for (const { repo, prs, issues } of results) {
    // Process PRs
    for (const pr of prs as { createdAt: string; mergedAt?: string; title: string; number: number; labels: { name: string }[] }[]) {
      const created = new Date(pr.createdAt);
      if (created < new Date(since)) continue;

      stats.prsOpened++;
      if (pr.mergedAt) stats.prsMerged++;

      const squad = detectSquadFromPR(pr, repo);
      const squadStats = stats.bySquad.get(squad);
      if (squadStats) {
        squadStats.prsOpened++;
        if (pr.mergedAt) squadStats.prsMerged++;
        if (squadStats.recentPRs.length < 3) {
          squadStats.recentPRs.push({
            title: pr.title,
            number: pr.number,
            merged: !!pr.mergedAt,
          });
        }
      }
    }

    // Process Issues
    for (const issue of issues as { state: string; closedAt?: string; title: string; number: number; labels: { name: string }[] }[]) {
      const squad = detectSquadFromIssue(issue, repo);
      const squadStats = stats.bySquad.get(squad);

      if (issue.state === 'CLOSED') {
        const closed = new Date(issue.closedAt || 0);
        if (closed >= new Date(since)) {
          stats.issuesClosed++;
          if (squadStats) {
            squadStats.issuesClosed++;
          }
        }
      } else {
        stats.issuesOpen++;
        if (squadStats) {
          squadStats.issuesOpen++;
          if (squadStats.recentIssues.length < 3) {
            squadStats.recentIssues.push({
              title: issue.title,
              number: issue.number,
              state: issue.state,
            });
          }
        }
      }
    }
  }

  // Note: commit counts are added separately by the caller using cached git stats
  return stats;
}

function detectSquadFromPR(pr: { title: string; labels: { name: string }[] }, repo: string): string {
  // Check labels first
  for (const label of pr.labels || []) {
    const labelLower = label.name.toLowerCase();
    for (const [squad, patterns] of Object.entries(SQUAD_LABELS)) {
      if (patterns.some(p => labelLower.includes(p))) {
        return squad;
      }
    }
  }

  // Check title
  const titleLower = pr.title.toLowerCase();
  for (const [squad, patterns] of Object.entries(SQUAD_LABELS)) {
    if (patterns.some(p => titleLower.includes(p))) {
      return squad;
    }
  }

  // Default based on repo
  if (repo === 'agents-squads-web') return 'website';
  if (repo === 'squads-cli') return 'product';
  return 'engineering';
}

function detectSquadFromIssue(issue: { title: string; labels: { name: string }[] }, repo: string): string {
  // Check labels first
  for (const label of issue.labels || []) {
    const labelLower = label.name.toLowerCase();

    // Direct squad label match
    if (labelLower.startsWith('squad:')) {
      return labelLower.replace('squad:', '');
    }

    for (const [squad, patterns] of Object.entries(SQUAD_LABELS)) {
      if (patterns.some(p => labelLower.includes(p))) {
        return squad;
      }
    }
  }

  // Check title
  const titleLower = issue.title.toLowerCase();
  for (const [squad, patterns] of Object.entries(SQUAD_LABELS)) {
    if (patterns.some(p => titleLower.includes(p))) {
      return squad;
    }
  }

  // Default based on repo
  if (repo === 'agents-squads-web') return 'website';
  if (repo === 'squads-cli') return 'product';
  return 'engineering';
}

export async function getMultiRepoGitStats(basePath: string, days: number = 30): Promise<GitPerformanceStats> {
  const stats: GitPerformanceStats = {
    totalCommits: 0,
    commitsByDay: new Map(),
    commitsByAuthor: new Map(),
    commitsByRepo: new Map(),
    activeDays: 0,
    avgCommitsPerDay: 0,
    peakDay: null,
    repos: [],
    recentCommits: [],
  };

  // Collect all commits with full info for sorting
  const allCommits: CommitInfo[] = [];

  // Build list of valid repo sources
  const repoSources: Array<{ name: string; path: string }> = [];

  // Check SQUAD_REPOS subdirectories
  for (const repo of SQUAD_REPOS) {
    const repoPath = join(basePath, repo);
    if (existsSync(repoPath) && existsSync(join(repoPath, '.git'))) {
      repoSources.push({ name: repo, path: repoPath });
    }
  }

  // Also check basePath itself (for single-project users where cwd IS the project)
  if (existsSync(join(basePath, '.git')) && !repoSources.some(s => s.path === basePath)) {
    repoSources.push({ name: basename(basePath), path: basePath });
  }

  // Fetch git logs from all repos in parallel
  const repoResults = await Promise.all(
    repoSources.map(async ({ name: repo, path: repoPath }) => {
      try {
        const { stdout } = await execAsync(
          `git log --since="${days} days ago" --format="%H|%aN|%ad|%s" --date=short 2>/dev/null`,
          { cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        );
        return { repo, repoPath, output: stdout.trim() };
      } catch {
        return { repo, repoPath, output: '' };
      }
    })
  );

  // Process results
  for (const { repo, repoPath, output } of repoResults) {
    if (!output) continue;

    const commits = output.split('\n').filter(l => l.trim());
    const authors = new Set<string>();
    let lastCommit = '';

    for (const line of commits) {
      const parts = line.split('|');
      const [hash, author, date, ...messageParts] = parts;
      const message = messageParts.join('|'); // Handle | in commit messages
      if (!hash) continue;

      stats.totalCommits++;
      authors.add(author);
      if (!lastCommit) lastCommit = date;

      // By day
      const dayCount = stats.commitsByDay.get(date) || 0;
      stats.commitsByDay.set(date, dayCount + 1);

      // By author
      const authorCount = stats.commitsByAuthor.get(author) || 0;
      stats.commitsByAuthor.set(author, authorCount + 1);

      // By repo
      const repoCount = stats.commitsByRepo.get(repo) || 0;
      stats.commitsByRepo.set(repo, repoCount + 1);

      // Collect for recent commits
      allCommits.push({ hash, author, date, message, repo });
    }

    stats.repos.push({
      name: repo,
      path: repoPath,
      commits: commits.length,
      lastCommit,
      authors: Array.from(authors),
    });
  }

  // Calculate derived stats
  stats.activeDays = stats.commitsByDay.size;
  stats.avgCommitsPerDay = stats.activeDays > 0
    ? Math.round((stats.totalCommits / days) * 10) / 10
    : 0;

  // Find peak day
  let peakCount = 0;
  let peakDate = '';
  for (const [date, count] of stats.commitsByDay) {
    if (count > peakCount) {
      peakCount = count;
      peakDate = date;
    }
  }
  if (peakDate) {
    stats.peakDay = { date: peakDate, count: peakCount };
  }

  // Sort commits by date (most recent first) and take top 5
  stats.recentCommits = allCommits
    .sort((a, b) => b.date.localeCompare(a.date) || b.hash.localeCompare(a.hash))
    .slice(0, 5);

  return stats;
}

export interface MilestoneInfo {
  repo: string;
  title: string;
  openIssues: number;
  closedIssues: number;
  totalIssues: number;
  percent: number;
  dueOn: string | null;
}

export interface OpenPR {
  repo: string;
  number: number;
  title: string;
  base: string;
  /** ISO date the PR was opened — a bare title says nothing about staleness. */
  createdAt: string | null;
  /** Rollup of CI check runs: pass | fail | pending; null = no checks. */
  ci: 'pass' | 'fail' | 'pending' | null;
}

export interface OperationalStatus {
  milestones: MilestoneInfo[];
  openPRs: OpenPR[];
  error: string | null;
}

/**
 * Fetch operational status: milestones + open PRs across repos.
 * Repos are discovered from squad definitions (SQUAD.md `repo` field).
 * Uses gh CLI — gracefully returns empty if gh is unavailable.
 * Fetches all repos in parallel for performance.
 *
 * @param repos - Array of "owner/repo" strings (e.g., ["agents-squads/squads-cli"])
 */
export async function fetchOperationalStatus(repos: string[]): Promise<OperationalStatus> {
  const result: OperationalStatus = { milestones: [], openPRs: [], error: null };

  if (repos.length === 0) {
    return result;
  }

  try {
    execSync('gh auth status 2>/dev/null', { stdio: 'pipe', timeout: 3000 });
  } catch {
    result.error = 'gh not authenticated';
    return result;
  }

  // Fetch all repos in parallel
  const repoResults = await Promise.all(
    repos.map(async (fullRepo) => {
      const repoShort = fullRepo.split('/').pop() || fullRepo;
      const milestones: OperationalStatus['milestones'] = [];
      const openPRs: OperationalStatus['openPRs'] = [];

      // Fetch milestones and PRs concurrently per repo
      const [msResult, prResult] = await Promise.allSettled([
        execAsync(
          `gh api "repos/${fullRepo}/milestones?state=open" --jq '.[] | [.title, .open_issues, .closed_issues, .due_on] | @tsv' 2>/dev/null`,
          { encoding: 'utf-8', timeout: 8000 }
        ),
        execAsync(
          `gh pr list --repo "${fullRepo}" --state open --json number,title,baseRefName,createdAt,statusCheckRollup 2>/dev/null`,
          { encoding: 'utf-8', timeout: 8000 }
        ),
      ]);

      if (msResult.status === 'fulfilled') {
        for (const line of msResult.value.stdout.trim().split('\n').filter(l => l.trim())) {
          const [title, open, closed, dueOn] = line.split('\t');
          const openIssues = parseInt(open) || 0;
          const closedIssues = parseInt(closed) || 0;
          const totalIssues = openIssues + closedIssues;
          milestones.push({
            repo: repoShort,
            title,
            openIssues,
            closedIssues,
            totalIssues,
            percent: totalIssues > 0 ? Math.floor((closedIssues / totalIssues) * 100) : 0,
            dueOn: dueOn && dueOn !== 'null' ? dueOn : null,
          });
        }
      }

      if (prResult.status === 'fulfilled') {
        try {
          const prs = JSON.parse(prResult.value.stdout.trim() || '[]') as Array<{
            number: number;
            title: string;
            baseRefName: string;
            createdAt: string;
            statusCheckRollup: Array<{ conclusion?: string | null; status?: string | null }> | null;
          }>;
          for (const pr of prs) {
            const checks = pr.statusCheckRollup ?? [];
            const ci: OpenPR['ci'] = checks.length === 0
              ? null
              : checks.some(c => c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT')
                ? 'fail'
                : checks.every(c => c.conclusion === 'SUCCESS' || c.conclusion === 'SKIPPED' || c.conclusion === 'NEUTRAL')
                  ? 'pass'
                  : 'pending';
            openPRs.push({
              repo: repoShort,
              number: pr.number,
              title: pr.title,
              base: pr.baseRefName,
              createdAt: pr.createdAt ?? null,
              ci,
            });
          }
        } catch { /* malformed gh output — leave this repo's PRs empty */ }
      }

      return { milestones, openPRs };
    })
  );

  for (const { milestones, openPRs } of repoResults) {
    result.milestones.push(...milestones);
    result.openPRs.push(...openPRs);
  }

  return result;
}

// Get recent activity sparkline data (last 7 days)
export async function getActivitySparkline(basePath: string, days: number = 7): Promise<number[]> {
  const activity: number[] = [];
  const now = new Date();

  // Initialize activity array with zeros for each day
  for (let i = days - 1; i >= 0; i--) {
    activity.push(0);
  }

  // Build list of valid repo sources
  const sparklineRepos: Array<string> = [];
  for (const repo of SQUAD_REPOS) {
    const repoPath = join(basePath, repo);
    if (existsSync(repoPath) && existsSync(join(repoPath, '.git'))) {
      sparklineRepos.push(repoPath);
    }
  }
  // Also check basePath itself (for single-project users where cwd IS the project)
  if (existsSync(join(basePath, '.git')) && !sparklineRepos.includes(basePath)) {
    sparklineRepos.push(basePath);
  }

  // Fetch git logs from all repos in parallel
  const results = await Promise.all(
    sparklineRepos.map(async (repoPath) => {
      try {
        const { stdout } = await execAsync(
          `git log --since="${days} days ago" --format="%ad" --date=short 2>/dev/null`,
          { cwd: repoPath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
        );
        return stdout.trim();
      } catch {
        return '';
      }
    })
  );

  // Process results
  for (const output of results) {
    if (!output) continue;

    for (const dateStr of output.split('\n')) {
      const commitDate = new Date(dateStr);
      const daysAgo = Math.floor((now.getTime() - commitDate.getTime()) / (1000 * 60 * 60 * 24));
      const index = days - 1 - daysAgo;
      if (index >= 0 && index < days) {
        activity[index]++;
      }
    }
  }

  return activity;
}
