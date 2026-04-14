/**
 * squads log — run history with timestamps, duration, status, and cost
 *
 * Reads from .agents/observability/executions.jsonl (local, no server required).
 * Gives returning users immediate visibility into what ran and whether it worked.
 */

import { track, Events } from '../lib/telemetry.js';
import { queryExecutions } from '../lib/observability.js';
import { formatDuration } from '../lib/executions.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  writeLine,
  icons,
} from '../lib/terminal.js';

interface LogOptions {
  squad?: string;
  agent?: string;
  limit?: number;
  since?: string;
  json?: boolean;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatCost(usd: number): string {
  if (!usd || usd === 0) return '—';
  if (usd < 0.01) return `$${(usd * 100).toFixed(2)}¢`;
  return `$${usd.toFixed(3)}`;
}

export async function logCommand(options: LogOptions = {}): Promise<void> {
  await track(Events.CLI_LOG, { squad: options.squad, limit: options.limit });

  const records = queryExecutions({
    squad: options.squad,
    agent: options.agent,
    since: options.since,
    limit: options.limit || 20,
  });

  if (options.json) {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}log${RESET}${options.squad ? ` ${colors.cyan}${options.squad}${RESET}` : ''}`);
  writeLine();

  if (records.length === 0) {
    writeLine(`  ${colors.dim}No runs found${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Runs are logged after executing agents:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}<squad>${RESET}`);
    writeLine();
    return;
  }

  // Column widths
  const w = { ts: 17, agent: 28, duration: 10, status: 12, cost: 8 };
  const tableWidth = w.ts + w.agent + w.duration + w.status + w.cost + 6;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('TIMESTAMP', w.ts)}${RESET}` +
    `${bold}${padEnd('SQUAD/AGENT', w.agent)}${RESET}` +
    `${bold}${padEnd('DURATION', w.duration)}${RESET}` +
    `${bold}${padEnd('STATUS', w.status)}${RESET}` +
    `${bold}COST${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const r of records) {
    const agentLabel = `${r.squad}/${r.agent}`;
    const truncatedAgent = agentLabel.length > w.agent - 1
      ? agentLabel.slice(0, w.agent - 4) + '...'
      : agentLabel;

    let statusIcon: string;
    let statusColor: string;

    if (r.status === 'completed') {
      statusIcon = icons.success;
      statusColor = colors.green;
    } else if (r.status === 'failed') {
      statusIcon = icons.error;
      statusColor = colors.red;
    } else {
      statusIcon = icons.warning;
      statusColor = colors.yellow;
    }

    const statusStr = `${statusColor}${statusIcon} ${r.status}${RESET}`;
    const durationStr = formatDuration(r.duration_ms);
    const tsStr = formatTimestamp(r.ts);
    const costStr = formatCost(r.cost_usd);

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.dim}${padEnd(tsStr, w.ts)}${RESET}` +
      `${colors.cyan}${padEnd(truncatedAgent, w.agent)}${RESET}` +
      `${padEnd(durationStr, w.duration)}` +
      `${padEnd(statusStr, w.status + 10)}` +  // +10 for ANSI escape codes
      `${colors.dim}${costStr}${RESET}` +
      ` ${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Summary line
  const completed = records.filter(r => r.status === 'completed').length;
  const failed = records.filter(r => r.status === 'failed').length;
  const totalCost = records.reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  const parts: string[] = [];
  if (completed > 0) parts.push(`${colors.green}${completed} completed${RESET}`);
  if (failed > 0) parts.push(`${colors.red}${failed} failed${RESET}`);
  if (totalCost > 0) parts.push(`${colors.dim}${formatCost(totalCost)} total${RESET}`);

  if (parts.length > 0) {
    writeLine(`  ${parts.join(` ${colors.dim}|${RESET} `)}`);
    writeLine();
  }

  if (records.length >= (options.limit || 20)) {
    writeLine(`  ${colors.dim}Showing ${records.length} most recent. Use --limit to see more.${RESET}`);
    writeLine();
  }

  writeLine(`  ${colors.dim}$${RESET} squads log --squad ${colors.cyan}<name>${RESET}   ${colors.dim}Filter by squad${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads log --since ${colors.cyan}7d${RESET}        ${colors.dim}Filter by date${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads log --json           ${colors.dim}JSON output${RESET}`);
  writeLine();
}
