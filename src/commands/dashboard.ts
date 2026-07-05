import { readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { findSquadsDir, listSquads, loadSquad, Goal, hasLocalInfraConfig } from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { fetchCostSummary, fetchInsights, Insights, fetchBridgeStats, BridgeStats, CostSummary, isMaxPlan, getPlanType, fetchNpmStats, NpmStats, fetchQuotaInfo, QuotaInfo, fetchClaudeCodeCapacity, ClaudeCodeCapacity, calculateROIMetrics, calculateSquadCostProjections, ROIMetrics, SquadCostProjection } from '../lib/costs.js';
import { getMultiRepoGitStats, getActivitySparkline, getGitHubStatsOptimized, SquadGitHubStats, GitPerformanceStats, GitHubStats } from '../lib/git.js';
import { saveDashboardSnapshot, isDatabaseAvailable, getDashboardHistory, DashboardSnapshot, SquadSnapshotData, closeDatabase, getLatestBaseline, BaselineSnapshot } from '../lib/db.js';
import { getLiveSessionSummaryAsync, cleanupStaleSessions, SessionSummary } from '../lib/sessions.js';
import { checkForUpdate } from '../lib/update.js';
import { track, Events } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  progressBar,
  box,
  padEnd,
  truncate,
  icons,
  writeLine,
  sparkline,
  barChart,
} from '../lib/terminal.js';

interface SquadMetrics {
  name: string;
  mission: string;
  goals: Goal[];
  lastActivity: string;
  status: 'active' | 'stale' | 'needs-goal' | 'paused';
  github: SquadGitHubStats | null;
  goalProgress: number; // 0-100
  pausedSince?: string;
  pausedReason?: string;
}

function getLastActivityDate(squadName: string): string {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return 'unknown';

  const squadMemory = join(memoryDir, squadName);
  if (!existsSync(squadMemory)) return '—';

  let latestTime = 0;

  try {
    const agents = readdirSync(squadMemory, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const agent of agents) {
      const agentPath = join(squadMemory, agent.name);
      const files = readdirSync(agentPath).filter(f => f.endsWith('.md'));

      for (const file of files) {
        const filePath = join(agentPath, file);
        const stats = statSync(filePath);
        if (stats.mtimeMs > latestTime) {
          latestTime = stats.mtimeMs;
        }
      }
    }
  } catch {
    return '—';
  }

  if (latestTime === 0) return '—';

  const ageMs = Date.now() - latestTime;
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  if (ageDays === 0) return 'today';
  if (ageDays === 1) return '1d';
  if (ageDays < 7) return `${ageDays}d`;
  return `${Math.floor(ageDays / 7)}w`;
}

// Cache for expensive computations within a single run
interface DashboardCache {
  gitStats: GitPerformanceStats | null;
  ghStats: GitHubStats | null;
  costs: CostSummary | null;
  bridgeStats: BridgeStats | null;
  activity: number[];
  dbAvailable: boolean;
  history: DashboardSnapshot[];
  insights: Insights | null;
  sessionSummary: SessionSummary;
  npmStats: NpmStats | null;
  quotaInfo: QuotaInfo | null;
  capacity: ClaudeCodeCapacity | null;
  baseline: BaselineSnapshot | null;
  roiMetrics: ROIMetrics | null;
  squadProjections: SquadCostProjection[];
}

// Dashboard stats aggregated from squad data
interface DashboardStats {
  activeSquads: number;
  totalSquads: number;
  totalPRs: number;
  totalIssuesClosed: number;
  totalIssuesOpen: number;
  overallProgress: number;
}

/**
 * Build squad metrics from squad data and git/github stats
 */
function collectSquadMetrics(
  squadNames: string[],
  gitStats: GitPerformanceStats | null,
  ghStats: GitHubStats | null
): SquadMetrics[] {
  const squadData: SquadMetrics[] = [];

  // Map repos to squads for commit attribution
  const repoSquadMap: Record<string, string[]> = {
    website: ['agents-squads-web'],
    product: ['squads-cli'],
    engineering: ['hq', 'squads-cli'],
    research: ['research'],
    intelligence: ['intelligence'],
    customer: ['customer'],
    finance: ['finance'],
    company: ['company', 'hq'],
    marketing: ['marketing', 'agents-squads-web'],
    cli: ['squads-cli'],
  };

  for (const name of squadNames) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const lastActivity = getLastActivityDate(name);
    const github = ghStats?.bySquad.get(name) || null;

    let status: SquadMetrics['status'] = 'active';
    const activeGoals = squad.goals.filter(g => !g.completed);
    if (squad.status === 'paused') {
      status = 'paused';
    } else if (activeGoals.length === 0) {
      status = 'needs-goal';
    } else if (lastActivity.includes('w') || lastActivity === '—') {
      status = 'stale';
    }

    const totalGoals = squad.goals.length;
    const completedGoals = squad.goals.filter(g => g.completed).length;
    const hasProgress = squad.goals.filter(g => g.progress).length;
    const goalProgress = totalGoals > 0
      ? Math.round(((completedGoals + hasProgress * 0.3) / totalGoals) * 100)
      : 0;

    // Calculate commit counts from git stats
    let squadCommits = 0;
    if (gitStats) {
      for (const [repo, commits] of gitStats.commitsByRepo) {
        if (repoSquadMap[name]?.includes(repo)) {
          squadCommits += commits;
        }
      }
    }

    // Create github stats object (from ghStats or minimal with just commits)
    const githubStats: SquadGitHubStats = github || {
      prsOpened: 0,
      prsMerged: 0,
      issuesClosed: 0,
      issuesOpen: 0,
      commits: 0,
      recentIssues: [],
      recentPRs: [],
    };
    githubStats.commits = squadCommits;

    squadData.push({
      name,
      mission: squad.mission,
      goals: squad.goals,
      lastActivity,
      status,
      github: githubStats,
      goalProgress,
      pausedSince: squad.paused_since,
      pausedReason: squad.paused_reason,
    });
  }

  return squadData;
}

/**
 * Calculate aggregated dashboard stats from squad metrics
 */
function calculateDashboardStats(squadData: SquadMetrics[], ghStats: GitHubStats | null): DashboardStats {
  const activeSquads = squadData.filter(s => s.status === 'active').length;
  const totalPRs = ghStats ? ghStats.prsMerged : 0;
  const totalIssuesClosed = ghStats ? ghStats.issuesClosed : 0;
  const totalIssuesOpen = ghStats ? ghStats.issuesOpen : 0;
  const overallProgress = squadData.length > 0
    ? Math.round(squadData.reduce((sum, s) => sum + s.goalProgress, 0) / squadData.length)
    : 0;

  return {
    activeSquads,
    totalSquads: squadData.length,
    totalPRs,
    totalIssuesClosed,
    totalIssuesOpen,
    overallProgress,
  };
}

/**
 * Render the dashboard header with session and stats info
 */
