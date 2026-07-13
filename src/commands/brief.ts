/**
 * squads brief — morning catchup: delivered work, pending approvals, active agents.
 */

import { Command } from 'commander';
import { loadSession, isLoggedIn } from '../lib/auth.js';
import { getApiUrl } from '../lib/env-config.js';
import type { DashboardSummary, ActivityItem } from '../client/types.gen.js';
import { bold, colors, RESET, writeLine, dim } from '../lib/terminal.js';

interface BriefOptions {
  json?: boolean;
}

/**
 * Fetch dashboard summary from the API.
 * Returns null if not authenticated or API is unavailable.
 */
async function fetchBrief(): Promise<DashboardSummary | null> {
  const session = loadSession();
  if (!session?.accessToken || session.status !== 'active') return null;

  const apiUrl = getApiUrl();
  if (!apiUrl) return null;

  try {
    const response = await fetch(`${apiUrl}/api/dashboard/summary`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.accessToken}`,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) return null;
    return await response.json() as DashboardSummary;
  } catch {
    return null;
  }
}

interface FormattedBrief {
  delivered: ActivityItem[];
  needsYou: ActivityItem[];
  pending: ActivityItem[];
  summary: {
    squadsActive: number;
    squadsTotal: number;
    runningAgents: number;
    costToday: number;
  };
}

/**
 * Structure the raw dashboard data into sections:
 * - Delivered: completed activity in the last 24 hours
 * - Needs you: pending approvals (shown first)
 * - Pending: running agents and tasks today
 */
function formatBrief(data: DashboardSummary): FormattedBrief {
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const delivered: ActivityItem[] = [];
  const needsYou: ActivityItem[] = [];
  const pending: ActivityItem[] = [];

  for (const activity of data.recent_activity) {
    const timestamp = new Date(activity.timestamp);

    if (activity.type === 'approval' && activity.status === 'pending') {
      needsYou.push(activity);
    } else if (timestamp >= oneDayAgo && activity.status === 'completed') {
      delivered.push(activity);
    } else if (activity.status === 'running' || activity.status === 'pending') {
      pending.push(activity);
    }
  }

  return {
    delivered,
    needsYou,
    pending,
    summary: {
      squadsActive: data.squads_active,
      squadsTotal: data.squads_total,
      runningAgents: data.running_agents,
      costToday: data.cost_today_usd,
    },
  };
}

/**
 * Render the brief as colored CLI output.
 */
function renderBrief(formatted: FormattedBrief): void {
  writeLine();
  writeLine(`  ${bold}Morning catch-up${RESET}`);
  writeLine();

  // Needs you (pending approvals) — shown first
  if (formatted.needsYou.length > 0) {
    writeLine(`  ${bold}${colors.yellow}Needs you${RESET} ${dim}(${formatted.needsYou.length} pending approval)${RESET}`);
    writeLine();
    for (const item of formatted.needsYou.slice(0, 5)) {
      const squad = item.squad ? `${colors.cyan}[${item.squad}]${RESET} ` : '';
      const agent = item.agent ? `${colors.white}${item.agent}${RESET} ` : '';
      writeLine(`    ${squad}${agent}${item.title}`);
    }
    if (formatted.needsYou.length > 5) {
      writeLine(`    ${dim}... and ${formatted.needsYou.length - 5} more${RESET}`);
    }
    writeLine();
  }

  // Delivered (completed last 24h)
  if (formatted.delivered.length > 0) {
    writeLine(`  ${bold}${colors.green}Delivered${RESET} ${dim}(${formatted.delivered.length} completed last 24h)${RESET}`);
    writeLine();
    for (const item of formatted.delivered.slice(0, 5)) {
      const squad = item.squad ? `${colors.cyan}[${item.squad}]${RESET} ` : '';
      const agent = item.agent ? `${colors.white}${item.agent}${RESET} ` : '';
      writeLine(`    ${squad}${agent}${item.title}`);
    }
    if (formatted.delivered.length > 5) {
      writeLine(`    ${dim}... and ${formatted.delivered.length - 5} more${RESET}`);
    }
    writeLine();
  }

  // Pending (running agents + tasks today)
  if (formatted.pending.length > 0) {
    writeLine(`  ${bold}${colors.cyan}Pending${RESET} ${dim}(${formatted.pending.length} in progress)${RESET}`);
    writeLine();
    for (const item of formatted.pending.slice(0, 5)) {
      const squad = item.squad ? `${colors.cyan}[${item.squad}]${RESET} ` : '';
      const agent = item.agent ? `${colors.white}${item.agent}${RESET} ` : '';
      const status = item.status ? `${dim}(${item.status})${RESET} ` : '';
      writeLine(`    ${squad}${agent}${status}${item.title}`);
    }
    if (formatted.pending.length > 5) {
      writeLine(`    ${dim}... and ${formatted.pending.length - 5} more${RESET}`);
    }
    writeLine();
  }

  // Summary footer
  writeLine(`  ${dim}${formatted.summary.squadsActive}/${formatted.summary.squadsTotal} squads active${RESET}  ${dim}│${RESET}  ${dim}${formatted.summary.runningAgents} agents running${RESET}  ${dim}│${RESET}  ${dim}$${formatted.summary.costToday.toFixed(2)} today${RESET}`);
  writeLine();
}

/**
 * Render JSON output for scripting.
 */
function renderJsonBrief(formatted: FormattedBrief): void {
  console.log(JSON.stringify(formatted, null, 2));
}

/**
 * Show graceful "not connected" message.
 */
function showNotConnected(): void {
  writeLine();
  writeLine(`  ${colors.yellow}Not connected to squads API${RESET}`);
  writeLine();
  writeLine(`  ${dim}Run ${colors.cyan}squads connect${RESET} to link your CLI and enable the brief command.${RESET}`);
  writeLine();
}

async function briefCommand(options: BriefOptions): Promise<void> {
  // Check if logged in
  if (!isLoggedIn()) {
    showNotConnected();
    return;
  }

  // Fetch from API
  const data = await fetchBrief();
  if (!data) {
    showNotConnected();
    return;
  }

  // Format and render
  const formatted = formatBrief(data);

  if (options.json) {
    renderJsonBrief(formatted);
  } else {
    renderBrief(formatted);
  }
}

export { briefCommand };

export function registerBriefCommand(program: Command): void {
  program
    .command('brief')
    .description('Morning catch-up: delivered work, pending approvals, active agents')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      await briefCommand({ json: !!options.json });
    });
}
