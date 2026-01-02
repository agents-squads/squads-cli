import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findMemoryDir } from '../lib/memory.js';
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

interface TaskEntry {
  id: string;
  squad: string;
  description: string;
  status: 'active' | 'completed' | 'failed';
  startedAt: string;
}

interface ProcessInfo {
  pid: string;
  cpu: string;
  mem: string;
  time: string;
  command: string;
  type: 'claude' | 'agent' | 'hook' | 'dev-server';
}

function getTasksFilePath(): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;
  return join(memoryDir, '..', 'tasks.json');
}

function loadActiveTasks(): TaskEntry[] {
  const tasksPath = getTasksFilePath();
  if (!tasksPath || !existsSync(tasksPath)) return [];

  try {
    const data = JSON.parse(readFileSync(tasksPath, 'utf-8'));
    return data.tasks?.filter((t: TaskEntry) => t.status === 'active') || [];
  } catch {
    return [];
  }
}

function getRunningProcesses(): ProcessInfo[] {
  const processes: ProcessInfo[] = [];

  try {
    // Get Claude and related processes
    const psOutput = execSync(
      'ps aux | grep -E "claude|squads|astro|node.*agent" | grep -v grep',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!psOutput) return processes;

    for (const line of psOutput.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parts[1];
      const cpu = parts[2];
      const mem = parts[3];
      const time = parts[9];
      const command = parts.slice(10).join(' ');

      // Categorize the process
      let type: ProcessInfo['type'] = 'agent';
      if (command.includes('claude')) type = 'claude';
      else if (command.includes('squads')) type = 'hook';
      else if (command.includes('astro')) type = 'dev-server';

      // Skip very short-lived processes
      if (command.includes('grep')) continue;

      processes.push({ pid, cpu, mem, time, command, type });
    }
  } catch {
    // No matching processes
  }

  return processes;
}

function categorizeProcesses(processes: ProcessInfo[]): {
  claude: ProcessInfo[];
  hooks: ProcessInfo[];
  devServers: ProcessInfo[];
  agents: ProcessInfo[];
} {
  return {
    claude: processes.filter(p => p.type === 'claude'),
    hooks: processes.filter(p => p.type === 'hook'),
    devServers: processes.filter(p => p.type === 'dev-server'),
    agents: processes.filter(p => p.type === 'agent'),
  };
}

function formatCommand(cmd: string, maxLen = 45): string {
  // Extract meaningful part of command
  if (cmd.includes('claude')) {
    return truncate('claude (session)', maxLen);
  }
  if (cmd.includes('astro dev')) {
    return truncate('astro dev server', maxLen);
  }
  if (cmd.includes('squads')) {
    const match = cmd.match(/squads\s+(\S+)/);
    return truncate(`squads ${match?.[1] || 'command'}`, maxLen);
  }
  return truncate(cmd, maxLen);
}

export async function workersCommand(options: { verbose?: boolean; kill?: string } = {}): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}workers${RESET}`);
  writeLine();

  // Kill a process if requested
  if (options.kill) {
    try {
      execSync(`kill ${options.kill}`, { stdio: 'pipe' });
      writeLine(`  ${icons.success} Killed process ${colors.cyan}${options.kill}${RESET}`);
      writeLine();
      return;
    } catch {
      writeLine(`  ${icons.error} Failed to kill process ${colors.red}${options.kill}${RESET}`);
      writeLine();
      return;
    }
  }

  const activeTasks = loadActiveTasks();
  const processes = getRunningProcesses();
  const categorized = categorizeProcesses(processes);

  // Summary stats
  const stats = [
    `${colors.cyan}${categorized.claude.length}${RESET} claude`,
    `${colors.green}${activeTasks.length}${RESET} tasks`,
    `${colors.purple}${categorized.devServers.length}${RESET} dev servers`,
  ].join(`  ${colors.dim}│${RESET}  `);
  writeLine(`  ${stats}`);
  writeLine();

  // Claude sessions
  if (categorized.claude.length > 0) {
    writeLine(`  ${bold}Claude Sessions${RESET} ${colors.dim}(terminal tabs)${RESET}`);
    writeLine();

    const w = { pid: 8, cpu: 6, mem: 6, time: 8, cmd: 30 };
    const tableWidth = w.pid + w.cpu + w.mem + w.time + w.cmd + 8;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
    writeLine(`  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('PID', w.pid)}${padEnd('CPU%', w.cpu)}${padEnd('MEM%', w.mem)}${padEnd('TIME', w.time)}${padEnd('STATUS', w.cmd)}${RESET} ${colors.purple}${box.vertical}${RESET}`);
    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const proc of categorized.claude) {
      const cpuColor = parseFloat(proc.cpu) > 50 ? colors.yellow : colors.dim;
      const status = parseFloat(proc.cpu) > 10 ? `${icons.active} active` : `${icons.pending} idle`;

      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(proc.pid, w.pid)}${RESET}` +
        `${cpuColor}${padEnd(proc.cpu, w.cpu)}${RESET}` +
        `${colors.dim}${padEnd(proc.mem, w.mem)}${RESET}` +
        `${colors.dim}${padEnd(proc.time, w.time)}${RESET}` +
        `${padEnd(status, w.cmd)}` +
        ` ${colors.purple}${box.vertical}${RESET}`;
      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
    writeLine();
  }

  // Active tasks (registered via squads progress start)
  if (activeTasks.length > 0) {
    writeLine(`  ${bold}Registered Tasks${RESET} ${colors.dim}(squads progress)${RESET}`);
    writeLine();

    for (const task of activeTasks) {
      const elapsed = getElapsedTime(task.startedAt);
      writeLine(`  ${icons.progress} ${colors.cyan}${task.squad}${RESET} ${truncate(task.description, 40)}`);
      writeLine(`    ${colors.dim}id: ${task.id} · started ${elapsed} ago${RESET}`);
    }
    writeLine();
  }

  // Dev servers
  if (categorized.devServers.length > 0) {
    writeLine(`  ${bold}Dev Servers${RESET}`);
    writeLine();

    for (const proc of categorized.devServers) {
      const name = formatCommand(proc.command);
      writeLine(`  ${icons.active} ${colors.green}${name}${RESET} ${colors.dim}(pid: ${proc.pid})${RESET}`);
    }
    writeLine();
  }

  // Hooks/squads processes
  if (categorized.hooks.length > 0) {
    writeLine(`  ${bold}Hook Processes${RESET}`);
    writeLine();

    for (const proc of categorized.hooks) {
      const name = formatCommand(proc.command);
      writeLine(`  ${icons.pending} ${colors.yellow}${name}${RESET} ${colors.dim}(pid: ${proc.pid})${RESET}`);
    }
    writeLine();
  }

  // No workers message
  if (categorized.claude.length === 0 && activeTasks.length === 0) {
    writeLine(`  ${colors.dim}No active workers${RESET}`);
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads workers --kill <pid>  ${colors.dim}Kill a process${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads progress             ${colors.dim}Task history${RESET}`);
  writeLine();
}

function getElapsedTime(startTime: string): string {
  const start = new Date(startTime).getTime();
  const now = Date.now();
  const diffMs = now - start;

  const minutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return '<1m';
}