function renderDashboardHeader(
  stats: DashboardStats,
  sessionSummary: SessionSummary,
  gitStats: GitPerformanceStats | null,
  ghStats: GitHubStats | null
): void {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}dashboard${RESET}`);

  // Check for updates (cached, non-blocking)
  const updateInfo = checkForUpdate();
  if (updateInfo.updateAvailable) {
    writeLine(`  ${colors.cyan}⬆${RESET} Update available: ${colors.dim}${updateInfo.currentVersion}${RESET} → ${colors.green}${updateInfo.latestVersion}${RESET} ${colors.dim}(run \`squads update\`)${RESET}`);
  }

  // Session indicator line (only if there are active sessions)
  if (sessionSummary.totalSessions > 0) {
    const sessionText = sessionSummary.totalSessions === 1 ? 'session' : 'sessions';
    const squadText = sessionSummary.squadCount === 1 ? 'squad' : 'squads';

    // Build tool breakdown string (e.g., "claude 4, cursor 2")
    let toolInfo = '';
    if (sessionSummary.byTool && Object.keys(sessionSummary.byTool).length > 0) {
      const toolParts = Object.entries(sessionSummary.byTool)
        .sort((a, b) => b[1] - a[1]) // Sort by count descending
        .map(([tool, count]) => `${colors.dim}${tool}${RESET} ${colors.cyan}${count}${RESET}`);
      toolInfo = ` ${colors.dim}(${RESET}${toolParts.join(` ${colors.dim}·${RESET} `)}${colors.dim})${RESET}`;
    }

    writeLine(`  ${colors.green}${icons.active}${RESET} ${colors.white}${sessionSummary.totalSessions}${RESET} active ${sessionText} ${colors.dim}across${RESET} ${colors.cyan}${sessionSummary.squadCount}${RESET} ${squadText}${toolInfo}`);
  }
  writeLine();

  // Stats row - show different info based on whether GitHub data is available
  const statsParts = [`${colors.cyan}${stats.activeSquads}${RESET}/${stats.totalSquads} squads`];
  if (ghStats) {
    statsParts.push(`${colors.green}${stats.totalPRs}${RESET} PRs merged`);
    statsParts.push(`${colors.purple}${stats.totalIssuesClosed}${RESET} closed`);
    statsParts.push(`${colors.yellow}${stats.totalIssuesOpen}${RESET} open`);
  } else {
    statsParts.push(`${colors.cyan}${gitStats?.totalCommits || 0}${RESET} commits`);
    statsParts.push(`${colors.dim}use -f for PRs/issues${RESET}`);
  }
  writeLine(`  ${statsParts.join(`  ${colors.dim}│${RESET}  `)}`);
  writeLine();

  writeLine(`  ${progressBar(stats.overallProgress, 32)} ${colors.dim}${stats.overallProgress}% goal progress${RESET}`);
  writeLine();
}

/**
 * Render the squads table showing activity per squad
 */
function renderSquadsTable(squadData: SquadMetrics[]): void {
  // Squad table - add 2 chars padding to each column for spacing
  const w = { name: 13, commits: 9, prs: 5, issues: 8, goals: 7, bar: 10 };
  const tableWidth = w.name + w.commits + w.prs + w.issues + w.goals + w.bar + 6;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
    `${bold}${padEnd('COMMITS', w.commits)}${RESET}` +
    `${bold}${padEnd('PRs', w.prs)}${RESET}` +
    `${bold}${padEnd('ISSUES', w.issues)}${RESET}` +
    `${bold}${padEnd('GOALS', w.goals)}${RESET}` +
    `${bold}PROGRESS${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  const sortedSquads = [...squadData].sort((a, b) => {
    const aActivity = (a.github?.commits || 0) + (a.github?.prsMerged || 0) * 5;
    const bActivity = (b.github?.commits || 0) + (b.github?.prsMerged || 0) * 5;
    return bActivity - aActivity;
  });

  for (const squad of sortedSquads) {
    const gh = squad.github;
    const commits = gh?.commits || 0;
    const prs = gh?.prsMerged || 0;
    const issuesClosed = gh?.issuesClosed || 0;
    const issuesOpen = gh?.issuesOpen || 0;
    const completedCount = squad.goals.filter(g => g.completed).length;
    const totalCount = squad.goals.length;

    const isPaused = squad.status === 'paused';
    const nameColor = isPaused ? colors.yellow : colors.cyan;
    const commitColor = commits > 10 ? colors.green : commits > 0 ? colors.cyan : colors.dim;
    const prColor = prs > 0 ? colors.green : colors.dim;
    const issueColor = issuesClosed > 0 ? colors.green : colors.dim;

    const pausedSuffix = isPaused ? `${colors.yellow}⏸${RESET}` : '';
    const nameField = isPaused
      ? `${nameColor}${padEnd(squad.name, w.name - 1)}${RESET}${pausedSuffix}`
      : `${nameColor}${padEnd(squad.name, w.name)}${RESET}`;

    writeLine(`  ${colors.purple}${box.vertical}${RESET} ` +
      nameField +
      `${commitColor}${padEnd(String(commits), w.commits)}${RESET}` +
      `${prColor}${padEnd(String(prs), w.prs)}${RESET}` +
      `${issueColor}${padEnd(`${issuesClosed}/${issuesOpen}`, w.issues)}${RESET}` +
      `${padEnd(`${completedCount}/${totalCount}`, w.goals)}` +
      `${progressBar(squad.goalProgress, 8)}` +
      ` ${colors.purple}${box.vertical}${RESET}`);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();
}

/**
 * Render the working on section showing recent commits
 */
function renderWorkingOn(gitStats: GitPerformanceStats | null): void {
  if (gitStats && gitStats.recentCommits && gitStats.recentCommits.length > 0) {
    writeLine(`  ${bold}Working On${RESET}`);
    writeLine();

    for (const commit of gitStats.recentCommits.slice(0, 3)) {
      const shortHash = commit.hash.slice(0, 7);
      const shortMsg = truncate(commit.message, 45);
      writeLine(`  ${colors.dim}${shortHash}${RESET} ${shortMsg} ${colors.dim}(${commit.repo})${RESET}`);
    }
    writeLine();
  }
}

/**
 * Render the goals section sorted from tactical to strategic
 */
function renderGoalsSection(squadData: SquadMetrics[]): void {
  const allActiveGoals = squadData.flatMap(s =>
    s.goals.filter(g => !g.completed).map(g => ({
      squad: s.name,
      goal: g,
      scope: inferScope(g.description)
    }))
  );

  if (allActiveGoals.length > 0) {
    // Sort goals: tactical first (actionable NOW) → operational → strategic (vision)
    const scopeOrder = { tactical: 0, operational: 1, strategic: 2 };
    const sortedGoals = [...allActiveGoals].sort((a, b) => {
      // Primary: scope (tactical first)
      const scopeDiff = scopeOrder[a.scope] - scopeOrder[b.scope];
      if (scopeDiff !== 0) return scopeDiff;
      // Secondary: goals with progress first (being worked on)
      const aHasProgress = a.goal.progress ? 1 : 0;
      const bHasProgress = b.goal.progress ? 1 : 0;
      return bHasProgress - aHasProgress;
    });

    // Group labels for display
    const scopeLabels = { tactical: 'Next', operational: 'In Progress', strategic: 'Vision' };
    const scopeIcons = { tactical: icons.active, operational: icons.progress, strategic: icons.empty };

    writeLine(`  ${bold}Goals${RESET} ${colors.dim}(tactical → strategic)${RESET}`);
    writeLine();

    const maxGoals = 5; // Show more goals since they're now meaningfully ordered
    let lastScope = '';
    for (const { squad, goal, scope } of sortedGoals.slice(0, maxGoals)) {
      // Show scope header when it changes
      if (scope !== lastScope) {
        const label = scopeLabels[scope];
        const labelColor = scope === 'tactical' ? colors.green : scope === 'strategic' ? colors.purple : colors.cyan;
        writeLine(`  ${labelColor}${label}${RESET}`);
        lastScope = scope;
      }
      const hasProgress = goal.progress && goal.progress.length > 0;
      const icon = scopeIcons[scope];
      writeLine(`  ${icon} ${colors.dim}${squad}${RESET} ${truncate(goal.description, 48)}`);
      if (hasProgress) {
        writeLine(`    ${colors.dim}└${RESET} ${colors.green}${truncate(goal.progress!, 52)}${RESET}`);
      }
    }

    if (allActiveGoals.length > maxGoals) {
      writeLine(`  ${colors.dim}  +${allActiveGoals.length - maxGoals} more${RESET}`);
    }
    writeLine();
  }
}

/**
 * Render the footer with command hints
 */
function renderDashboardFooter(): void {
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}<squad>${RESET}    ${colors.dim}Execute a squad${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads goal set    ${colors.dim}Add a goal${RESET}`);
  writeLine();
}

