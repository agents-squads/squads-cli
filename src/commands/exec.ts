/**
 * squads exec - Execution history commands
 *
 * Enables agents to introspect past executions for self-improvement.
 * Part of RFC #110 Phase 2.
 */

import { track, Events } from '../lib/telemetry.js';
import {
  listExecutions,
  getExecutionStats,
  formatDuration,
  formatRelativeTime,
  Execution,
  ExecutionListOptions,
} from '../lib/executions.js';
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

interface ListOptions {
  squad?: string;
  agent?: string;
  status?: string;
  limit?: number;
  json?: boolean;
}

interface ShowOptions {
  json?: boolean;
}

/**
 * squads exec list - List recent executions
 */
export async function execListCommand(options: ListOptions = {}): Promise<void> {
  await track(Events.CLI_EXEC, { action: 'list', squad: options.squad });

  const listOptions: ExecutionListOptions = {
    squad: options.squad,
    agent: options.agent,
    limit: options.limit || 20,
  };

  if (options.status) {
    listOptions.status = options.status as Execution['status'];
  }

  const executions = listExecutions(listOptions);

  if (options.json) {
    console.log(JSON.stringify(executions, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}exec list${RESET}${options.squad ? ` ${colors.cyan}${options.squad}${RESET}` : ''}`);
  writeLine();

  if (executions.length === 0) {
    writeLine(`  ${colors.dim}No executions found${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Executions are logged when running agents:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}<squad>${RESET} --execute`);
    writeLine();
    return;
  }

  // Table header
  const w = { agent: 22, status: 12, duration: 10, time: 14, id: 18 };
  const tableWidth = w.agent + w.status + w.duration + w.time + w.id + 8;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('AGENT', w.agent)}${RESET}` +
    `${bold}${padEnd('STATUS', w.status)}${RESET}` +
    `${bold}${padEnd('DURATION', w.duration)}${RESET}` +
    `${bold}${padEnd('TIME', w.time)}${RESET}` +
    `${bold}ID${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const exec of executions) {
    const agentName = `${exec.squad}/${exec.agent}`;
    const truncatedAgent = agentName.length > w.agent - 1
      ? agentName.slice(0, w.agent - 4) + '...'
      : agentName;

    const statusIcon = exec.status === 'running' ? icons.running :
                       exec.status === 'completed' ? icons.success : icons.error;
    const statusColor = exec.status === 'running' ? colors.yellow :
                        exec.status === 'completed' ? colors.green : colors.red;

    const statusStr = `${statusColor}${statusIcon} ${exec.status}${RESET}`;
    const durationStr = formatDuration(exec.durationMs);
    const timeStr = formatRelativeTime(exec.startTime);
    const shortId = exec.id.slice(0, 16);

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(truncatedAgent, w.agent)}${RESET}` +
      `${padEnd(statusStr, w.status + 10)}` +  // +10 for ANSI codes
      `${padEnd(durationStr, w.duration)}` +
      `${colors.dim}${padEnd(timeStr, w.time)}${RESET}` +
      `${colors.dim}${shortId}${RESET}` +
      ` ${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Show stats summary
  const stats = getExecutionStats(listOptions);
  const parts: string[] = [];
  if (stats.running > 0) parts.push(`${colors.yellow}${stats.running} running${RESET}`);
  if (stats.completed > 0) parts.push(`${colors.green}${stats.completed} completed${RESET}`);
  if (stats.failed > 0) parts.push(`${colors.red}${stats.failed} failed${RESET}`);

  if (parts.length > 0) {
    writeLine(`  ${parts.join(` ${colors.dim}|${RESET} `)}`);
    if (stats.avgDurationMs) {
      writeLine(`  ${colors.dim}Avg duration: ${formatDuration(stats.avgDurationMs)}${RESET}`);
    }
    writeLine();
  }

  // Show commands
  writeLine(`  ${colors.dim}$${RESET} squads exec show ${colors.cyan}<id>${RESET}    ${colors.dim}Execution details${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads exec --json       ${colors.dim}JSON output${RESET}`);
  writeLine();
}

/**
 * squads exec show <id> - Show execution details
 */
export async function execShowCommand(executionId: string, options: ShowOptions = {}): Promise<void> {
  await track(Events.CLI_EXEC, { action: 'show', id: executionId });

  // Support partial ID matching
  const executions = listExecutions();
  const matches = executions.filter(e =>
    e.id === executionId || e.id.startsWith(executionId)
  );

  if (matches.length === 0) {
    writeLine();
    writeLine(`  ${colors.red}Execution not found: ${executionId}${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}List recent executions:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads exec list`);
    writeLine();
    return;
  }

  if (matches.length > 1) {
    writeLine();
    writeLine(`  ${colors.yellow}Multiple matches for "${executionId}":${RESET}`);
    for (const m of matches.slice(0, 5)) {
      writeLine(`  ${colors.dim}${m.id}${RESET} - ${m.squad}/${m.agent}`);
    }
    writeLine();
    writeLine(`  ${colors.dim}Provide a more specific ID${RESET}`);
    writeLine();
    return;
  }

  const exec = matches[0];

  if (options.json) {
    console.log(JSON.stringify(exec, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}exec show${RESET}`);
  writeLine();

  // Header
  writeLine(`  ${bold}${exec.squad}/${exec.agent}${RESET}`);
  writeLine(`  ${colors.dim}${exec.id}${RESET}`);
  writeLine();

  // Status with icon
  const statusIcon = exec.status === 'running' ? icons.running :
                     exec.status === 'completed' ? icons.success : icons.error;
  const statusColor = exec.status === 'running' ? colors.yellow :
                      exec.status === 'completed' ? colors.green : colors.red;

  writeLine(`  ${bold}Status${RESET}      ${statusColor}${statusIcon} ${exec.status}${RESET}`);
  writeLine(`  ${bold}Task Type${RESET}   ${exec.taskType}`);
  writeLine(`  ${bold}Trigger${RESET}     ${exec.trigger}`);
  writeLine();

  // Timing
  writeLine(`  ${bold}Started${RESET}     ${exec.startTime}`);
  if (exec.endTime) {
    writeLine(`  ${bold}Completed${RESET}   ${exec.endTime}`);
  }
  if (exec.durationMs) {
    writeLine(`  ${bold}Duration${RESET}    ${formatDuration(exec.durationMs)}`);
  }
  writeLine();

  // Outcome/Error
  if (exec.outcome) {
    writeLine(`  ${bold}Outcome${RESET}`);
    writeLine(`  ${colors.dim}${exec.outcome}${RESET}`);
    writeLine();
  }

  if (exec.error) {
    writeLine(`  ${bold}Error${RESET}`);
    writeLine(`  ${colors.red}${exec.error}${RESET}`);
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads memory show ${colors.cyan}${exec.squad}${RESET}   ${colors.dim}Squad memory${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads exec list --squad ${colors.cyan}${exec.squad}${RESET}   ${colors.dim}Squad history${RESET}`);
  writeLine();
}

/**
 * squads exec stats - Show execution statistics
 */
export async function execStatsCommand(options: ListOptions = {}): Promise<void> {
  await track(Events.CLI_EXEC, { action: 'stats', squad: options.squad });

  const listOptions: ExecutionListOptions = {
    squad: options.squad,
  };

  const stats = getExecutionStats(listOptions);

  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}exec stats${RESET}${options.squad ? ` ${colors.cyan}${options.squad}${RESET}` : ''}`);
  writeLine();

  writeLine(`  ${bold}Total${RESET}       ${stats.total}`);
  writeLine(`  ${colors.yellow}Running${RESET}     ${stats.running}`);
  writeLine(`  ${colors.green}Completed${RESET}   ${stats.completed}`);
  writeLine(`  ${colors.red}Failed${RESET}      ${stats.failed}`);
  writeLine();

  if (stats.avgDurationMs) {
    writeLine(`  ${bold}Avg Duration${RESET}  ${formatDuration(stats.avgDurationMs)}`);
    writeLine();
  }

  // Top squads by execution count
  const squadEntries = Object.entries(stats.bySquad).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (squadEntries.length > 0) {
    writeLine(`  ${bold}By Squad${RESET}`);
    for (const [squad, count] of squadEntries) {
      writeLine(`  ${colors.cyan}${squad}${RESET}: ${count}`);
    }
    writeLine();
  }

  // Top agents by execution count
  const agentEntries = Object.entries(stats.byAgent).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (agentEntries.length > 0) {
    writeLine(`  ${bold}Top Agents${RESET}`);
    for (const [agent, count] of agentEntries) {
      writeLine(`  ${colors.cyan}${agent}${RESET}: ${count}`);
    }
    writeLine();
  }
}
