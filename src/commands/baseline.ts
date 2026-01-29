/**
 * squads baseline - Capture and compare ROI baselines
 *
 * Usage:
 *   squads baseline                    # Capture new baseline with auto-generated name
 *   squads baseline --name "Q1 start"  # Capture with custom name
 *   squads baseline list               # List all baselines
 *   squads baseline compare [name]     # Compare current metrics to baseline
 */

import { findSquadsDir, listSquads, loadSquad } from '../lib/squad-parser.js';
import { fetchCostSummary, fetchBridgeStats } from '../lib/costs.js';
import { saveBaseline, getLatestBaseline, getBaselineByName, listBaselines, isDatabaseAvailable, BaselineSnapshot } from '../lib/db.js';
import { getMultiRepoGitStats, getGitHubStatsOptimized } from '../lib/git.js';
import { track, Events } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
  padEnd,
  box,
  progressBar,
} from '../lib/terminal.js';
import { existsSync } from 'fs';
import { join } from 'path';

export interface BaselineOptions {
  name?: string;
  compare?: boolean;
  list?: boolean;
}

// Find agents-squads base directory
function findAgentsSquadsDir(): string | null {
  const parentDir = join(process.cwd(), '..');
  if (existsSync(join(parentDir, 'hq'))) {
    return parentDir;
  }
  if (existsSync(join(process.cwd(), '.git'))) {
    return process.cwd();
  }
  return null;
}

/**
 * Capture current metrics for baseline
 */
async function captureCurrentMetrics(baseDir: string | null, squadsDir: string): Promise<{
  costUsd: number;
  goalsCompleted: number;
  goalsActive: number;
  commits: number;
  prsMerged: number;
  issuesClosed: number;
  inputTokens: number;
  outputTokens: number;
  squadMetrics: Array<{ squad: string; costUsd: number; goals: number; commits: number; prs: number }>;
}> {
  // Fetch all data in parallel
  const [costs, bridgeStats, gitStats, ghStats] = await Promise.all([
    fetchCostSummary(100),
    fetchBridgeStats(),
    baseDir ? getMultiRepoGitStats(baseDir, 30) : Promise.resolve(null),
    baseDir ? getGitHubStatsOptimized(baseDir, 30) : Promise.resolve(null),
  ]);

  // Calculate goals from squads
  const squadNames = listSquads(squadsDir);
  let goalsCompleted = 0;
  let goalsActive = 0;
  const squadMetrics: Array<{ squad: string; costUsd: number; goals: number; commits: number; prs: number }> = [];

  for (const name of squadNames) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const completed = squad.goals.filter(g => g.completed).length;
    const active = squad.goals.filter(g => !g.completed).length;
    goalsCompleted += completed;
    goalsActive += active;

    // Get squad-specific costs from bridge stats
    const squadCost = bridgeStats?.bySquad.find(s => s.squad === name)?.costUsd || 0;
    const squadGhStats = ghStats?.bySquad.get(name);

    squadMetrics.push({
      squad: name,
      costUsd: squadCost,
      goals: active,
      commits: squadGhStats?.commits || 0,
      prs: squadGhStats?.prsMerged || 0,
    });
  }

  return {
    costUsd: costs?.totalCost || 0,
    goalsCompleted,
    goalsActive,
    commits: gitStats?.totalCommits || 0,
    prsMerged: ghStats?.prsMerged || 0,
    issuesClosed: ghStats?.issuesClosed || 0,
    inputTokens: costs?.totalInputTokens || 0,
    outputTokens: costs?.bySquad.reduce((sum, s) => sum + s.outputTokens, 0) || 0,
    squadMetrics,
  };
}

/**
 * Capture a new baseline
 */