export async function dashboardCommand(options: { verbose?: boolean; ceo?: boolean; fast?: boolean; json?: boolean } = {}): Promise<void> {
  await track(Events.CLI_DASHBOARD, { verbose: options.verbose, ceo: options.ceo, fast: options.fast });
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`${colors.dim}Run \`squads init\` to create one.${RESET}`);
    return;
  }

  // CEO mode: executive summary
  if (options.ceo) {
    await renderCeoReport(squadsDir);
    return;
  }

  const baseDir = findAgentsSquadsDir();
  const squadNames = listSquads(squadsDir);
  const skipGitHub = options.fast !== false; // Default to fast mode (skip GitHub API)

  // === PHASE 1: Parallel data fetching ===
  const cache = await fetchDashboardData(baseDir, skipGitHub);

  // === PHASE 2: Build squad metrics ===
  const squadData = collectSquadMetrics(squadNames, cache.gitStats, cache.ghStats);

  // === PHASE 3: Calculate stats and render ===
  const stats = calculateDashboardStats(squadData, cache.ghStats);

  // JSON output
  if (options.json) {
    const goalCount = {
      active: squadData.reduce((sum, s) => sum + s.goals.filter(g => !g.completed).length, 0),
      completed: squadData.reduce((sum, s) => sum + s.goals.filter(g => g.completed).length, 0),
    };
    console.log(JSON.stringify({
      ok: true,
      command: 'dash',
      data: {
        squads: squadData.map(s => ({
          name: s.name, mission: s.mission, status: s.status,
          goalProgress: s.goalProgress, lastActivity: s.lastActivity,
          goals: s.goals,
        })),
        stats,
        goals: goalCount,
        sessions: cache.sessionSummary,
        costs: cache.costs,
        gitStats: cache.gitStats ? {
          totalCommits: cache.gitStats.totalCommits,
          repos: cache.gitStats.repos?.map(r => ({ name: r.name, commits: r.commits })),
        } : null,
      },
    }, null, 2));
    await closeDatabase();
    return;
  }

  // Render dashboard sections
  renderDashboardHeader(stats, cache.sessionSummary, cache.gitStats, cache.ghStats);
  renderSquadsTable(squadData);

  // Compute goal counts for efficiency metrics
  const goalCount = {
    active: squadData.reduce((sum, s) => sum + s.goals.filter(g => !g.completed).length, 0),
    completed: squadData.reduce((sum, s) => sum + s.goals.filter(g => g.completed).length, 0),
  };

  // Render sections using cached data (no more network calls)
  renderGitPerformanceCached(cache);
  renderTokenEconomicsCached(cache, goalCount);
  renderROICached(cache, goalCount);
  renderQuotaCached(cache);
  renderCapacityCached(cache);
  renderInfrastructureCached(cache);
  renderAcquisitionCached(cache);
  renderHistoricalTrendsCached(cache);
  renderInsightsCached(cache);
  renderWorkingOn(cache.gitStats);
  renderGoalsSection(squadData);
  renderDashboardFooter();

  // Save snapshot in background (don't block)
  saveSnapshotCached(squadData, cache, baseDir).catch(() => {});

  // Close database pool to allow process to exit immediately
  await closeDatabase();
}

/**
 * Fetch all dashboard data in parallel with timeouts
 */
