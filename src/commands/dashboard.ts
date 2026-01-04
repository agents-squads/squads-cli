import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { findSquadsDir, listSquads, loadSquad, Goal } from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { fetchCostSummary, formatCostBar, CostSummary, fetchRateLimits, RateLimits, fetchInsights, Insights, fetchBridgeStats, BridgeStats } from '../lib/costs.js';
import { getMultiRepoGitStats, getActivitySparkline, getGitHubStats, getGitHubStatsOptimized, SquadGitHubStats, GitPerformanceStats, GitHubStats } from '../lib/git.js';
import { saveDashboardSnapshot, isDatabaseAvailable, getDashboardHistory, DashboardSnapshot, SquadSnapshotData, closeDatabase } from '../lib/db.js';
import { getSessionSummary, cleanupStaleSessions } from '../lib/sessions.js';
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
  status: 'active' | 'stale' | 'needs-goal';
  github: SquadGitHubStats | null;
  goalProgress: number; // 0-100
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
}

export async function dashboardCommand(options: { verbose?: boolean; ceo?: boolean; fast?: boolean } = {}): Promise<void> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
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
  // Fetch all expensive data in parallel to minimize wall time
  // Wrap slow calls with race timeout to ensure CLI responsiveness
  const timeout = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([promise, new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms))]);

  const [gitStats, ghStats, costs, bridgeStats, activity, dbAvailable, history, insights] = await Promise.all([
    // Git stats (local, ~1s)
    Promise.resolve(baseDir ? getMultiRepoGitStats(baseDir, 30) : null),
    // GitHub stats (network, ~20-30s) - skip by default for fast mode
    skipGitHub ? Promise.resolve(null) : Promise.resolve(baseDir ? getGitHubStatsOptimized(baseDir, 30) : null),
    // Langfuse costs (network, 2s timeout)
    timeout(fetchCostSummary(100), 2000, null),
    // Bridge stats (local network, 2s timeout)
    timeout(fetchBridgeStats(), 2000, null),
    // Activity sparkline (local, <1s)
    Promise.resolve(baseDir ? getActivitySparkline(baseDir, 14) : []),
    // Database availability check (1.5s timeout)
    timeout(isDatabaseAvailable(), 1500, false),
    // Dashboard history (1.5s timeout)
    timeout(getDashboardHistory(14).catch(() => [] as DashboardSnapshot[]), 1500, [] as DashboardSnapshot[]),
    // Insights (2s timeout)
    timeout(fetchInsights('week').catch(() => null), 2000, null),
  ]);

  // Create cache for render functions
  const cache: DashboardCache = { gitStats, ghStats, costs, bridgeStats, activity, dbAvailable, history, insights };

  // === PHASE 2: Build squad metrics (sync, fast) ===
  const squadData: SquadMetrics[] = [];

  for (const name of squadNames) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const lastActivity = getLastActivityDate(name);
    const github = ghStats?.bySquad.get(name) || null;

    let status: SquadMetrics['status'] = 'active';
    const activeGoals = squad.goals.filter(g => !g.completed);
    if (activeGoals.length === 0) {
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
    });
  }

  // === PHASE 3: Render (sync, fast) ===
  const activeSquads = squadData.filter(s => s.status === 'active').length;
  const totalPRs = ghStats ? ghStats.prsMerged : 0;
  const totalIssuesClosed = ghStats ? ghStats.issuesClosed : 0;
  const totalIssuesOpen = ghStats ? ghStats.issuesOpen : 0;

  // Get active sessions
  cleanupStaleSessions();
  const sessionSummary = getSessionSummary();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}dashboard${RESET}`);

  // Session indicator line (only if there are active sessions)
  if (sessionSummary.totalSessions > 0) {
    const sessionText = sessionSummary.totalSessions === 1 ? 'session' : 'sessions';
    const squadText = sessionSummary.squadCount === 1 ? 'squad' : 'squads';
    writeLine(`  ${colors.green}${icons.active}${RESET} ${colors.white}${sessionSummary.totalSessions}${RESET} active ${sessionText} ${colors.dim}across${RESET} ${colors.cyan}${sessionSummary.squadCount}${RESET} ${squadText}`);
  }
  writeLine();

  // Stats row - show different info based on whether GitHub data is available
  const statsParts = [`${colors.cyan}${activeSquads}${RESET}/${squadData.length} squads`];
  if (ghStats) {
    statsParts.push(`${colors.green}${totalPRs}${RESET} PRs merged`);
    statsParts.push(`${colors.purple}${totalIssuesClosed}${RESET} closed`);
    statsParts.push(`${colors.yellow}${totalIssuesOpen}${RESET} open`);
  } else {
    statsParts.push(`${colors.cyan}${gitStats?.totalCommits || 0}${RESET} commits`);
    statsParts.push(`${colors.dim}use -f for PRs/issues${RESET}`);
  }
  writeLine(`  ${statsParts.join(`  ${colors.dim}│${RESET}  `)}`);
  writeLine();

  const overallProgress = squadData.length > 0
    ? Math.round(squadData.reduce((sum, s) => sum + s.goalProgress, 0) / squadData.length)
    : 0;
  writeLine(`  ${progressBar(overallProgress, 32)} ${colors.dim}${overallProgress}% goal progress${RESET}`);
  writeLine();

  // Squad table
  const w = { name: 13, commits: 7, prs: 4, issues: 6, goals: 6, bar: 10 };
  const tableWidth = w.name + w.commits + w.prs + w.issues + w.goals + w.bar + 12;

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
    const activeCount = squad.goals.filter(g => !g.completed).length;
    const totalCount = squad.goals.length;

    const commitColor = commits > 10 ? colors.green : commits > 0 ? colors.cyan : colors.dim;
    const prColor = prs > 0 ? colors.green : colors.dim;
    const issueColor = issuesClosed > 0 ? colors.green : colors.dim;

    writeLine(`  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(squad.name, w.name)}${RESET}` +
      `${commitColor}${padEnd(String(commits), w.commits)}${RESET}` +
      `${prColor}${padEnd(String(prs), w.prs)}${RESET}` +
      `${issueColor}${padEnd(`${issuesClosed}/${issuesOpen}`, w.issues)}${RESET}` +
      `${padEnd(`${activeCount}/${totalCount}`, w.goals)}` +
      `${progressBar(squad.goalProgress, 8)}` +
      ` ${colors.purple}${box.vertical}${RESET}`);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Render sections using cached data (no more network calls)
  renderGitPerformanceCached(cache);
  renderTokenEconomicsCached(cache);
  renderInfrastructureCached(cache);

  // These still need async but are fast
  renderHistoricalTrendsCached(cache);
  renderInsightsCached(cache);

  // Goals section
  const allActiveGoals = squadData.flatMap(s =>
    s.goals.filter(g => !g.completed).map(g => ({ squad: s.name, goal: g }))
  );

  if (allActiveGoals.length > 0) {
    writeLine(`  ${bold}Goals${RESET}`);
    writeLine();

    const maxGoals = 6;
    for (const { squad, goal } of allActiveGoals.slice(0, maxGoals)) {
      const hasProgress = goal.progress && goal.progress.length > 0;
      const icon = hasProgress ? icons.progress : icons.empty;
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

  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}<squad>${RESET}    ${colors.dim}Execute a squad${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads goal set    ${colors.dim}Add a goal${RESET}`);
  writeLine();

  // Save snapshot in background (don't block)
  saveSnapshotCached(squadData, cache, baseDir).catch(() => {});

  // Close database pool to allow process to exit immediately
  await closeDatabase();
}