async function captureBaseline(name: string, squadsDir: string): Promise<void> {
  const baseDir = findAgentsSquadsDir();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}baseline${RESET}`);
  writeLine();
  writeLine(`  ${colors.cyan}Capturing metrics...${RESET}`);

  const metrics = await captureCurrentMetrics(baseDir, squadsDir);

  const baseline: BaselineSnapshot = {
    name,
    capturedAt: new Date().toISOString(),
    ...metrics,
  };

  const id = await saveBaseline(baseline);

  if (id) {
    writeLine();
    writeLine(`  ${colors.green}${icons.success} Baseline saved${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Name:${RESET}          ${colors.cyan}${name}${RESET}`);
    writeLine(`  ${colors.dim}Cost:${RESET}          ${colors.green}$${metrics.costUsd.toFixed(2)}${RESET}`);
    writeLine(`  ${colors.dim}Goals:${RESET}         ${colors.purple}${metrics.goalsActive}${RESET} active, ${colors.green}${metrics.goalsCompleted}${RESET} completed`);
    writeLine(`  ${colors.dim}Commits:${RESET}       ${colors.cyan}${metrics.commits}${RESET}`);
    writeLine(`  ${colors.dim}PRs Merged:${RESET}    ${colors.cyan}${metrics.prsMerged}${RESET}`);
    writeLine(`  ${colors.dim}Input Tokens:${RESET}  ${formatK(metrics.inputTokens)}`);
    writeLine();
    writeLine(`  ${colors.dim}Compare later with:${RESET} squads baseline compare "${name}"`);
  } else {
    writeLine();
    writeLine(`  ${colors.red}${icons.error} Failed to save baseline${RESET}`);
    writeLine(`  ${colors.dim}Ensure database is configured: SQUADS_DATABASE_URL${RESET}`);
  }
  writeLine();
}

/**
 * Compare current metrics to a baseline
 */
async function compareToBaseline(baseline: BaselineSnapshot, squadsDir: string): Promise<void> {
  const baseDir = findAgentsSquadsDir();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}baseline compare${RESET}`);
  writeLine();
  writeLine(`  ${colors.cyan}Comparing to:${RESET} ${baseline.name} ${colors.dim}(${formatDate(baseline.capturedAt)})${RESET}`);
  writeLine();

  const current = await captureCurrentMetrics(baseDir, squadsDir);

  // Calculate deltas
  const costDelta = current.costUsd - baseline.costUsd;
  const goalsDelta = current.goalsCompleted - baseline.goalsCompleted;
  const commitsDelta = current.commits - baseline.commits;
  const prsDelta = current.prsMerged - baseline.prsMerged;
  const tokensDelta = (current.inputTokens + current.outputTokens) - (baseline.inputTokens + baseline.outputTokens);

  // Calculate efficiency metrics
  const costPerGoalBefore = baseline.goalsCompleted > 0 ? baseline.costUsd / baseline.goalsCompleted : 0;
  const costPerGoalAfter = current.goalsCompleted > 0 ? current.costUsd / current.goalsCompleted : 0;
  const efficiencyChange = costPerGoalBefore > 0
    ? ((costPerGoalBefore - costPerGoalAfter) / costPerGoalBefore) * 100
    : 0;

  // Display comparison table
  const w = { metric: 18, before: 12, after: 12, delta: 10 };
  const tableWidth = w.metric + w.before + w.after + w.delta + 6;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('METRIC', w.metric)}${RESET}${bold}${padEnd('BEFORE', w.before)}${RESET}${bold}${padEnd('AFTER', w.after)}${RESET}${bold}DELTA${RESET}     ${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  // Cost row
  const costColor = costDelta > 0 ? colors.red : colors.green;
  const costSign = costDelta >= 0 ? '+' : '';
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Cost', w.metric)}${padEnd('$' + baseline.costUsd.toFixed(2), w.before)}${padEnd('$' + current.costUsd.toFixed(2), w.after)}${costColor}${costSign}$${costDelta.toFixed(2)}${RESET}   ${colors.purple}${box.vertical}${RESET}`);

  // Goals row
  const goalsColor = goalsDelta >= 0 ? colors.green : colors.red;
  const goalsSign = goalsDelta >= 0 ? '+' : '';
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Goals Done', w.metric)}${padEnd(String(baseline.goalsCompleted), w.before)}${padEnd(String(current.goalsCompleted), w.after)}${goalsColor}${goalsSign}${goalsDelta}${RESET}       ${colors.purple}${box.vertical}${RESET}`);

  // Commits row
  const commitsColor = commitsDelta >= 0 ? colors.green : colors.dim;
  const commitsSign = commitsDelta >= 0 ? '+' : '';
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Commits', w.metric)}${padEnd(String(baseline.commits), w.before)}${padEnd(String(current.commits), w.after)}${commitsColor}${commitsSign}${commitsDelta}${RESET}       ${colors.purple}${box.vertical}${RESET}`);

  // PRs row
  const prsColor = prsDelta >= 0 ? colors.green : colors.dim;
  const prsSign = prsDelta >= 0 ? '+' : '';
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('PRs Merged', w.metric)}${padEnd(String(baseline.prsMerged), w.before)}${padEnd(String(current.prsMerged), w.after)}${prsColor}${prsSign}${prsDelta}${RESET}       ${colors.purple}${box.vertical}${RESET}`);

  // Tokens row
  const tokensColor = tokensDelta > 0 ? colors.yellow : colors.green;
  const baselineTokens = baseline.inputTokens + baseline.outputTokens;
  const currentTokens = current.inputTokens + current.outputTokens;
  const tokensDeltaSign = tokensDelta >= 0 ? '+' : '';
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Tokens', w.metric)}${padEnd(formatK(baselineTokens), w.before)}${padEnd(formatK(currentTokens), w.after)}${tokensColor}${tokensDeltaSign}${formatK(tokensDelta)}${RESET}     ${colors.purple}${box.vertical}${RESET}`);

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Efficiency analysis
  writeLine(`  ${bold}Efficiency${RESET}`);
  writeLine();

  if (current.goalsCompleted > 0 && baseline.goalsCompleted > 0) {
    const effColor = efficiencyChange > 0 ? colors.green : efficiencyChange < 0 ? colors.red : colors.dim;
    const effSign = efficiencyChange >= 0 ? '+' : '';
    writeLine(`  ${colors.dim}Cost/Goal:${RESET}     $${costPerGoalBefore.toFixed(2)} -> $${costPerGoalAfter.toFixed(2)} ${effColor}(${effSign}${efficiencyChange.toFixed(0)}% efficiency)${RESET}`);

    // Efficiency bar
    const effPct = Math.min(Math.max(50 + (efficiencyChange / 2), 0), 100);
    writeLine(`  ${colors.dim}Efficiency:${RESET}    ${progressBar(effPct, 20)} ${effPct > 50 ? colors.green : colors.red}${effPct.toFixed(0)}%${RESET}`);
  }

  // ROI estimate
  const GOAL_VALUE = parseFloat(process.env.SQUADS_GOAL_VALUE || '100');
  const PR_VALUE = parseFloat(process.env.SQUADS_PR_VALUE || '200');
  const valueGenerated = (goalsDelta * GOAL_VALUE) + (prsDelta * PR_VALUE);
  const roi = costDelta > 0 ? valueGenerated / costDelta : valueGenerated > 0 ? Infinity : 0;

  writeLine();
  writeLine(`  ${bold}ROI Estimate${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Value generated:${RESET} ${colors.green}$${valueGenerated.toFixed(0)}${RESET} ${colors.dim}(${goalsDelta} goals x $${GOAL_VALUE} + ${prsDelta} PRs x $${PR_VALUE})${RESET}`);
  writeLine(`  ${colors.dim}Cost incurred:${RESET}   ${costDelta >= 0 ? colors.red : colors.green}$${Math.abs(costDelta).toFixed(2)}${RESET}`);

  if (roi !== Infinity && roi > 0) {
    const roiColor = roi >= 1 ? colors.green : colors.yellow;
    writeLine(`  ${colors.dim}ROI multiplier:${RESET}  ${roiColor}${roi.toFixed(1)}x${RESET}`);
  } else if (valueGenerated > 0 && costDelta <= 0) {
    writeLine(`  ${colors.dim}ROI multiplier:${RESET}  ${colors.green}Infinite (value with no cost)${RESET}`);
  }

  writeLine();

  // Summary
  const summary = [];
  if (goalsDelta > 0) summary.push(`${colors.green}+${goalsDelta}${RESET} goals`);
  if (prsDelta > 0) summary.push(`${colors.green}+${prsDelta}${RESET} PRs`);
  if (efficiencyChange > 10) summary.push(`${colors.green}${efficiencyChange.toFixed(0)}%${RESET} more efficient`);
  if (efficiencyChange < -10) summary.push(`${colors.red}${Math.abs(efficiencyChange).toFixed(0)}%${RESET} less efficient`);

  if (summary.length > 0) {
    writeLine(`  ${colors.cyan}Summary:${RESET} ${summary.join(', ')}`);
    writeLine();
  }
}