async function fetchDashboardData(baseDir: string | null, skipGitHub: boolean): Promise<DashboardCache> {
  // Wrap slow calls with race timeout to ensure CLI responsiveness
  const timeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([promise, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

  // Clean up stale file-based sessions (sync, fast)
  cleanupStaleSessions();

  const [gitStats, ghStats, costs, bridgeStats, activity, dbAvailable, history, insights, sessionSummary, npmStats, quotaInfo, capacity, baseline] = await Promise.all([
    // Git stats (local, parallel across repos, 1.5s timeout)
    baseDir ? timeout(getMultiRepoGitStats(baseDir, 30), 1500, null) : Promise.resolve(null),
    // GitHub stats (network, ~20-30s) - skip by default for fast mode
    skipGitHub ? Promise.resolve(null) : Promise.resolve(baseDir ? getGitHubStatsOptimized(baseDir, 30) : null),
    // Langfuse costs (network, 2s timeout)
    timeout(fetchCostSummary(100), 2000, null),
    // Bridge stats (local network, 2s timeout)
    timeout(fetchBridgeStats(), 2000, null),
    // Activity sparkline (local, parallel across repos, 1.5s timeout)
    baseDir ? timeout(getActivitySparkline(baseDir, 14), 1500, [] as number[]) : Promise.resolve([] as number[]),
    // Database availability check (1.5s timeout)
    timeout(isDatabaseAvailable(), 1500, false),
    // Dashboard history (1.5s timeout)
    timeout(getDashboardHistory(14).catch(() => [] as DashboardSnapshot[]), 1500, [] as DashboardSnapshot[]),
    // Insights (2s timeout)
    timeout(fetchInsights('week').catch(() => null), 2000, null),
    // Session summary: lsof per AI process, cap at 1s to stay under 2s total
    timeout(getLiveSessionSummaryAsync(), 1000, { totalSessions: 0, bySquad: {}, squadCount: 0, byTool: {} } as SessionSummary),
    // NPM download stats (network, 2s timeout)
    timeout(fetchNpmStats('squads-cli'), 2000, null),
    // Quota/autonomy info (local network, 2s timeout)
    timeout(fetchQuotaInfo(), 2000, null),
    // Claude Code capacity (local file read, fast)
    fetchClaudeCodeCapacity(),
    // Latest baseline for ROI comparison (1.5s timeout)
    timeout(getLatestBaseline().catch(() => null), 1500, null),
  ]);

  // Calculate ROI metrics
  const roiMetrics = calculateROIMetrics(costs, 0, gitStats?.totalCommits || 0, ghStats?.prsMerged || 0);
  const squadProjections = calculateSquadCostProjections(bridgeStats, null);

  return { gitStats, ghStats, costs, bridgeStats, activity, dbAvailable, history, insights, sessionSummary, npmStats, quotaInfo, capacity, baseline, roiMetrics, squadProjections };
}


// Find agents-squads base directory (project-scoped, not global)
function findAgentsSquadsDir(): string | null {
  // First try: parent of current project (for multi-repo setups)
  const parentDir = join(process.cwd(), '..');
  if (existsSync(join(parentDir, 'hq'))) {
    return parentDir;
  }

  // Second try: current directory IS the project root
  if (existsSync(join(process.cwd(), '.git'))) {
    return process.cwd();
  }

  // Don't fall back to ~/agents-squads - that would show our data to fresh users
  return null;
}


// Format number as K/M
function formatK(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}


// === CACHED RENDER FUNCTIONS (use pre-fetched data) ===

function renderGitPerformanceCached(cache: DashboardCache): void {
  const { gitStats: stats, activity } = cache;

  if (!stats || stats.totalCommits === 0) {
    writeLine(`  ${bold}Git Activity${RESET} ${colors.dim}(no commits in 30d)${RESET}`);
    writeLine();
    return;
  }

  writeLine(`  ${bold}Git Activity${RESET} ${colors.dim}(30d)${RESET}`);
  writeLine();

  // Sparkline for last 14 days
  if (activity.length > 0) {
    const spark = sparkline(activity);
    writeLine(`  ${colors.dim}Last 14d:${RESET} ${spark}`);
    writeLine();
  }

  // Key metrics row
  const metrics = [
    `${colors.cyan}${stats.totalCommits}${RESET} commits`,
    `${colors.green}${stats.avgCommitsPerDay}${RESET}/day`,
    `${colors.purple}${stats.activeDays}${RESET} active days`,
  ];
  if (stats.peakDay) {
    metrics.push(`${colors.yellow}${stats.peakDay.count}${RESET} peak ${colors.dim}(${stats.peakDay.date})${RESET}`);
  }
  writeLine(`  ${metrics.join(`  ${colors.dim}│${RESET}  `)}`);
  writeLine();

  // Repos by commits (top 5)
  const sortedRepos = Array.from(stats.commitsByRepo.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (sortedRepos.length > 0) {
    const maxRepoCommits = sortedRepos[0][1];
    for (const [repo, commits] of sortedRepos) {
      const bar = barChart(commits, maxRepoCommits, 12);
      writeLine(`  ${colors.cyan}${padEnd(repo, 20)}${RESET}${bar} ${colors.dim}${commits}${RESET}`);
    }
    writeLine();
  }

  // Authors (top 3)
  const sortedAuthors = Array.from(stats.commitsByAuthor.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  if (sortedAuthors.length > 0) {
    const authorLine = sortedAuthors
      .map(([author, count]) => `${colors.dim}${truncate(author, 15)}${RESET} ${colors.cyan}${count}${RESET}`)
      .join(`  ${colors.dim}│${RESET}  `);
    writeLine(`  ${colors.dim}By author:${RESET} ${authorLine}`);
    writeLine();
  }
}

function renderTokenEconomicsCached(cache: DashboardCache, goalCount?: { active: number; completed: number }): void {
  const costs = cache.costs;
  const stats = cache.bridgeStats;
  const hasInfra = hasLocalInfraConfig();
  const hasData = costs || stats;

  writeLine(`  ${bold}Token Economics${RESET}`);
  writeLine();

  // === SUBSCRIPTION (always show - works without infra) ===
  const planType = getPlanType();
  const tier = parseInt(process.env.ANTHROPIC_TIER || '0', 10);

  if (planType === 'unknown') {
    // If no API key is set, user is likely on OAuth (Claude Code subscription)
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    if (!hasApiKey) {
      writeLine(`  ${colors.purple}◆${RESET} ${bold}Claude Code${RESET} ${colors.dim}(subscription)${RESET}`);
      writeLine();
    } else {
      writeLine(`  ${colors.dim}○${RESET} ${bold}Plan${RESET} ${colors.dim}not configured${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}Set your Claude plan:${RESET}`);
      writeLine(`  ${colors.dim}$${RESET} export SQUADS_PLAN_TYPE=max   ${colors.dim}# $200/mo flat${RESET}`);
      writeLine(`  ${colors.dim}$${RESET} export SQUADS_PLAN_TYPE=usage ${colors.dim}# pay-per-token${RESET}`);
      writeLine();
    }
  } else {
    const maxPlan = planType === 'max';
    const planIcon = maxPlan ? `${colors.purple}◆${RESET}` : `${colors.dim}○${RESET}`;
    const planLabel = maxPlan ? 'Claude Max' : 'Claude Pro';
    const planCost = maxPlan ? '$200/mo flat' : 'pay-per-token';
    const tierDisplay = tier > 0 ? `  ${colors.dim}Tier ${tier}${RESET}` : '';
    writeLine(`  ${planIcon} ${bold}${planLabel}${RESET} ${colors.dim}${planCost}${RESET}${tierDisplay}`);
    writeLine();
  }

  // === METRICS (require infra) ===
  if (!hasInfra || !hasData) {
    writeLine(`  ${colors.dim}○${RESET} Track costs, tokens, and API usage`);
    writeLine(`  ${colors.dim}○${RESET} Monitor rate limits and budgets`);
    writeLine();
    writeLine(`  ${colors.dim}Setup:${RESET} github.com/agents-squads/squads-cli#analytics`);
    writeLine();
    return;
  }

  // === TOKEN USAGE ===
  const todayTokens = stats ? stats.today.inputTokens + stats.today.outputTokens : 0;
  const todayCalls = stats?.today.generations || costs?.totalCalls || 0;
  const todayCost = stats?.today.costUsd || costs?.totalCost || 0;

  writeLine(`  ${colors.dim}Today${RESET}`);
  writeLine(`  ${colors.cyan}${formatK(todayTokens)}${RESET} tokens  ${colors.dim}│${RESET}  ${colors.cyan}${todayCalls}${RESET} calls  ${colors.dim}│${RESET}  ${colors.green}$${todayCost.toFixed(2)}${RESET}`);

  // Week stats if available
  if (stats?.week && stats.week.generations > 0) {
    const weekTokens = (stats.week.inputTokens || 0) + (stats.week.outputTokens || 0);
    writeLine(`  ${colors.dim}Week${RESET}   ${colors.purple}${formatK(weekTokens)}${RESET} tokens  ${colors.dim}│${RESET}  ${colors.purple}${stats.week.generations}${RESET} calls  ${colors.dim}│${RESET}  ${colors.purple}$${stats.week.costUsd.toFixed(2)}${RESET}`);
  }
  writeLine();

  // === GOAL EFFICIENCY ===
  if (goalCount && goalCount.completed > 0 && todayTokens > 0) {
    const tokensPerGoal = Math.round(todayTokens / goalCount.completed);
    writeLine(`  ${colors.dim}Efficiency${RESET}`);
    writeLine(`  ${colors.cyan}${formatK(tokensPerGoal)}${RESET} tokens/goal  ${colors.dim}│${RESET}  ${colors.green}${goalCount.completed}${RESET} goals done`);
    writeLine();
  }

  // === RATE LIMITS (informational - real limits from Anthropic subscription) ===
  // Limits vary by tier - check /usage for actual subscription limits
  writeLine(`  ${colors.dim}Rate Limits${RESET} ${colors.dim}(check /usage for real limits)${RESET}`);

  // Dynamic tier limits based on configured tier (or estimate from usage patterns)
  const tierLimits: Record<number, { rpm: number; inputTpm: number; outputTpm: number }> = {
    1: { rpm: 50, inputTpm: 30000, outputTpm: 8000 },
    2: { rpm: 1000, inputTpm: 450000, outputTpm: 90000 },
    3: { rpm: 2000, inputTpm: 800000, outputTpm: 160000 },
    4: { rpm: 4000, inputTpm: 2000000, outputTpm: 400000 },
  };
  const limits = tierLimits[tier] || tierLimits[4];

  // Estimate current usage rate (calls per minute based on today's activity)
  const now = new Date();
  const minutesElapsed = Math.max((now.getHours() * 60) + now.getMinutes(), 1);
  const callsPerMinute = todayCalls / minutesElapsed;
  const tokensPerMinute = todayTokens / minutesElapsed;
  const rpmPct = (callsPerMinute / limits.rpm) * 100;
  const tpmPct = (tokensPerMinute / (limits.inputTpm + limits.outputTpm)) * 100;

  // Show rate usage bars
  const rpmBar = progressBar(Math.min(rpmPct, 100), 10);
  const tpmBar = progressBar(Math.min(tpmPct, 100), 10);
  const rpmColor = rpmPct > 75 ? colors.red : rpmPct > 50 ? colors.yellow : colors.green;
  const tpmColor = tpmPct > 75 ? colors.red : tpmPct > 50 ? colors.yellow : colors.green;

  writeLine(`  RPM  ${rpmBar} ${rpmColor}${callsPerMinute.toFixed(1)}${RESET}${colors.dim}/${limits.rpm}${RESET}`);
  writeLine(`  TPM  ${tpmBar} ${tpmColor}${formatK(Math.round(tokensPerMinute))}${RESET}${colors.dim}/${formatK(limits.inputTpm + limits.outputTpm)}${RESET}`);

  // Capacity remaining for autonomous work
  const rpmAvailable = Math.max(0, limits.rpm - callsPerMinute);
  const tpmAvailable = Math.max(0, (limits.inputTpm + limits.outputTpm) - tokensPerMinute);

  if (rpmAvailable > 100 && tpmAvailable > 10000) {
    writeLine(`  ${colors.green}●${RESET} ${colors.dim}Capacity for autonomous triggers${RESET}`);
  } else if (rpmPct > 75 || tpmPct > 75) {
    writeLine(`  ${colors.yellow}⚠${RESET} ${colors.yellow}Rate limits constrained${RESET}`);
  }

  writeLine();
}

function renderQuotaCached(cache: DashboardCache): void {
  const quota = cache.quotaInfo;

  if (!quota || !quota.monthlyQuota || quota.monthlyQuota === 0) {
    // No quota data or invalid quota - skip section
    return;
  }

  // Calculate ROI multiplier (how much value extracted from subscription)
  const monthlyUsed = quota.monthlyUsed || 0;
  const monthlyQuota = quota.monthlyQuota;
  const roiMultiplier = monthlyUsed / monthlyQuota;
  const roiDisplay = roiMultiplier >= 1 ? `${roiMultiplier.toFixed(1)}x` : `${(roiMultiplier * 100).toFixed(0)}%`;

  // High utilization = good (green), low = room to grow (yellow)
  const utilizationColor = roiMultiplier >= 2 ? colors.green : roiMultiplier >= 1 ? colors.cyan : roiMultiplier >= 0.5 ? colors.yellow : colors.dim;
  const roiIcon = roiMultiplier >= 3 ? '🚀' : roiMultiplier >= 2 ? '🎉' : roiMultiplier >= 1 ? '✓' : '';

  writeLine(`  ${bold}Subscription ROI${RESET} ${colors.dim}(autonomy: ${quota.autonomyScore}% ${quota.confidenceLevel})${RESET}`);
  writeLine();

  // ROI bar - fills up and overflows to show value extraction
  const barWidth = 24;
  const fillPct = Math.min(roiMultiplier, 1); // Cap at 100% for the bar
  const filled = Math.round(fillPct * barWidth);
  const overflowIndicator = roiMultiplier > 1 ? `${utilizationColor}+${RESET}` : '';
  const bar = `${utilizationColor}${'█'.repeat(filled)}${colors.dim}${'░'.repeat(barWidth - filled)}${RESET}${overflowIndicator}`;

  writeLine(`  ${bar} ${utilizationColor}${roiDisplay}${RESET} ${roiIcon}`);
  writeLine(`  ${colors.green}$${monthlyUsed.toFixed(2)}${RESET} ${colors.dim}consumed${RESET} ${colors.dim}/${RESET} $${monthlyQuota}${colors.dim}/mo subscription${RESET}`);

  // ROI interpretation
  if (roiMultiplier >= 2) {
    writeLine(`  ${colors.green}Excellent value${RESET} ${colors.dim}- ${roiDisplay} return on $${monthlyQuota} subscription${RESET}`);
  } else if (roiMultiplier >= 1) {
    writeLine(`  ${colors.cyan}Good utilization${RESET} ${colors.dim}- maximizing subscription value${RESET}`);
  } else {
    const potentialValue = monthlyQuota - monthlyUsed;
    writeLine(`  ${colors.yellow}Room to grow${RESET} ${colors.dim}- $${potentialValue.toFixed(0)} of unused capacity${RESET}`);
    writeLine(`  ${colors.dim}Tip: Run more routines with${RESET} ${colors.cyan}squads run <squad>${RESET}`);
  }

  // Learnings count
  if (quota.learningCount > 0) {
    writeLine(`  ${colors.dim}Learnings:${RESET} ${colors.purple}${quota.learningCount}${RESET} ${colors.dim}captured${RESET}`);
  }

  writeLine();
}

function renderCapacityCached(cache: DashboardCache): void {
  const cap = cache.capacity;

  if (!cap) {
    // No capacity data - skip section
    return;
  }

  // Helper to format tokens
  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
    return n.toString();
  };

  writeLine(`  ${bold}Subscription Capacity${RESET} ${colors.dim}(from Claude Code)${RESET}`);
  writeLine();

  // Weekly capacity bar
  const weeklyPct = cap.weeklyCapacityPct;
  const weeklyColor = weeklyPct > 80 ? colors.red : weeklyPct > 60 ? colors.yellow : colors.green;
  const weeklyBarWidth = 20;
  const weeklyFilled = Math.min(Math.round((weeklyPct / 100) * weeklyBarWidth), weeklyBarWidth);
  const weeklyBar = `${weeklyColor}${'█'.repeat(weeklyFilled)}${colors.dim}${'░'.repeat(weeklyBarWidth - weeklyFilled)}${RESET}`;

  writeLine(`  ${colors.dim}Weekly:${RESET}  ${weeklyBar} ${weeklyColor}${weeklyPct}%${RESET} ${colors.dim}(resets ${cap.weeklyResetDate})${RESET}`);
  writeLine(`           ${colors.dim}${formatTokens(cap.weeklyTokensUsed)} / ${formatTokens(cap.weeklyTokensLimit)} tokens${RESET}`);

  // Model breakdown
  const opusPct = cap.weeklyTokensUsed > 0 ? Math.round((cap.opusTokensUsed / cap.weeklyTokensUsed) * 100) : 0;
  const sonnetPct = cap.weeklyTokensUsed > 0 ? Math.round((cap.sonnetTokensUsed / cap.weeklyTokensUsed) * 100) : 0;

  writeLine(`           ${colors.dim}opus${RESET} ${colors.purple}${opusPct}%${RESET}  ${colors.dim}sonnet${RESET} ${colors.cyan}${sonnetPct}%${RESET}`);

  // Session capacity (if significant)
  if (cap.sessionCapacityPct > 10) {
    const sessionPct = cap.sessionCapacityPct;
    const sessionColor = sessionPct > 80 ? colors.red : sessionPct > 60 ? colors.yellow : colors.green;
    writeLine(`  ${colors.dim}Session:${RESET} ${sessionColor}${sessionPct}%${RESET} ${colors.dim}(resets ${cap.sessionResetTime})${RESET}`);
  }

  // Capacity interpretation
  const headroom = 100 - weeklyPct;
  if (headroom > 50) {
    writeLine(`  ${colors.green}●${RESET} ${colors.dim}${headroom}% headroom for autonomous agents${RESET}`);
  } else if (headroom > 20) {
    writeLine(`  ${colors.yellow}●${RESET} ${colors.dim}${headroom}% remaining - monitor usage${RESET}`);
  } else {
    writeLine(`  ${colors.red}●${RESET} ${colors.dim}Low capacity - consider Sonnet for routine tasks${RESET}`);
  }

  writeLine();
}

function renderInfrastructureCached(cache: DashboardCache): void {
  const stats = cache.bridgeStats;
  const hasInfra = hasLocalInfraConfig();

  if (!hasInfra || !stats) {
    writeLine(`  ${bold}Infrastructure${RESET} ${colors.dim}(local only)${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Running locally — no cloud connection needed to get started.${RESET}`);
    writeLine(`  ${colors.dim}Optional: connect for remote execution and team sharing.${RESET}`);
    writeLine();
    return;
  }

  writeLine(`  ${bold}Infrastructure${RESET} ${colors.dim}(${stats.source})${RESET}`);
  writeLine();

  // Health status row
  const pgStatus = stats.health.postgres === 'connected' ? `${colors.green}●${RESET}` : `${colors.red}●${RESET}`;
  const redisStatus = stats.health.redis === 'connected' ? `${colors.green}●${RESET}` : stats.health.redis === 'disabled' ? `${colors.dim}○${RESET}` : `${colors.red}●${RESET}`;
  // OTel pipeline is working if we have data flowing (postgres connected + generations > 0)
  const otelWorking = stats.health.postgres === 'connected' && stats.today.generations > 0;
  const otelStatus = otelWorking ? `${colors.green}●${RESET}` : `${colors.dim}○${RESET}`;

  writeLine(`  ${pgStatus} postgres  ${redisStatus} redis  ${otelStatus} otel`);
  writeLine();

  // Today's real-time metrics
  if (stats.today.generations > 0 || stats.today.costUsd > 0) {
    // On Max plan, cost is informational only (green). On usage plan, color by budget usage.
    const maxPlan = isMaxPlan();
    const costColor = maxPlan ? colors.green : (stats.budget.usedPct > 80 ? colors.red : stats.budget.usedPct > 50 ? colors.yellow : colors.green);
    const costDisplay = maxPlan
      ? `${costColor}$${stats.today.costUsd.toFixed(2)}${RESET}`
      : `${costColor}$${stats.today.costUsd.toFixed(2)}${RESET}${colors.dim}/$${stats.budget.daily}${RESET}`;
    writeLine(`  ${colors.dim}Today:${RESET} ${colors.cyan}${stats.today.generations}${RESET}${colors.dim} calls${RESET}  ${costDisplay}  ${colors.dim}${formatK(stats.today.inputTokens)}+${formatK(stats.today.outputTokens)} tokens${RESET}`);

    // Model breakdown
    if (stats.byModel && stats.byModel.length > 0) {
      const modelLine = stats.byModel.map(m => {
        const shortName = m.model.includes('opus') ? 'opus' :
                          m.model.includes('sonnet') ? 'sonnet' :
                          m.model.includes('haiku') ? 'haiku' : m.model.slice(0, 10);
        return `${colors.dim}${shortName}${RESET} ${colors.cyan}${m.generations}${RESET}`;
      }).join('  ');
      writeLine(`  ${colors.dim}Models:${RESET} ${modelLine}`);
    }
  }

  // Week totals
  if (stats.week && stats.week.generations > 0) {
    const weekModelLine = stats.week.byModel?.map(m => {
      const shortName = m.model.includes('opus') ? 'opus' :
                        m.model.includes('sonnet') ? 'sonnet' :
                        m.model.includes('haiku') ? 'haiku' : m.model.slice(0, 10);
      return `${colors.dim}${shortName}${RESET} ${colors.purple}$${m.costUsd.toFixed(0)}${RESET}`;
    }).join('  ') || '';
    writeLine(`  ${colors.dim}Week:${RESET}  ${colors.cyan}${stats.week.generations}${RESET}${colors.dim} calls${RESET}  ${colors.purple}$${stats.week.costUsd.toFixed(2)}${RESET}  ${weekModelLine}`);
  }

  writeLine();
}

function renderAcquisitionCached(cache: DashboardCache): void {
  // Only show Acquisition for squads-cli project (internal metrics)
  // Check if SQUADS_NPM_PACKAGE is set or if we're in the squads-cli repo
  const npmPackage = process.env.SQUADS_NPM_PACKAGE;
  if (!npmPackage) {
    // Not configured - don't show internal acquisition metrics to fresh users
    return;
  }

  const npm = cache.npmStats;
  if (!npm) {
    // Don't show section if npm API failed
    return;
  }

  writeLine(`  ${bold}Acquisition${RESET} ${colors.dim}(npm)${RESET}`);
  writeLine();

  // Download stats
  const trendIcon = npm.weekOverWeek >= 0 ? `${colors.green}↑${RESET}` : `${colors.red}↓${RESET}`;
  const trendColor = npm.weekOverWeek >= 0 ? colors.green : colors.red;

  writeLine(`  ${colors.cyan}${npm.downloads.lastWeek}${RESET} installs/week  ${trendIcon} ${trendColor}${Math.abs(npm.weekOverWeek)}%${RESET} ${colors.dim}wow${RESET}`);
  writeLine(`  ${colors.dim}Today${RESET} ${npm.downloads.lastDay}  ${colors.dim}│${RESET}  ${colors.dim}Month${RESET} ${npm.downloads.lastMonth}`);

  writeLine();
}

async function saveSnapshotCached(
  squadData: SquadMetrics[],
  cache: DashboardCache,
  _baseDir: string | null
): Promise<void> {
  // Use cached dbAvailable check - don't make another slow connection attempt
  if (!cache.dbAvailable) return;

  const { gitStats, ghStats, costs } = cache;

  // Build squad snapshot data
  const squadsData: SquadSnapshotData[] = squadData.map(s => ({
    name: s.name,
    commits: s.github?.commits || 0,
    prsOpened: s.github?.prsOpened || 0,
    prsMerged: s.github?.prsMerged || 0,
    issuesClosed: s.github?.issuesClosed || 0,
    issuesOpen: s.github?.issuesOpen || 0,
    goalsActive: s.goals.filter(g => !g.completed).length,
    goalsTotal: s.goals.length,
    progress: s.goalProgress,
  }));

  // Build authors data
  const authorsData = gitStats
    ? Array.from(gitStats.commitsByAuthor.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, commits]) => ({ name, commits }))
    : [];

  // Build repos data
  const reposData = gitStats
    ? Array.from(gitStats.commitsByRepo.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, commits]) => ({ name, commits }))
    : [];

  // Calculate totals
  const totalInputTokens = costs?.bySquad.reduce((sum: number, s: { inputTokens: number }) => sum + s.inputTokens, 0) || 0;
  const totalOutputTokens = costs?.bySquad.reduce((sum: number, s: { outputTokens: number }) => sum + s.outputTokens, 0) || 0;
  const overallProgress = squadData.length > 0
    ? Math.round(squadData.reduce((sum, s) => sum + s.goalProgress, 0) / squadData.length)
    : 0;

  const snapshot: DashboardSnapshot = {
    totalSquads: squadData.length,
    totalCommits: gitStats?.totalCommits || 0,
    totalPrsMerged: ghStats?.prsMerged || 0,
    totalIssuesClosed: ghStats?.issuesClosed || 0,
    totalIssuesOpen: ghStats?.issuesOpen || 0,
    goalProgressPct: overallProgress,
    costUsd: costs?.totalCost || 0,
    dailyBudgetUsd: costs?.dailyBudget || 0, // 0 = not configured (no hardcoded defaults)
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    commits30d: gitStats?.totalCommits || 0,
    avgCommitsPerDay: gitStats?.avgCommitsPerDay || 0,
    activeDays: gitStats?.activeDays || 0,
    peakCommits: gitStats?.peakDay?.count || 0,
    peakDate: gitStats?.peakDay?.date || null,
    squadsData,
    authorsData,
    reposData,
  };

  // Save with timeout - don't block the CLI exit
  const saveTimeout = new Promise<void>(resolve => setTimeout(resolve, 2000));
  await Promise.race([saveDashboardSnapshot(snapshot), saveTimeout]);
}

