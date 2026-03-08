/**
 * Intelligence layer — turns raw outcome data into executive-grade insights.
 *
 * This is the enterprise value: less technical users see plain-language
 * summaries, ROI calculations, trends, and actionable recommendations
 * instead of raw merge rates and CI percentages.
 */

import {
  computeAllScorecards,
  getOutcomeRecords,
  type AgentScorecard,
  type OutcomeRecord,
} from './outcomes.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ExecutiveInsight {
  type: 'highlight' | 'warning' | 'recommendation' | 'trend';
  title: string;
  detail: string;
  squad?: string;
  agent?: string;
  metric?: string;
  value?: number;
}

export interface WorkforceSummary {
  period: '7d' | '30d';
  totalExecutions: number;
  totalCostUsd: number;
  issuesResolved: number;
  prsMerged: number;
  estimatedHoursSaved: number;
  estimatedValueUsd: number;
  roiMultiplier: number;
  overallMergeRate: number;
  overallWasteRate: number;
  topPerformer: { name: string; mergeRate: number } | null;
  underperformer: { name: string; reason: string } | null;
  insights: ExecutiveInsight[];
}

// ── Constants ────────────────────────────────────────────────────────

// Configurable via env vars — enterprise customers set their own values
const HOURS_PER_ISSUE_RESOLVED = parseFloat(process.env.SQUADS_HOURS_PER_ISSUE || '4');
const HOURS_PER_PR_MERGED = parseFloat(process.env.SQUADS_HOURS_PER_PR || '2');
const HOURLY_RATE = parseFloat(process.env.SQUADS_HOURLY_RATE || '75');

// ── Core ─────────────────────────────────────────────────────────────

/**
 * Generate a full workforce summary with insights.
 * This is what enterprise dashboards and executive reports consume.
 */
export function generateWorkforceSummary(period: '7d' | '30d' = '7d'): WorkforceSummary {
  const scorecards = computeAllScorecards(period);
  const records = getOutcomeRecords();
  const periodMs = period === '7d' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - periodMs;

  const periodRecords = records.filter(
    r => new Date(r.completedAt).getTime() > cutoff,
  );

  // Aggregate metrics
  const totalExecutions = periodRecords.length;
  const totalCostUsd = periodRecords.reduce((sum, r) => sum + r.costUsd, 0);
  const issuesResolved = periodRecords.reduce((sum, r) => sum + r.outcomes.issuesClosed, 0);
  const prsMerged = periodRecords.reduce((sum, r) => sum + r.outcomes.prsMerged, 0);

  // ROI calculation
  const estimatedHoursSaved =
    (issuesResolved * HOURS_PER_ISSUE_RESOLVED) +
    (prsMerged * HOURS_PER_PR_MERGED);
  const estimatedValueUsd = estimatedHoursSaved * HOURLY_RATE;
  const roiMultiplier = totalCostUsd > 0 ? estimatedValueUsd / totalCostUsd : 0;

  // Aggregate rates
  const totalPRs = periodRecords.reduce((sum, r) => sum + r.artifacts.prsCreated.length, 0);
  const overallMergeRate = totalPRs > 0 ? prsMerged / totalPRs : 0;

  const wasteRuns = periodRecords.filter(
    r => r.artifacts.prsCreated.length === 0 &&
         r.artifacts.issuesCreated.length === 0 &&
         r.artifacts.commits === 0,
  ).length;
  const overallWasteRate = totalExecutions > 0 ? wasteRuns / totalExecutions : 0;

  // Find top performer and underperformer
  const withData = scorecards.filter(s => s.executions >= 2);
  const topPerformer = findTopPerformer(withData);
  const underperformer = findUnderperformer(withData);

  // Generate insights
  const insights = generateInsights(scorecards, periodRecords, {
    totalCostUsd,
    issuesResolved,
    prsMerged,
    overallMergeRate,
    overallWasteRate,
    roiMultiplier,
    estimatedHoursSaved,
  });

  return {
    period,
    totalExecutions,
    totalCostUsd,
    issuesResolved,
    prsMerged,
    estimatedHoursSaved,
    estimatedValueUsd,
    roiMultiplier,
    overallMergeRate,
    overallWasteRate,
    topPerformer,
    underperformer,
    insights,
  };
}

// ── Insight generation ───────────────────────────────────────────────