/**
 * Save dashboard snapshot to local PostgreSQL for historical tracking
 */
async function saveSnapshot(
  squadData: SquadMetrics[],
  ghStats: GitHubStats | null,
  baseDir: string | null
): Promise<void> {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;

  // Fetch additional data for snapshot
  const gitStats = baseDir ? getMultiRepoGitStats(baseDir, 30) : null;
  const costs = await fetchCostSummary(100);

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
  const totalInputTokens = costs?.bySquad.reduce((sum, s) => sum + s.inputTokens, 0) || 0;
  const totalOutputTokens = costs?.bySquad.reduce((sum, s) => sum + s.outputTokens, 0) || 0;
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
    dailyBudgetUsd: costs?.dailyBudget || 50,
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

  await saveDashboardSnapshot(snapshot);
}

// Find agents-squads base directory
function findAgentsSquadsDir(): string | null {
  const candidates = [
    join(process.cwd(), '..'),
    join(homedir(), 'agents-squads'),
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, 'hq'))) {
      return dir;
    }
  }
  return null;
}

async function renderGitPerformance(): Promise<void> {
  const baseDir = findAgentsSquadsDir();

  if (!baseDir) {
    writeLine(`  ${bold}Git Activity${RESET} ${colors.dim}(no repos found)${RESET}`);
    writeLine();
    return;
  }

  const stats = getMultiRepoGitStats(baseDir, 30);
  const activity = getActivitySparkline(baseDir, 14);

  if (stats.totalCommits === 0) {
    writeLine(`  ${bold}Git Activity${RESET} ${colors.dim}(no commits in 30d)${RESET}`);
    writeLine();
    return;
  }

  writeLine(`  ${bold}Git Activity${RESET} ${colors.dim}(30d)${RESET}`);
  writeLine();

  // Sparkline for last 14 days
  const spark = sparkline(activity);
  writeLine(`  ${colors.dim}Last 14d:${RESET} ${spark}`);
  writeLine();

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

async function renderTokenEconomics(squadNames: string[]): Promise<void> {
  const costs = await fetchCostSummary(100);

  if (!costs) {
    // No Langfuse config or API error - show hint
    writeLine(`  ${bold}Token Economics${RESET} ${colors.dim}(no data)${RESET}`);
    writeLine(`  ${colors.dim}Set LANGFUSE_PUBLIC_KEY & LANGFUSE_SECRET_KEY for cost tracking${RESET}`);
    writeLine();
    return;
  }

  writeLine(`  ${bold}Token Economics${RESET} ${colors.dim}(last 100 calls)${RESET}`);
  writeLine();

  // Budget bar
  const barWidth = 32;
  const costBar = formatCostBar(costs.usedPercent, barWidth);
  writeLine(`  ${colors.dim}Budget $${costs.dailyBudget}${RESET} [${costBar}] ${costs.usedPercent.toFixed(1)}%`);
  writeLine(`  ${colors.green}$${costs.totalCost.toFixed(2)}${RESET} used  ${colors.dim}│${RESET}  ${colors.cyan}$${costs.idleBudget.toFixed(2)}${RESET} idle`);
  writeLine();

  // Anthropic tier and limits
  const tier = parseInt(process.env.ANTHROPIC_TIER || '4', 10);

  // RPM limits by tier (same for all models)
  const rpmByTier: Record<number, number> = { 1: 50, 2: 1000, 3: 2000, 4: 4000 };
  const rpmLimit = rpmByTier[tier] || 4000;

  // Token limits by tier and model family (ITPM/OTPM per minute)
  const tokenLimits: Record<number, Record<string, { itpm: number; otpm: number }>> = {
    1: { opus: { itpm: 30000, otpm: 8000 }, sonnet: { itpm: 30000, otpm: 8000 }, haiku: { itpm: 50000, otpm: 10000 } },
    2: { opus: { itpm: 450000, otpm: 90000 }, sonnet: { itpm: 450000, otpm: 90000 }, haiku: { itpm: 450000, otpm: 90000 } },
    3: { opus: { itpm: 800000, otpm: 160000 }, sonnet: { itpm: 800000, otpm: 160000 }, haiku: { itpm: 1000000, otpm: 200000 } },
    4: { opus: { itpm: 2000000, otpm: 400000 }, sonnet: { itpm: 2000000, otpm: 400000 }, haiku: { itpm: 4000000, otpm: 800000 } },
  };

  const modelShortNames: Record<string, string> = {
    'claude-opus-4-5-20251101': 'opus-4.5',
    'claude-sonnet-4-20250514': 'sonnet-4',
    'claude-haiku-4-5-20251001': 'haiku-4.5',
    'claude-3-5-sonnet-20241022': 'sonnet-3.5',
    'claude-3-5-haiku-20241022': 'haiku-3.5',
  };

  const modelToFamily: Record<string, string> = {
    'claude-opus-4-5-20251101': 'opus',
    'claude-sonnet-4-20250514': 'sonnet',
    'claude-haiku-4-5-20251001': 'haiku',
    'claude-3-5-sonnet-20241022': 'sonnet',
    'claude-3-5-haiku-20241022': 'haiku',
  };

  // Aggregate stats by model
  const modelStats: Record<string, { calls: number; input: number; output: number; cached: number }> = {};
  for (const squad of costs.bySquad) {
    for (const [model, count] of Object.entries(squad.models)) {
      if (!modelStats[model]) {
        modelStats[model] = { calls: 0, input: 0, output: 0, cached: 0 };
      }
      modelStats[model].calls += count;
    }
    // Distribute tokens proportionally (approximation since we don't have per-model token breakdown)
    const totalCalls = Object.values(squad.models).reduce((a, b) => a + b, 0);
    for (const [model, count] of Object.entries(squad.models)) {
      const ratio = totalCalls > 0 ? count / totalCalls : 0;
      modelStats[model].input += Math.round(squad.inputTokens * ratio);
      modelStats[model].output += Math.round(squad.outputTokens * ratio);
    }
  }

  // Total tokens for all models
  const totalInput = costs.bySquad.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalOutput = costs.bySquad.reduce((sum, s) => sum + s.outputTokens, 0);
  const totalCalls = costs.bySquad.reduce((sum, s) => sum + s.calls, 0);

  // Cost projections - extrapolate based on hours elapsed today
  const now = new Date();
  const hoursElapsed = Math.max(now.getHours() + now.getMinutes() / 60, 1); // At least 1 hour to avoid division issues
  const hourlyRate = costs.totalCost / hoursElapsed;
  const dailyProjection = hourlyRate * 24;
  const monthlyProjection = dailyProjection * 30;

  // Fetch real rate limits from proxy (if available)
  const rateLimits = await fetchRateLimits();
  const hasRealLimits = rateLimits.source === 'proxy' && Object.keys(rateLimits.limits).length > 0;

  // Display rate limits section
  if (hasRealLimits) {
    writeLine(`  ${colors.dim}Rate Limits${RESET} ${colors.green}(live)${RESET}`);

    for (const [family, limits] of Object.entries(rateLimits.limits)) {
      const name = family === 'opus' ? 'opus' : family === 'sonnet' ? 'sonnet' : family === 'haiku' ? 'haiku' : family;

      // Request rate usage
      const reqUsed = limits.requestsLimit - limits.requestsRemaining;
      const reqPct = limits.requestsLimit > 0 ? (reqUsed / limits.requestsLimit) * 100 : 0;
      const reqColor = reqPct > 80 ? colors.red : reqPct > 50 ? colors.yellow : colors.green;

      // Token rate usage
      const tokUsed = limits.tokensLimit - limits.tokensRemaining;
      const tokPct = limits.tokensLimit > 0 ? (tokUsed / limits.tokensLimit) * 100 : 0;
      const tokColor = tokPct > 80 ? colors.red : tokPct > 50 ? colors.yellow : colors.green;

      writeLine(`  ${colors.cyan}${padEnd(name, 8)}${RESET} ${reqColor}${String(reqUsed).padStart(4)}${RESET}${colors.dim}/${limits.requestsLimit}req${RESET}  ${tokColor}${formatK(tokUsed)}${RESET}${colors.dim}/${formatK(limits.tokensLimit)}tok${RESET}`);
    }
  } else {
    writeLine(`  ${colors.dim}Rate Limits (Tier ${tier})${RESET}`);

    const sortedModels = Object.entries(modelStats).sort((a, b) => b[1].calls - a[1].calls);
    for (const [model, stats] of sortedModels.slice(0, 3)) {
      const name = modelShortNames[model] || model.split('-').slice(1, 3).join('-');
      const family = modelToFamily[model] || 'sonnet';
      const limits = tokenLimits[tier]?.[family] || { itpm: 1000000, otpm: 200000 };

      // RPM
      const rpmPct = (stats.calls / rpmLimit) * 100;
      const rpmColor = rpmPct > 80 ? colors.red : rpmPct > 50 ? colors.yellow : colors.green;

      // Format: model [RPM bar] calls  [ITPM] input  [OTPM] output
      writeLine(`  ${colors.cyan}${padEnd(name, 11)}${RESET} ${rpmColor}${String(stats.calls).padStart(4)}${RESET}${colors.dim}rpm${RESET}  ${colors.dim}${formatK(stats.input)}${RESET}${colors.dim}/${formatK(limits.itpm)}i${RESET}  ${colors.dim}${formatK(stats.output)}${RESET}${colors.dim}/${formatK(limits.otpm)}o${RESET}`);
    }
  }
  writeLine();

  // Cache efficiency
  if (costs.totalCachedTokens > 0 || costs.cacheHitRate > 0) {
    const cacheColor = costs.cacheHitRate > 50 ? colors.green : costs.cacheHitRate > 20 ? colors.yellow : colors.red;
    writeLine(`  ${colors.dim}Cache:${RESET} ${cacheColor}${costs.cacheHitRate.toFixed(1)}%${RESET} hit rate  ${colors.dim}(${formatK(costs.totalCachedTokens)} cached / ${formatK(costs.totalInputTokens + costs.totalCachedTokens)} total)${RESET}`);
    writeLine();
  }

  // Cost projections
  writeLine(`  ${colors.dim}Projections${RESET}`);
  const projColor = dailyProjection > costs.dailyBudget ? colors.red : colors.green;
  writeLine(`  ${colors.dim}Daily:${RESET}  ${projColor}~$${dailyProjection.toFixed(2)}${RESET}${colors.dim}/${costs.dailyBudget}${RESET}  ${colors.dim}Monthly:${RESET} ${colors.cyan}~$${monthlyProjection.toFixed(0)}${RESET}`);

  // Alerts
  if (dailyProjection > costs.dailyBudget * 0.8) {
    writeLine(`  ${colors.yellow}⚠${RESET} ${colors.yellow}Projected to exceed daily budget${RESET}`);
  }
  if (costs.usedPercent > 80) {
    writeLine(`  ${colors.red}⚠${RESET} ${colors.red}${costs.usedPercent.toFixed(0)}% of daily budget used${RESET}`);
  }
  writeLine();
}

// Format number as K/M
function formatK(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

async function renderHistoricalTrends(): Promise<void> {
  // Check if database is available
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) return;

  const history = await getDashboardHistory(14);
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

async function renderInsights(): Promise<void> {
  const insights = await fetchInsights('week');

  if (insights.source === 'none' || insights.taskMetrics.length === 0) {
    // No insights data available - skip section entirely
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

    // Task completion row
    writeLine(`  ${colors.dim}Tasks:${RESET} ${colors.green}${totals.completed}${RESET}${colors.dim}/${totals.tasks} completed${RESET}  ${successColor}${successRate}%${RESET}${colors.dim} success${RESET}  ${colors.red}${totals.failed}${RESET}${colors.dim} failed${RESET}`);

    // Retry metrics
    if (totals.retries > 0) {
      const retryRate = totals.tasks > 0 ? ((totals.withRetries / totals.tasks) * 100).toFixed(0) : '0';
      const retryColor = parseInt(retryRate) > 30 ? colors.red : parseInt(retryRate) > 15 ? colors.yellow : colors.green;
      writeLine(`  ${colors.dim}Retries:${RESET} ${retryColor}${totals.retries}${RESET}${colors.dim} total${RESET}  ${retryColor}${retryRate}%${RESET}${colors.dim} of tasks needed retry${RESET}`);
    }
  }

  // Quality metrics (if feedback exists)
  const qualityTotals = insights.qualityMetrics.reduce(
    (acc, q) => ({
      feedback: acc.feedback + q.feedbackCount,
      qualitySum: acc.qualitySum + (q.avgQuality * q.feedbackCount),
      helpfulSum: acc.helpfulSum + (q.helpfulPct * q.feedbackCount / 100),
      fixSum: acc.fixSum + (q.fixRequiredPct * q.feedbackCount / 100),
    }),
    { feedback: 0, qualitySum: 0, helpfulSum: 0, fixSum: 0 }
  );

  if (qualityTotals.feedback > 0) {
    const avgQuality = qualityTotals.qualitySum / qualityTotals.feedback;
    const helpfulPct = (qualityTotals.helpfulSum / qualityTotals.feedback) * 100;
    const fixPct = (qualityTotals.fixSum / qualityTotals.feedback) * 100;

    const qualityColor = avgQuality >= 4 ? colors.green : avgQuality >= 3 ? colors.yellow : colors.red;
    const stars = '★'.repeat(Math.round(avgQuality)) + '☆'.repeat(5 - Math.round(avgQuality));

    writeLine(`  ${colors.dim}Quality:${RESET} ${qualityColor}${stars}${RESET} ${colors.dim}(${avgQuality.toFixed(1)}/5)${RESET}  ${colors.green}${helpfulPct.toFixed(0)}%${RESET}${colors.dim} helpful${RESET}  ${fixPct > 20 ? colors.red : colors.dim}${fixPct.toFixed(0)}% needed fixes${RESET}`);
  }

  // Context window utilization
  const contextMetrics = insights.taskMetrics.filter(t => t.avgContextPct > 0);
  if (contextMetrics.length > 0) {
    const avgContext = contextMetrics.reduce((sum, t) => sum + t.avgContextPct, 0) / contextMetrics.length;
    const maxContext = Math.max(...contextMetrics.map(t => t.maxContextTokens));

    // Context utilization colors: green < 40%, yellow 40-70%, red > 70%
    const contextColor = avgContext < 40 ? colors.green : avgContext < 70 ? colors.yellow : colors.red;
    const contextStatus = avgContext < 40 ? 'lean' : avgContext < 70 ? 'moderate' : 'heavy';

    writeLine(`  ${colors.dim}Context:${RESET} ${contextColor}${avgContext.toFixed(0)}%${RESET}${colors.dim} avg utilization (${contextStatus})${RESET}  ${colors.dim}peak ${formatK(maxContext)} tokens${RESET}`);
  }

  writeLine();

  // Top tools (compact)
  if (insights.topTools.length > 0) {
    const toolLine = insights.topTools.slice(0, 5).map(t => {
      const successColor = t.successRate >= 95 ? colors.green : t.successRate >= 80 ? colors.yellow : colors.red;
      return `${colors.dim}${t.toolName.replace('mcp__', '').slice(0, 12)}${RESET} ${successColor}${t.successRate.toFixed(0)}%${RESET}`;
    }).join('  ');

    writeLine(`  ${colors.dim}Tools:${RESET} ${toolLine}`);

    // Tool failure alert
    if (insights.toolFailureRate > 5) {
      writeLine(`  ${colors.yellow}⚠${RESET} ${colors.yellow}${insights.toolFailureRate.toFixed(1)}% tool failure rate${RESET}`);
    }
    writeLine();
  }
}

async function renderInfrastructure(): Promise<void> {
  const stats = await fetchBridgeStats();

  if (!stats) {
    writeLine(`  ${bold}Infrastructure${RESET} ${colors.dim}(bridge offline)${RESET}`);
    writeLine(`  ${colors.dim}Start with: cd docker && docker-compose up -d${RESET}`);
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
    const costColor = stats.budget.usedPct > 80 ? colors.red : stats.budget.usedPct > 50 ? colors.yellow : colors.green;
    writeLine(`  ${colors.dim}Today:${RESET} ${colors.cyan}${stats.today.generations}${RESET}${colors.dim} calls${RESET}  ${costColor}$${stats.today.costUsd.toFixed(2)}${RESET}${colors.dim}/$${stats.budget.daily}${RESET}  ${colors.dim}${formatK(stats.today.inputTokens)}+${formatK(stats.today.outputTokens)} tokens${RESET}`);

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

    // Squad breakdown
    if (stats.bySquad.length > 1) {
      const squadLine = stats.bySquad.slice(0, 4).map(s =>
        `${colors.dim}${s.squad}${RESET} ${colors.green}$${s.costUsd.toFixed(2)}${RESET}`
      ).join('  ');
      writeLine(`  ${colors.dim}Squads:${RESET} ${squadLine}`);
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

function renderTokenEconomicsCached(cache: DashboardCache): void {
  const costs = cache.costs;

  if (!costs) {
    writeLine(`  ${bold}Token Economics${RESET} ${colors.dim}(no data)${RESET}`);
    writeLine(`  ${colors.dim}Set LANGFUSE_PUBLIC_KEY & LANGFUSE_SECRET_KEY for cost tracking${RESET}`);
    writeLine();
    return;
  }

  writeLine(`  ${bold}Token Economics${RESET} ${colors.dim}(last 100 calls)${RESET}`);
  writeLine();

  // Budget bar
  const barWidth = 32;
  const costBar = formatCostBar(costs.usedPercent, barWidth);
  writeLine(`  ${colors.dim}Budget $${costs.dailyBudget}${RESET} [${costBar}] ${costs.usedPercent.toFixed(1)}%`);
  writeLine(`  ${colors.green}$${costs.totalCost.toFixed(2)}${RESET} used  ${colors.dim}│${RESET}  ${colors.cyan}$${costs.idleBudget.toFixed(2)}${RESET} idle`);
  writeLine();

  // Rate limits (simplified - skip the async fetch)
  const tier = parseInt(process.env.ANTHROPIC_TIER || '4', 10);
  writeLine(`  ${colors.dim}Rate Limits (Tier ${tier})${RESET}`);
  writeLine();

  // Cost projections - extrapolate based on hours elapsed today
  const now = new Date();
  const hoursElapsed = Math.max(now.getHours() + now.getMinutes() / 60, 1);
  const hourlyRate = costs.totalCost / hoursElapsed;
  const dailyProjection = hourlyRate * 24;
  const monthlyProjection = dailyProjection * 30;

  writeLine(`  ${colors.dim}Projections${RESET}`);
  const projColor = dailyProjection > costs.dailyBudget ? colors.red : colors.green;
  writeLine(`  ${colors.dim}Daily:${RESET}  ${projColor}~$${dailyProjection.toFixed(2)}${RESET}${colors.dim}/${costs.dailyBudget}${RESET}  ${colors.dim}Monthly:${RESET} ${colors.cyan}~$${monthlyProjection.toFixed(0)}${RESET}`);

  if (dailyProjection > costs.dailyBudget * 0.8) {
    writeLine(`  ${colors.yellow}⚠${RESET} ${colors.yellow}Projected to exceed daily budget${RESET}`);
  }
  if (costs.usedPercent > 80) {
    writeLine(`  ${colors.red}⚠${RESET} ${colors.red}${costs.usedPercent.toFixed(0)}% of daily budget used${RESET}`);
  }
  writeLine();
}

function renderInfrastructureCached(cache: DashboardCache): void {
  const stats = cache.bridgeStats;

  if (!stats) {
    writeLine(`  ${bold}Infrastructure${RESET} ${colors.dim}(bridge offline)${RESET}`);
    writeLine(`  ${colors.dim}Start with: cd docker && docker-compose up -d${RESET}`);
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
    const costColor = stats.budget.usedPct > 80 ? colors.red : stats.budget.usedPct > 50 ? colors.yellow : colors.green;
    writeLine(`  ${colors.dim}Today:${RESET} ${colors.cyan}${stats.today.generations}${RESET}${colors.dim} calls${RESET}  ${costColor}$${stats.today.costUsd.toFixed(2)}${RESET}${colors.dim}/$${stats.budget.daily}${RESET}  ${colors.dim}${formatK(stats.today.inputTokens)}+${formatK(stats.today.outputTokens)} tokens${RESET}`);

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

async function saveSnapshotCached(
  squadData: SquadMetrics[],
  cache: DashboardCache,
  baseDir: string | null
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
  const totalInputTokens = costs?.bySquad.reduce((sum, s) => sum + s.inputTokens, 0) || 0;
  const totalOutputTokens = costs?.bySquad.reduce((sum, s) => sum + s.outputTokens, 0) || 0;
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
    dailyBudgetUsd: costs?.dailyBudget || 50,
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

// Priority keywords that indicate high priority goals
const P0_KEYWORDS = ['revenue', 'first', 'launch', 'publish', 'ship', 'critical', 'urgent'];
const P1_KEYWORDS = ['track', 'establish', 'identify', 'define', 'fix'];

function inferPriority(goal: string): 'P0' | 'P1' | 'P2' {
  const lower = goal.toLowerCase();
  if (P0_KEYWORDS.some(k => lower.includes(k))) return 'P0';
  if (P1_KEYWORDS.some(k => lower.includes(k))) return 'P1';
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