// Goal classification by scope (tactical = immediate action, strategic = long-term vision)
// Tactical: specific, actionable, concrete tasks (what to do NOW)
const TACTICAL_KEYWORDS = ['fix', 'add', 'update', 'implement', 'run', 'test', 'deploy', 'merge', 'review', 'debug'];
// Strategic: high-level objectives, foundational work (WHERE we're going)
const STRATEGIC_KEYWORDS = ['revenue', 'establish', 'build', 'create', 'define', 'design', 'launch', 'ship', 'foundation', 'strategy'];

// Classify goal scope: tactical (0) = do now, strategic (2) = long-term vision
function inferScope(goal: string): 'tactical' | 'operational' | 'strategic' {
  const lower = goal.toLowerCase();
  if (TACTICAL_KEYWORDS.some(k => lower.includes(k))) return 'tactical';
  if (STRATEGIC_KEYWORDS.some(k => lower.includes(k))) return 'strategic';
  return 'operational'; // middle ground
}

// Legacy priority inference for CEO report (strategic-first view)
function inferPriority(goal: string): 'P0' | 'P1' | 'P2' {
  const lower = goal.toLowerCase();
  // P0 = strategic/revenue critical
  if (STRATEGIC_KEYWORDS.slice(0, 3).some(k => lower.includes(k))) return 'P0'; // revenue, establish, build
  // P1 = operational/important
  if (TACTICAL_KEYWORDS.slice(0, 4).some(k => lower.includes(k))) return 'P1'; // fix, add, update, implement
  return 'P2';
}