function findTopPerformer(cards: AgentScorecard[]): { name: string; mergeRate: number } | null {
  if (cards.length === 0) return null;

  // Score by weighted composite: merge rate + resolution rate - waste rate
  const scored = cards.map(c => ({
    name: `${c.squad}/${c.agent}`,
    mergeRate: c.mergeRate,
    composite: (c.mergeRate * 0.4) + (c.issueResolutionRate * 0.4) - (c.wasteRate * 0.2),
  }));

  scored.sort((a, b) => b.composite - a.composite);
  return scored[0] ? { name: scored[0].name, mergeRate: scored[0].mergeRate } : null;
}

function findUnderperformer(cards: AgentScorecard[]): { name: string; reason: string } | null {
  if (cards.length === 0) return null;

  for (const c of cards) {
    if (c.wasteRate > 0.5) {
      return {
        name: `${c.squad}/${c.agent}`,
        reason: `${Math.round(c.wasteRate * 100)}% of runs produce no output`,
      };
    }
    if (c.mergeRate < 0.2 && c.executions >= 3) {
      return {
        name: `${c.squad}/${c.agent}`,
        reason: `Only ${Math.round(c.mergeRate * 100)}% of PRs get merged`,
      };
    }
    if (c.costPerOutcome > 5) {
      return {
        name: `${c.squad}/${c.agent}`,
        reason: `$${c.costPerOutcome.toFixed(2)} per outcome — most expensive agent`,
      };
    }
  }

  return null;
}

interface AggregateMetrics {
  totalCostUsd: number;
  issuesResolved: number;
  prsMerged: number;
  overallMergeRate: number;
  overallWasteRate: number;
  roiMultiplier: number;
  estimatedHoursSaved: number;
}

function generateInsights(
  scorecards: AgentScorecard[],
  records: OutcomeRecord[],
  metrics: AggregateMetrics,
): ExecutiveInsight[] {
  const insights: ExecutiveInsight[] = [];

  // ROI insight
  if (metrics.roiMultiplier > 0) {
    if (metrics.roiMultiplier >= 3) {
      insights.push({
        type: 'highlight',
        title: 'Strong ROI',
        detail: `Your AI workforce delivered ${metrics.roiMultiplier.toFixed(1)}x return — $${metrics.totalCostUsd.toFixed(2)} spent, ~$${(metrics.estimatedHoursSaved * HOURLY_RATE).toFixed(0)} in estimated engineering time saved.`,
        metric: 'roi',
        value: metrics.roiMultiplier,
      });
    } else if (metrics.roiMultiplier >= 1) {
      insights.push({
        type: 'highlight',
        title: 'Positive ROI',
        detail: `AI workforce is paying for itself at ${metrics.roiMultiplier.toFixed(1)}x. ${metrics.estimatedHoursSaved.toFixed(0)} engineering hours saved.`,
        metric: 'roi',
        value: metrics.roiMultiplier,
      });
    } else if (metrics.totalCostUsd > 0) {
      insights.push({
        type: 'warning',
        title: 'ROI below breakeven',
        detail: `Currently at ${metrics.roiMultiplier.toFixed(1)}x — spending more than the estimated value of output. Review agent effectiveness.`,
        metric: 'roi',
        value: metrics.roiMultiplier,
      });
    }
  }

  // Productivity highlights
  if (metrics.issuesResolved > 0 || metrics.prsMerged > 0) {
    insights.push({
      type: 'highlight',
      title: 'Work delivered',
      detail: `${metrics.issuesResolved} issue${metrics.issuesResolved !== 1 ? 's' : ''} resolved, ${metrics.prsMerged} PR${metrics.prsMerged !== 1 ? 's' : ''} merged — equivalent to ~${metrics.estimatedHoursSaved.toFixed(0)} hours of engineering work.`,
      metric: 'productivity',
    });
  }

  // Waste warning
  if (metrics.overallWasteRate > 0.3 && records.length >= 3) {
    insights.push({
      type: 'warning',
      title: 'High waste rate',
      detail: `${Math.round(metrics.overallWasteRate * 100)}% of agent runs produce no output. Review agent prompts, issue quality, or available context.`,
      metric: 'waste',
      value: metrics.overallWasteRate,
    });
  }

  // Per-agent insights
  for (const card of scorecards) {
    if (card.executions < 3) continue;

    // Star performer
    if (card.mergeRate > 0.8 && card.wasteRate < 0.1) {
      insights.push({
        type: 'highlight',
        title: `${card.squad}/${card.agent} is a star`,
        detail: `${Math.round(card.mergeRate * 100)}% merge rate with only ${Math.round(card.wasteRate * 100)}% waste across ${card.executions} runs.`,
        squad: card.squad,
        agent: card.agent,
        metric: 'performance',
      });
    }

    // Struggling agent
    if (card.wasteRate > 0.5) {
      insights.push({
        type: 'recommendation',
        title: `Review ${card.squad}/${card.agent}`,
        detail: `${Math.round(card.wasteRate * 100)}% waste rate. Consider: improving agent prompt, adding more context, or pausing this agent until issues are better-scoped.`,
        squad: card.squad,
        agent: card.agent,
        metric: 'waste',
      });
    }

    // Low merge rate with enough data
    if (card.mergeRate < 0.3 && card.executions >= 5) {
      insights.push({
        type: 'recommendation',
        title: `${card.squad}/${card.agent} PRs rarely merge`,
        detail: `Only ${Math.round(card.mergeRate * 100)}% merge rate. PRs may need better scoping, testing, or review workflow adjustments.`,
        squad: card.squad,
        agent: card.agent,
        metric: 'merge_rate',
      });
    }

    // CI failures
    if (card.ciPassRate < 0.5 && card.executions >= 3) {
      insights.push({
        type: 'recommendation',
        title: `${card.squad}/${card.agent} CI issues`,
        detail: `Only ${Math.round(card.ciPassRate * 100)}% of PRs pass CI on first push. Agent may need build/test context in its prompt.`,
        squad: card.squad,
        agent: card.agent,
        metric: 'ci_pass_rate',
      });
    }
  }

  // No data yet
  if (records.length === 0) {
    insights.push({
      type: 'recommendation',
      title: 'Start tracking',
      detail: 'No outcome data yet. Run the daemon to start tracking agent productivity automatically.',
    });
  } else if (records.length < 5) {
    insights.push({
      type: 'recommendation',
      title: 'Building baseline',
      detail: `${records.length} execution${records.length !== 1 ? 's' : ''} tracked so far. Insights improve with more data — 10+ executions recommended for reliable patterns.`,
    });
  }

  return insights;
}

