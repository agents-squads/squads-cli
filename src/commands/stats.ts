/**
 * squads stats — AI workforce intelligence.
 *
 * Two modes:
 *   squads stats           → executive summary + scorecard table + insights
 *   squads stats --json    → machine-readable for dashboards
 *
 * The intelligence layer turns raw GitHub outcomes into business language:
 * ROI, hours saved, recommendations, trends. This is what enterprise
 * customers see — not merge percentages.
 */

import {
  computeAllScorecards,
} from '../lib/outcomes.js';
import {
  generateWorkforceSummary,
  generateExecutiveSummary,
} from '../lib/insights.js';
import {
  colors,
  bold,
  RESET,
  writeLine,
} from '../lib/terminal.js';

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function padRight(str: string, len: number): string {
  const plain = str.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(0, len - plain.length);
  return str + ' '.repeat(pad);
}

function rateColor(rate: number, goodThreshold: number, badThreshold: number): string {
  if (rate >= goodThreshold) return colors.green;
  if (rate <= badThreshold) return colors.red;
  return colors.yellow;
}

const insightIcons: Record<string, string> = {
  highlight: `${colors.green}*${RESET}`,
  warning: `${colors.yellow}!${RESET}`,
  recommendation: `${colors.cyan}>${RESET}`,
  trend: `${colors.purple}~${RESET}`,
};

export async function statsCommand(options: {
  squad?: string;
  period?: string;
  json?: boolean;
}): Promise<void> {
  const period = (options.period === '30d' ? '30d' : '7d') as '7d' | '30d';
  const summary = generateWorkforceSummary(period);

  // Filter scorecards by squad
  const scorecards = options.squad
    ? computeAllScorecards(period).filter(s => s.squad === options.squad)
    : computeAllScorecards(period);

  if (options.json) {
    writeLine(JSON.stringify({
      executive_summary: generateExecutiveSummary(period),
      ...summary,
      scorecards,
    }, null, 2));
    return;
  }

  const periodLabel = period === '7d' ? 'Last 7 days' : 'Last 30 days';

  writeLine();
  writeLine(`  ${bold}AI Workforce Intelligence${RESET} ${colors.dim}(${periodLabel})${RESET}`);
  writeLine();

  // ── Executive summary ──────────────────────────────────────────────

  const execSummary = generateExecutiveSummary(period);
  writeLine(`  ${execSummary}`);
  writeLine();

  // ── Key metrics ────────────────────────────────────────────────────

  if (summary.totalExecutions > 0) {
    writeLine(`  ${bold}Key Metrics${RESET}`);
    writeLine(`  ${colors.dim}${'─'.repeat(50)}${RESET}`);

    const roiColor = summary.roiMultiplier >= 3 ? colors.green
      : summary.roiMultiplier >= 1 ? colors.yellow
      : colors.red;

    writeLine(`  Executions     ${bold}${summary.totalExecutions}${RESET}`);
    writeLine(`  Issues resolved${bold} ${summary.issuesResolved}${RESET}    PRs merged ${bold}${summary.prsMerged}${RESET}`);
    writeLine(`  Total cost     ${bold}$${summary.totalCostUsd.toFixed(2)}${RESET}`);
    writeLine(`  Hours saved    ${bold}~${summary.estimatedHoursSaved.toFixed(0)}h${RESET} ${colors.dim}(at $${parseFloat(process.env.SQUADS_HOURLY_RATE || '75')}/hr)${RESET}`);
    writeLine(`  ROI            ${roiColor}${bold}${summary.roiMultiplier.toFixed(1)}x${RESET} ${colors.dim}($${summary.estimatedValueUsd.toFixed(0)} estimated value)${RESET}`);
    writeLine();
  }

  // ── Scorecard table ────────────────────────────────────────────────

  if (scorecards.length > 0) {
    writeLine(`  ${bold}Agent Scorecards${RESET}`);
    writeLine(`  ${colors.dim}${'─'.repeat(82)}${RESET}`);

    const header = [
      padRight(`${colors.dim}Squad/Agent${RESET}`, 30),
      padRight(`${colors.dim}Runs${RESET}`, 8),
      padRight(`${colors.dim}Merge${RESET}`, 10),
      padRight(`${colors.dim}Resolve${RESET}`, 10),
      padRight(`${colors.dim}Waste${RESET}`, 10),
      padRight(`${colors.dim}CI${RESET}`, 8),
      `${colors.dim}$/out${RESET}`,
    ].join('');
    writeLine(`  ${header}`);

    for (const card of scorecards) {
      const name = `${card.squad}/${card.agent}`;
      const mergeColor = rateColor(card.mergeRate, 0.7, 0.3);
      const resolveColor = rateColor(card.issueResolutionRate, 0.5, 0.2);
      const wasteColor = rateColor(1 - card.wasteRate, 0.7, 0.5);
      const ciColor = rateColor(card.ciPassRate, 0.8, 0.5);
      const costColor = card.costPerOutcome > 5 ? colors.red : card.costPerOutcome > 3 ? colors.yellow : colors.green;

      const row = [
        padRight(`${colors.cyan}${name}${RESET}`, 30),
        padRight(`${card.executions}`, 8),
        padRight(`${mergeColor}${pct(card.mergeRate)}${RESET}`, 10),
        padRight(`${resolveColor}${pct(card.issueResolutionRate)}${RESET}`, 10),
        padRight(`${wasteColor}${pct(card.wasteRate)}${RESET}`, 10),
        padRight(`${ciColor}${pct(card.ciPassRate)}${RESET}`, 8),
        `${costColor}$${card.costPerOutcome.toFixed(2)}${RESET}`,
      ].join('');

      writeLine(`  ${row}`);
    }
    writeLine();
  }

  // ── Insights ───────────────────────────────────────────────────────

  if (summary.insights.length > 0) {
    writeLine(`  ${bold}Insights${RESET}`);
    writeLine(`  ${colors.dim}${'─'.repeat(50)}${RESET}`);

    for (const insight of summary.insights) {
      const icon = insightIcons[insight.type] || ' ';
      writeLine(`  ${icon} ${bold}${insight.title}${RESET}`);
      writeLine(`    ${colors.dim}${insight.detail}${RESET}`);
    }
    writeLine();
  }
}
