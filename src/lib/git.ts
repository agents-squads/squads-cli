import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

export interface GitStatus {
  isGitRepo: boolean;
  hasRemote: boolean;
  remoteName?: string;
  remoteUrl?: string;
  branch?: string;
  isDirty: boolean;
  uncommittedCount: number;
}

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
    // Get current branch
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    status.branch = branch;

    // Check for remote
    const remotes = execSync('git remote -v', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    if (remotes) {
      status.hasRemote = true;
      const lines = remotes.split('\n');
      if (lines.length > 0) {
        const parts = lines[0].split(/\s+/);
        status.remoteName = parts[0];
        status.remoteUrl = parts[1];
      }
    }

    // Check for uncommitted changes
    const statusOutput = execSync('git status --porcelain', {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

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

export function getGitHubStats(basePath: string, days: number = 30): GitHubStats {
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
  const gitStats = getMultiRepoGitStats(basePath, days);
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

export function getMultiRepoGitStats(basePath: string, days: number = 30): GitPerformanceStats {
  const stats: GitPerformanceStats = {
    totalCommits: 0,
    commitsByDay: new Map(),
    commitsByAuthor: new Map(),
    commitsByRepo: new Map(),
    activeDays: 0,
    avgCommitsPerDay: 0,
    peakDay: null,
    repos: [],
  };

  for (const repo of SQUAD_REPOS) {
    const repoPath = join(basePath, repo);
    if (!existsSync(repoPath) || !existsSync(join(repoPath, '.git'))) {
      continue;
    }

    try {
      // Get commits from this repo
      const logOutput = execSync(
        `git log --since="${days} days ago" --format="%H|%an|%ad|%s" --date=short 2>/dev/null`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (!logOutput) continue;

      const commits = logOutput.split('\n').filter(l => l.trim());
      const authors = new Set<string>();
      let lastCommit = '';

      for (const line of commits) {
        const [hash, author, date, message] = line.split('|');
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
      }

      stats.repos.push({
        name: repo,
        path: repoPath,
        commits: commits.length,
        lastCommit,
        authors: Array.from(authors),
      });

    } catch {
      // Skip repos that fail
    }
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

  return stats;
}

// Get recent activity sparkline data (last 7 days)
export function getActivitySparkline(basePath: string, days: number = 7): number[] {
  const activity: number[] = [];
  const now = new Date();

  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    activity.push(0);
  }

  for (const repo of SQUAD_REPOS) {
    const repoPath = join(basePath, repo);
    if (!existsSync(repoPath) || !existsSync(join(repoPath, '.git'))) {
      continue;
    }

    try {
      const logOutput = execSync(
        `git log --since="${days} days ago" --format="%ad" --date=short 2>/dev/null`,
        { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      if (!logOutput) continue;

      for (const dateStr of logOutput.split('\n')) {
        const commitDate = new Date(dateStr);
        const daysAgo = Math.floor((now.getTime() - commitDate.getTime()) / (1000 * 60 * 60 * 24));
        const index = days - 1 - daysAgo;
        if (index >= 0 && index < days) {
          activity[index]++;
        }
      }
    } catch {
      // Skip
    }
  }

  return activity;
}