async function renderCeoReport(squadsDir: string): Promise<void> {
  const squadNames = listSquads(squadsDir);
  const allGoals: { squad: string; goal: Goal; priority: 'P0' | 'P1' | 'P2' }[] = [];
  const blockers: string[] = [];
  let activeSquads = 0;
  let staleSquads = 0;

  for (const name of squadNames) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const lastActivity = getLastActivityDate(name);
    const activeGoals = squad.goals.filter(g => !g.completed);

    // Check for blockers
    if (activeGoals.length === 0) {
      blockers.push(`${name}: No active goals`);
    } else if (lastActivity.includes('w') || lastActivity === '—') {
      blockers.push(`${name}: Stale (${lastActivity})`);
      staleSquads++;
    } else {
      activeSquads++;
    }

    // Collect goals with inferred priority
    for (const goal of activeGoals) {
      allGoals.push({
        squad: name,
        goal,
        priority: inferPriority(goal.description),
      });
    }
  }

  // Sort by priority
  allGoals.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2 };
    return order[a.priority] - order[b.priority];
  });

  const p0Goals = allGoals.filter(g => g.priority === 'P0');
  const p1Goals = allGoals.filter(g => g.priority === 'P1');

  // Render
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}CEO Report${RESET}`);
  writeLine(`  ${colors.dim}${new Date().toISOString().split('T')[0]}${RESET}`);
  writeLine();

  // Key metrics
  const w = { label: 20, value: 12 };
  const tableWidth = w.label + w.value + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('METRIC', w.label)}${RESET}${bold}VALUE${RESET}       ${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Active Squads', w.label)}${colors.green}${padEnd(`${activeSquads}/${squadNames.length}`, w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('P0 Goals', w.label)}${colors.red}${padEnd(String(p0Goals.length), w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('P1 Goals', w.label)}${colors.yellow}${padEnd(String(p1Goals.length), w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Blockers', w.label)}${blockers.length > 0 ? colors.red : colors.green}${padEnd(String(blockers.length), w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);

  // Token Economics (add to metrics table)
  const costs = await fetchCostSummary(100);
  if (costs) {
    const spendStr = `$${costs.totalCost.toFixed(2)} / $${costs.dailyBudget}`;
    writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Daily Spend', w.label)}${colors.green}${padEnd(spendStr, w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Top Priorities (P0)
  if (p0Goals.length > 0) {
    writeLine(`  ${bold}${colors.red}P0${RESET} ${bold}Priorities${RESET} ${colors.dim}(revenue/launch critical)${RESET}`);
    writeLine();
    for (const { squad, goal } of p0Goals.slice(0, 5)) {
      writeLine(`  ${icons.error} ${colors.cyan}${squad}${RESET} ${goal.description}`);
      if (goal.progress) {
        writeLine(`    ${colors.dim}└ ${goal.progress}${RESET}`);
      }
    }
    writeLine();
  }

  // P1 Goals
  if (p1Goals.length > 0) {
    writeLine(`  ${bold}${colors.yellow}P1${RESET} ${bold}Important${RESET} ${colors.dim}(tracking/foundations)${RESET}`);
    writeLine();
    for (const { squad, goal } of p1Goals.slice(0, 3)) {
      writeLine(`  ${icons.warning} ${colors.cyan}${squad}${RESET} ${truncate(goal.description, 50)}`);
    }
    if (p1Goals.length > 3) {
      writeLine(`  ${colors.dim}  +${p1Goals.length - 3} more${RESET}`);
    }
    writeLine();
  }

  // Blockers
  if (blockers.length > 0) {
    writeLine(`  ${bold}Blockers${RESET}`);
    writeLine();
    for (const blocker of blockers.slice(0, 3)) {
      writeLine(`  ${icons.error} ${colors.red}${blocker}${RESET}`);
    }
    writeLine();
  }

  // Next Steps
  writeLine(`  ${bold}Next Steps${RESET}`);
  writeLine();
  if (p0Goals.length > 0) {
    writeLine(`  ${icons.active} Focus on P0: ${colors.cyan}${p0Goals[0].squad}${RESET} - ${truncate(p0Goals[0].goal.description, 40)}`);
  }
  if (blockers.length > 0) {
    writeLine(`  ${icons.warning} Unblock: ${colors.yellow}${blockers[0]}${RESET}`);
  }
  if (staleSquads > 0) {
    writeLine(`  ${icons.progress} Revive ${staleSquads} stale squad(s)`);
  }
  writeLine();

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads dash              ${colors.dim}Full operational view${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads goal list         ${colors.dim}All active goals${RESET}`);
  writeLine();
}