/**
 * Generate a one-paragraph executive summary.
 * This is the "surprise" for less technical users — plain English.
 */
export function generateExecutiveSummary(period: '7d' | '30d' = '7d'): string {
  const summary = generateWorkforceSummary(period);
  const periodLabel = period === '7d' ? 'this week' : 'this month';

  if (summary.totalExecutions === 0) {
    return `No AI workforce activity ${periodLabel}. Start the daemon to begin autonomous operations.`;
  }

  const parts: string[] = [];

  // Activity
  parts.push(
    `Your AI workforce ran ${summary.totalExecutions} time${summary.totalExecutions !== 1 ? 's' : ''} ${periodLabel}`,
  );

  // Output
  if (summary.issuesResolved > 0 || summary.prsMerged > 0) {
    const outputs: string[] = [];
    if (summary.issuesResolved > 0) outputs.push(`${summary.issuesResolved} issue${summary.issuesResolved !== 1 ? 's' : ''}`);
    if (summary.prsMerged > 0) outputs.push(`${summary.prsMerged} PR${summary.prsMerged !== 1 ? 's' : ''}`);
    parts.push(`delivering ${outputs.join(' and ')}`);
  }

  // Cost and ROI
  parts.push(`at a cost of $${summary.totalCostUsd.toFixed(2)}`);

  if (summary.roiMultiplier > 0) {
    parts.push(
      `— an estimated ${summary.roiMultiplier.toFixed(1)}x return on investment (${summary.estimatedHoursSaved.toFixed(0)} engineering hours saved)`,
    );
  }

  let text = parts.join(', ').replace(/, —/, ' —') + '.';

  // Top performer callout
  if (summary.topPerformer) {
    text += ` Top performer: ${summary.topPerformer.name} (${Math.round(summary.topPerformer.mergeRate * 100)}% merge rate).`;
  }

  // Issue callout
  if (summary.underperformer) {
    text += ` Needs attention: ${summary.underperformer.name} — ${summary.underperformer.reason}.`;
  }

  return text;
}