/**
 * List all baselines
 */
async function listAllBaselines(): Promise<void> {
  const baselines = await listBaselines(10);

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}baselines${RESET}`);
  writeLine();

  if (baselines.length === 0) {
    writeLine(`  ${colors.dim}No baselines captured yet.${RESET}`);
    writeLine(`  ${colors.dim}Create one with:${RESET} squads baseline --name "My baseline"`);
    writeLine();
    return;
  }

  const w = { name: 24, date: 14, cost: 10, goals: 8 };
  const tableWidth = w.name + w.date + w.cost + w.goals + 6;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('NAME', w.name)}${RESET}${bold}${padEnd('DATE', w.date)}${RESET}${bold}${padEnd('COST', w.cost)}${RESET}${bold}GOALS${RESET}   ${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const baseline of baselines) {
    const name = baseline.name.length > w.name - 2 ? baseline.name.slice(0, w.name - 5) + '...' : baseline.name;
    const date = formatDate(baseline.capturedAt);
    const cost = `$${baseline.costUsd.toFixed(2)}`;
    const goals = String(baseline.goalsCompleted);

    writeLine(`  ${colors.purple}${box.vertical}${RESET} ${colors.cyan}${padEnd(name, w.name)}${RESET}${colors.dim}${padEnd(date, w.date)}${RESET}${colors.green}${padEnd(cost, w.cost)}${RESET}${padEnd(goals, w.goals)}${colors.purple}${box.vertical}${RESET}`);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();
  writeLine(`  ${colors.dim}Compare with:${RESET} squads baseline compare [name]`);
  writeLine();
}

// Helper functions
function formatK(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'k';
  return String(n);
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Main baseline command
 */
export async function baselineCommand(subcommand?: string, options: BaselineOptions = {}): Promise<void> {
  await track(Events.CLI_BASELINE, { subcommand, name: options.name });

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`${colors.dim}Run \`squads init\` to create one.${RESET}`);
    return;
  }

  // Check database availability
  const dbAvailable = await isDatabaseAvailable();
  if (!dbAvailable) {
    writeLine();
    writeLine(`  ${colors.red}${icons.error} Database not available${RESET}`);
    writeLine(`  ${colors.dim}Baseline requires PostgreSQL. Configure SQUADS_DATABASE_URL.${RESET}`);
    writeLine();
    return;
  }

  // Handle subcommands
  if (subcommand === 'list' || options.list) {
    await listAllBaselines();
    return;
  }

  if (subcommand === 'compare' || options.compare) {
    const baselineName = options.name || subcommand;
    let baseline: BaselineSnapshot | null;

    if (baselineName && baselineName !== 'compare') {
      baseline = await getBaselineByName(baselineName);
      if (!baseline) {
        writeLine();
        writeLine(`  ${colors.red}${icons.error} Baseline "${baselineName}" not found${RESET}`);
        writeLine(`  ${colors.dim}List available baselines with:${RESET} squads baseline list`);
        writeLine();
        return;
      }
    } else {
      baseline = await getLatestBaseline();
      if (!baseline) {
        writeLine();
        writeLine(`  ${colors.red}${icons.error} No baselines found${RESET}`);
        writeLine(`  ${colors.dim}Create one with:${RESET} squads baseline --name "My baseline"`);
        writeLine();
        return;
      }
    }

    await compareToBaseline(baseline, squadsDir);
    return;
  }

  // Default: capture new baseline
  const name = options.name || `Baseline ${new Date().toISOString().split('T')[0]}`;
  await captureBaseline(name, squadsDir);
}