function renderHistoricalTrendsCached(cache: DashboardCache): void {
  if (!cache.dbAvailable) return;

  const history = cache.history;
  if (history.length < 2) return; // Need at least 2 data points

  writeLine(`  ${bold}Usage Trends${RESET} ${colors.dim}(${history.length}d history)${RESET}`);
  writeLine();

  // Daily cost sparkline (most recent first, so reverse for left-to-right)
  const dailyCosts = history.map(h => h.costUsd).reverse();
  const costSparkStr = sparkline(dailyCosts);
  const totalSpend = dailyCosts.reduce((sum, c) => sum + c, 0);
  const avgDaily = totalSpend / dailyCosts.length;

  writeLine(`  ${colors.dim}Cost:${RESET} ${costSparkStr}  ${colors.green}$${totalSpend.toFixed(2)}${RESET} total  ${colors.dim}($${avgDaily.toFixed(2)}/day avg)${RESET}`);

  // Token usage trend
  const inputTokens = history.map(h => h.inputTokens).reverse();
  const totalInput = inputTokens.reduce((sum, t) => sum + t, 0);
  const tokenSparkStr = sparkline(inputTokens);

  writeLine(`  ${colors.dim}Tokens:${RESET} ${tokenSparkStr}  ${colors.cyan}${formatK(totalInput)}${RESET} input  ${colors.dim}(${formatK(Math.round(totalInput / inputTokens.length))}/day)${RESET}`);

  // Goal progress trend
  const goalProgress = history.map(h => h.goalProgressPct).reverse();
  const latestProgress = goalProgress[goalProgress.length - 1] || 0;
  const earliestProgress = goalProgress[0] || 0;
  const progressDelta = latestProgress - earliestProgress;
  const progressColor = progressDelta > 0 ? colors.green : progressDelta < 0 ? colors.red : colors.dim;
  const progressSign = progressDelta > 0 ? '+' : '';

  writeLine(`  ${colors.dim}Goals:${RESET} ${sparkline(goalProgress)}  ${colors.purple}${latestProgress}%${RESET}  ${progressColor}${progressSign}${progressDelta.toFixed(0)}%${RESET}${colors.dim} vs start${RESET}`);
  writeLine();
}

