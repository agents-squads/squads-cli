import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { findSquadsDir, listSquads, loadSquad, Goal } from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { fetchCostSummary, formatCostBar, CostSummary } from '../lib/costs.js';
import { getMultiRepoGitStats, getActivitySparkline, getGitHubStats, SquadGitHubStats, GitPerformanceStats, GitHubStats } from '../lib/git.js';
import { saveDashboardSnapshot, isDatabaseAvailable, DashboardSnapshot, SquadSnapshotData } from '../lib/db.js';
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

export async function dashboardCommand(options: { verbose?: boolean; ceo?: boolean } = {}): Promise<void> {
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

  const squadNames = listSquads(squadsDir);
  const squadData: SquadMetrics[] = [];

  // Fetch GitHub stats
  const baseDir = findAgentsSquadsDir();
  const ghStats = baseDir ? getGitHubStats(baseDir, 30) : null;

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

    // Calculate goal progress based on work done
    const totalGoals = squad.goals.length;
    const completedGoals = squad.goals.filter(g => g.completed).length;
    const hasProgress = squad.goals.filter(g => g.progress).length;
    // Progress = completed + half credit for in-progress
    const goalProgress = totalGoals > 0
      ? Math.round(((completedGoals + hasProgress * 0.3) / totalGoals) * 100)
      : 0;

    squadData.push({
      name,
      mission: squad.mission,
      goals: squad.goals,
      lastActivity,
      status,
      github,
      goalProgress,
    });
  }

  // Stats
  const totalGoals = squadData.reduce((sum, s) => sum + s.goals.length, 0);
  const activeGoals = squadData.reduce((sum, s) => sum + s.goals.filter(g => !g.completed).length, 0);
  const completedGoals = totalGoals - activeGoals;
  const completionRate = totalGoals > 0 ? Math.round((completedGoals / totalGoals) * 100) : 0;
  const activeSquads = squadData.filter(s => s.status === 'active').length;

  // GitHub totals
  const totalPRs = ghStats ? ghStats.prsMerged : 0;
  const totalIssuesClosed = ghStats ? ghStats.issuesClosed : 0;
  const totalIssuesOpen = ghStats ? ghStats.issuesOpen : 0;

  // Render
  writeLine();

  // Header
  writeLine(`  ${gradient('squads')} ${colors.dim}dashboard${RESET}`);
  writeLine();

  // Stats row
  const stats = [
    `${colors.cyan}${activeSquads}${RESET}/${squadData.length} squads`,
    `${colors.green}${totalPRs}${RESET} PRs merged`,
    `${colors.purple}${totalIssuesClosed}${RESET} closed`,
    `${colors.yellow}${totalIssuesOpen}${RESET} open`,
  ].join(`  ${colors.dim}│${RESET}  `);
  writeLine(`  ${stats}`);
  writeLine();

  // Overall progress
  const overallProgress = squadData.length > 0
    ? Math.round(squadData.reduce((sum, s) => sum + s.goalProgress, 0) / squadData.length)
    : 0;
  writeLine(`  ${progressBar(overallProgress, 32)} ${colors.dim}${overallProgress}% goal progress${RESET}`);
  writeLine();

  // Table header - enhanced with metrics
  const w = { name: 13, commits: 7, prs: 4, issues: 6, goals: 6, bar: 10 };
  const tableWidth = w.name + w.commits + w.prs + w.issues + w.goals + w.bar + 12;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
    `${bold}${padEnd('COMMITS', w.commits)}${RESET}` +
    `${bold}${padEnd('PRs', w.prs)}${RESET}` +
    `${bold}${padEnd('ISSUES', w.issues)}${RESET}` +
    `${bold}${padEnd('GOALS', w.goals)}${RESET}` +
    `${bold}PROGRESS${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  // Table rows - sorted by activity
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

    // Color coding based on activity
    const commitColor = commits > 10 ? colors.green : commits > 0 ? colors.cyan : colors.dim;
    const prColor = prs > 0 ? colors.green : colors.dim;
    const issueColor = issuesClosed > 0 ? colors.green : colors.dim;

    // Issues display: closed/open
    const issuesDisplay = `${issuesClosed}/${issuesOpen}`;

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(squad.name, w.name)}${RESET}` +
      `${commitColor}${padEnd(String(commits), w.commits)}${RESET}` +
      `${prColor}${padEnd(String(prs), w.prs)}${RESET}` +
      `${issueColor}${padEnd(issuesDisplay, w.issues)}${RESET}` +
      `${padEnd(`${activeCount}/${totalCount}`, w.goals)}` +
      `${progressBar(squad.goalProgress, 8)}` +
      ` ${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Git Performance
  await renderGitPerformance();

  // Token Economics
  await renderTokenEconomics(squadData.map(s => s.name));

  // Active goals (compact)
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
      const squadLabel = `${colors.dim}${squad}${RESET}`;
      const goalText = truncate(goal.description, 48);

      writeLine(`  ${icon} ${squadLabel} ${goalText}`);

      if (hasProgress) {
        const progressText = truncate(goal.progress!, 52);
        writeLine(`    ${colors.dim}└${RESET} ${colors.green}${progressText}${RESET}`);
      }
    }

    if (allActiveGoals.length > maxGoals) {
      writeLine(`  ${colors.dim}  +${allActiveGoals.length - maxGoals} more${RESET}`);
    }
    writeLine();
  }

  // Quick actions
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}<squad>${RESET}    ${colors.dim}Execute a squad${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads goal set    ${colors.dim}Add a goal${RESET}`);
  writeLine();

  // Save snapshot to local postgres (silent on failure)
  await saveSnapshot(squadData, ghStats, baseDir);
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

  // Per-squad costs (compact)
  if (costs.bySquad.length > 0) {
    const maxSquads = 5;
    for (const squad of costs.bySquad.slice(0, maxSquads)) {
      const pct = ((squad.cost / costs.dailyBudget) * 100).toFixed(1);
      const tokens = squad.inputTokens + squad.outputTokens;
      const tokensK = (tokens / 1000).toFixed(1);

      // Model mix
      const opus = squad.models['claude-opus-4-5-20251101'] || 0;
      const haiku = squad.models['claude-haiku-4-5-20251001'] || 0;
      const modelMix = `${colors.dim}${opus}o/${haiku}h${RESET}`;

      writeLine(`  ${colors.cyan}${padEnd(squad.squad, 12)}${RESET} $${squad.cost.toFixed(2).padStart(6)} ${colors.dim}${tokensK.padStart(6)}k${RESET} ${modelMix}`);
    }

    if (costs.bySquad.length > maxSquads) {
      writeLine(`  ${colors.dim}+${costs.bySquad.length - maxSquads} more${RESET}`);
    }
    writeLine();
  }
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
