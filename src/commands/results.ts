import { execSync } from 'child_process';
import { findSquadsDir, listSquads, loadSquad, Goal } from '../lib/squad-parser.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  truncate,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface SquadResults {
  name: string;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  issuesClosed: number;
  goals: GoalWithMetrics[];
}

interface GoalWithMetrics {
  description: string;
  metrics: string[];
  progress?: string;
  completed: boolean;
  actual?: Record<string, number | string>;
}

// Get git stats for the past week per squad
function getGitStats(days: number = 7): Map<string, { commits: number; files: string[] }> {
  const stats = new Map<string, { commits: number; files: string[] }>();

  const squadKeywords: Record<string, string[]> = {
    website: ['agents-squads-web', 'website', 'homepage'],
    product: ['squads-cli', 'cli'],
    research: ['research'],
    engineering: ['engineering', '.agents'],
    intelligence: ['intelligence'],
    customer: ['customer'],
    finance: ['finance'],
    company: ['company'],
    marketing: ['marketing'],
  };

  try {
    const logOutput = execSync(
      `git log --since="${days} days ago" --format="%s" --name-only 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!logOutput) return stats;

    const entries = logOutput.split('\n\n');
    for (const entry of entries) {
      const lines = entry.split('\n').filter(l => l.trim());
      if (lines.length === 0) continue;

      const message = lines[0];
      const files = lines.slice(1);
      const msgLower = message.toLowerCase();

      // Detect squad
      let detectedSquad = 'other';
      for (const [squad, keywords] of Object.entries(squadKeywords)) {
        const inMessage = keywords.some(k => msgLower.includes(k));
        const inFiles = files.some(f =>
          keywords.some(k => f.toLowerCase().includes(k))
        );
        if (inMessage || inFiles) {
          detectedSquad = squad;
          break;
        }
      }

      if (!stats.has(detectedSquad)) {
        stats.set(detectedSquad, { commits: 0, files: [] });
      }
      const squadStats = stats.get(detectedSquad)!;
      squadStats.commits++;
      squadStats.files.push(...files);
    }
  } catch {
    // Not in git repo
  }

  return stats;
}

// Get GitHub stats via gh CLI
function getGitHubStats(days: number = 7): {
  prsOpened: Map<string, number>;
  prsMerged: Map<string, number>;
  issuesClosed: Map<string, number>;
} {
  const prsOpened = new Map<string, number>();
  const prsMerged = new Map<string, number>();
  const issuesClosed = new Map<string, number>();

  try {
    // Get PRs opened
    const prsOutput = execSync(
      `gh pr list --state all --json title,createdAt,mergedAt --limit 50 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const prs = JSON.parse(prsOutput || '[]');
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    for (const pr of prs) {
      const created = new Date(pr.createdAt);
      if (created < since) continue;

      const squad = detectSquadFromTitle(pr.title);
      prsOpened.set(squad, (prsOpened.get(squad) || 0) + 1);

      if (pr.mergedAt) {
        prsMerged.set(squad, (prsMerged.get(squad) || 0) + 1);
      }
    }

    // Get issues closed
    const issuesOutput = execSync(
      `gh issue list --state closed --json title,closedAt --limit 50 2>/dev/null`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const issues = JSON.parse(issuesOutput || '[]');

    for (const issue of issues) {
      const closed = new Date(issue.closedAt);
      if (closed < since) continue;

      const squad = detectSquadFromTitle(issue.title);
      issuesClosed.set(squad, (issuesClosed.get(squad) || 0) + 1);
    }
  } catch {
    // gh not available or not in repo
  }

  return { prsOpened, prsMerged, issuesClosed };
}

function detectSquadFromTitle(title: string): string {
  const lower = title.toLowerCase();
  const mapping: Record<string, string[]> = {
    website: ['website', 'web', 'homepage', 'page'],
    product: ['cli', 'squads', 'command'],
    research: ['research', 'report'],
    engineering: ['infra', 'build', 'ci'],
    intelligence: ['intel', 'monitor'],
    customer: ['lead', 'customer'],
    finance: ['cost', 'finance'],
    marketing: ['marketing', 'content'],
  };

  for (const [squad, keywords] of Object.entries(mapping)) {
    if (keywords.some(k => lower.includes(k))) {
      return squad;
    }
  }
  return 'other';
}

// Parse metrics from goal description
function parseMetrics(goal: Goal): string[] {
  const metrics: string[] = [];

  // Check for explicit metrics in goal
  if (goal.metrics && goal.metrics.length > 0) {
    return goal.metrics;
  }

  // Infer from description
  const desc = goal.description.toLowerCase();

  if (desc.includes('revenue')) metrics.push('revenue_usd');
  if (desc.includes('lead')) metrics.push('leads_count');
  if (desc.includes('traffic') || desc.includes('visit')) metrics.push('page_views');
  if (desc.includes('signup') || desc.includes('email')) metrics.push('signups');
  if (desc.includes('cost')) metrics.push('cost_usd');
  if (desc.includes('publish') || desc.includes('launch')) metrics.push('shipped');
  if (desc.includes('demo')) metrics.push('demos_booked');

  return metrics.length > 0 ? metrics : ['progress'];
}

export async function resultsCommand(options: {
  squad?: string;
  days?: string;
  verbose?: boolean;
} = {}): Promise<void> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`${colors.dim}Run \`squads init\` to create one.${RESET}`);
    return;
  }

  const days = parseInt(options.days || '7', 10);

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}results${RESET} ${colors.dim}(${days}d)${RESET}`);
  writeLine();

  const squadNames = options.squad ? [options.squad] : listSquads(squadsDir);
  const gitStats = getGitStats(days);
  const ghStats = getGitHubStats(days);

  const results: SquadResults[] = [];

  for (const name of squadNames) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const git = gitStats.get(name) || { commits: 0, files: [] };
    const activeGoals = squad.goals.filter(g => !g.completed);

    results.push({
      name,
      commits: git.commits,
      prsOpened: ghStats.prsOpened.get(name) || 0,
      prsMerged: ghStats.prsMerged.get(name) || 0,
      issuesClosed: ghStats.issuesClosed.get(name) || 0,
      goals: activeGoals.map(g => ({
        description: g.description,
        metrics: parseMetrics(g),
        progress: g.progress,
        completed: g.completed,
      })),
    });
  }

  // Summary stats
  const totalCommits = results.reduce((sum, r) => sum + r.commits, 0);
  const totalPRs = results.reduce((sum, r) => sum + r.prsMerged, 0);
  const totalGoals = results.reduce((sum, r) => sum + r.goals.length, 0);

  const stats = [
    `${colors.cyan}${totalCommits}${RESET} commits`,
    `${colors.green}${totalPRs}${RESET} PRs merged`,
    `${colors.purple}${totalGoals}${RESET} active goals`,
  ].join(`  ${colors.dim}│${RESET}  `);
  writeLine(`  ${stats}`);
  writeLine();

  // Results table
  const w = { squad: 14, commits: 8, prs: 6, goals: 5, kpi: 20 };
  const tableWidth = w.squad + w.commits + w.prs + w.goals + w.kpi + 8;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.squad)}${RESET}` +
    `${bold}${padEnd('COMMITS', w.commits)}${RESET}` +
    `${bold}${padEnd('PRs', w.prs)}${RESET}` +
    `${bold}${padEnd('GOALS', w.goals)}${RESET}` +
    `${bold}KEY METRIC${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const result of results) {
    const keyMetric = result.goals.length > 0
      ? result.goals[0].metrics[0] || '—'
      : '—';

    const commitColor = result.commits > 0 ? colors.green : colors.dim;
    const prColor = result.prsMerged > 0 ? colors.green : colors.dim;

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(result.name, w.squad)}${RESET}` +
      `${commitColor}${padEnd(String(result.commits), w.commits)}${RESET}` +
      `${prColor}${padEnd(String(result.prsMerged), w.prs)}${RESET}` +
      `${padEnd(String(result.goals.length), w.goals)}` +
      `${colors.dim}${truncate(keyMetric, w.kpi)}${RESET}` +
      ` ${colors.purple}${box.vertical}${RESET}`;
    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Goal details with KPIs
  if (options.verbose || options.squad) {
    writeLine(`  ${bold}Goals & KPIs${RESET}`);
    writeLine();

    for (const result of results) {
      if (result.goals.length === 0) continue;

      writeLine(`  ${colors.cyan}${result.name}${RESET}`);

      for (const goal of result.goals) {
        const statusIcon = goal.progress ? icons.progress : icons.empty;
        writeLine(`  ${statusIcon} ${truncate(goal.description, 55)}`);

        // Show metrics
        if (goal.metrics.length > 0) {
          const metricsStr = goal.metrics.map(m => `${colors.purple}${m}${RESET}`).join(', ');
          writeLine(`    ${colors.dim}metrics:${RESET} ${metricsStr}`);
        }

        // Show progress if any
        if (goal.progress) {
          writeLine(`    ${colors.dim}progress:${RESET} ${colors.green}${goal.progress}${RESET}`);
        }
      }
      writeLine();
    }
  }

  // Help
  writeLine(`  ${colors.dim}$${RESET} squads results ${colors.cyan}<squad>${RESET} -v  ${colors.dim}Detailed squad KPIs${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads goal progress      ${colors.dim}Update goal progress${RESET}`);
  writeLine();
}