function renderInsightsCached(cache: DashboardCache): void {
  const insights = cache.insights;

  if (!insights || insights.source === 'none' || insights.taskMetrics.length === 0) {
    return;
  }

  writeLine(`  ${bold}Agent Insights${RESET} ${colors.dim}(${insights.days}d)${RESET}`);
  writeLine();

  // Task completion metrics (aggregated)
  const totals = insights.taskMetrics.reduce(
    (acc, t) => ({
      tasks: acc.tasks + t.tasksTotal,
      completed: acc.completed + t.tasksCompleted,
      failed: acc.failed + t.tasksFailed,
      retries: acc.retries + t.totalRetries,
      withRetries: acc.withRetries + t.tasksWithRetries,
    }),
    { tasks: 0, completed: 0, failed: 0, retries: 0, withRetries: 0 }
  );

  if (totals.tasks > 0) {
    const successRate = totals.tasks > 0 ? ((totals.completed / totals.tasks) * 100).toFixed(0) : '0';
    const successColor = parseInt(successRate) >= 80 ? colors.green : parseInt(successRate) >= 60 ? colors.yellow : colors.red;

    writeLine(`  ${colors.dim}Tasks:${RESET} ${colors.green}${totals.completed}${RESET}${colors.dim}/${totals.tasks} completed${RESET}  ${successColor}${successRate}%${RESET}${colors.dim} success${RESET}  ${colors.red}${totals.failed}${RESET}${colors.dim} failed${RESET}`);

    if (totals.retries > 0) {
      const retryRate = totals.tasks > 0 ? ((totals.withRetries / totals.tasks) * 100).toFixed(0) : '0';
      const retryColor = parseInt(retryRate) > 30 ? colors.red : parseInt(retryRate) > 15 ? colors.yellow : colors.green;
      writeLine(`  ${colors.dim}Retries:${RESET} ${retryColor}${totals.retries}${RESET}${colors.dim} total${RESET}  ${retryColor}${retryRate}%${RESET}${colors.dim} of tasks needed retry${RESET}`);
    }
  }

  // Skip quality metrics for brevity in cached version
  writeLine();
}

/**
 * Render ROI metrics section showing cost projections and before/after comparison
 */
function renderROICached(cache: DashboardCache, goalCount: { active: number; completed: number }): void {
  const { costs, bridgeStats, baseline, squadProjections } = cache;

  if (!costs && !bridgeStats) {
    return;
  }

  const roiMetrics = calculateROIMetrics(
    costs,
    goalCount.completed,
    cache.gitStats?.totalCommits || 0,
    cache.ghStats?.prsMerged || 0
  );

  writeLine(`  ${bold}ROI & Projections${RESET}`);
  writeLine();

  // Cost per output metrics
  if (roiMetrics.totalCostUsd > 0) {
    const metricsLine = [];
    if (roiMetrics.costPerGoal > 0) {
      metricsLine.push(`${colors.cyan}$${roiMetrics.costPerGoal.toFixed(2)}${RESET}${colors.dim}/goal${RESET}`);
    }
    if (roiMetrics.costPerPR > 0) {
      metricsLine.push(`${colors.cyan}$${roiMetrics.costPerPR.toFixed(2)}${RESET}${colors.dim}/PR${RESET}`);
    }
    if (roiMetrics.costPerCommit > 0) {
      metricsLine.push(`${colors.cyan}$${roiMetrics.costPerCommit.toFixed(2)}${RESET}${colors.dim}/commit${RESET}`);
    }
    if (metricsLine.length > 0) {
      writeLine(`  ${colors.dim}Cost/Output:${RESET} ${metricsLine.join(`  ${colors.dim}|${RESET}  `)}`);
    }
  }

  // ROI multiplier
  if (roiMetrics.roiMultiplier > 0) {
    const roiColor = roiMetrics.roiMultiplier >= 3 ? colors.green :
                     roiMetrics.roiMultiplier >= 1 ? colors.cyan : colors.yellow;
    writeLine(`  ${colors.dim}Est. ROI:${RESET}    ${roiColor}${roiMetrics.roiMultiplier.toFixed(1)}x${RESET} ${colors.dim}($${roiMetrics.estimatedValueUsd.toFixed(0)} value / $${roiMetrics.totalCostUsd.toFixed(2)} cost)${RESET}`);
  }

  // Cost projections
  writeLine();
  writeLine(`  ${colors.dim}Projections${RESET}`);
  const dailyBudget = costs?.dailyBudget || 200;
  const projColor = roiMetrics.dailyProjectedCost > dailyBudget ? colors.red :
                    roiMetrics.dailyProjectedCost > dailyBudget * 0.8 ? colors.yellow : colors.green;
  writeLine(`  ${colors.dim}Daily:${RESET}   ${projColor}~$${roiMetrics.dailyProjectedCost.toFixed(2)}${RESET}  ${colors.dim}Weekly:${RESET} ${colors.cyan}~$${roiMetrics.weeklyProjectedCost.toFixed(0)}${RESET}  ${colors.dim}Monthly:${RESET} ${colors.purple}~$${roiMetrics.monthlyProjectedCost.toFixed(0)}${RESET}`);

  // Squad-level projections
  if (squadProjections.length > 0) {
    writeLine();
    writeLine(`  ${colors.dim}By Squad (projected monthly)${RESET}`);
    const topSquads = squadProjections
      .sort((a, b) => b.projectedMonthlyCost - a.projectedMonthlyCost)
      .slice(0, 4);
    for (const sq of topSquads) {
      const trendIcon = sq.costTrend === 'increasing' ? `${colors.red}↑${RESET}` :
                        sq.costTrend === 'decreasing' ? `${colors.green}↓${RESET}` : `${colors.dim}-${RESET}`;
      writeLine(`  ${colors.cyan}${padEnd(sq.squad, 14)}${RESET}${colors.dim}~$${sq.projectedMonthlyCost.toFixed(0)}/mo${RESET} ${trendIcon}`);
    }
  }

  // Before/after comparison with baseline
  if (baseline) {
    writeLine();
    writeLine(`  ${colors.dim}vs Baseline${RESET} ${colors.dim}(${baseline.name})${RESET}`);
    const costDelta = roiMetrics.totalCostUsd - baseline.costUsd;
    const goalsDelta = goalCount.completed - baseline.goalsCompleted;
    const costPerGoalBefore = baseline.goalsCompleted > 0 ? baseline.costUsd / baseline.goalsCompleted : 0;
    const costPerGoalAfter = goalCount.completed > 0 ? roiMetrics.totalCostUsd / goalCount.completed : 0;
    const efficiencyChange = costPerGoalBefore > 0 ? ((costPerGoalBefore - costPerGoalAfter) / costPerGoalBefore) * 100 : 0;

    const costColor = costDelta > 0 ? colors.red : colors.green;
    const goalsColor = goalsDelta >= 0 ? colors.green : colors.red;
    const effColor = efficiencyChange > 0 ? colors.green : efficiencyChange < 0 ? colors.red : colors.dim;
    writeLine(`  ${colors.dim}Cost:${RESET}  ${costColor}${costDelta >= 0 ? '+' : ''}$${costDelta.toFixed(2)}${RESET}  ${colors.dim}Goals:${RESET} ${goalsColor}${goalsDelta >= 0 ? '+' : ''}${goalsDelta}${RESET}  ${colors.dim}Efficiency:${RESET} ${effColor}${efficiencyChange >= 0 ? '+' : ''}${efficiencyChange.toFixed(0)}%${RESET}`);
  } else {
    writeLine();
    writeLine(`  ${colors.dim}No baseline set. Capture one with:${RESET} squads baseline`);
  }

  writeLine();
}
