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

interface TmuxSession {
  name: string;
  created: Date;
  ageHours: number;
  squad: string;
  agent: string;
  isZombie: boolean;
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

/**
 * Get tmux sessions that were spawned by squads run
 * Detects zombies: sessions older than 24h are likely stuck
 */
function getTmuxSessions(): TmuxSession[] {
  const sessions: TmuxSession[] = [];
  const ZOMBIE_THRESHOLD_HOURS = 24;

  try {
    // Get tmux sessions with creation time
    const output = execSync(
      'tmux list-sessions -F "#{session_name}|#{session_created}" 2>/dev/null',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!output) return sessions;

    for (const line of output.split('\n')) {
      const [name, createdTs] = line.split('|');

      // Only track squads-* sessions
      if (!name.startsWith('squads-')) continue;

      // Parse session name: squads-{squad}-{agent}-{timestamp}
      const parts = name.replace('squads-', '').split('-');
      const squad = parts[0] || 'unknown';
      const agent = parts.slice(1, -1).join('-') || 'unknown';

      const created = new Date(parseInt(createdTs) * 1000);
      const ageHours = (Date.now() - created.getTime()) / (1000 * 60 * 60);
      const isZombie = ageHours > ZOMBIE_THRESHOLD_HOURS;

      sessions.push({
        name,
        created,
        ageHours,
        squad,
        agent,
        isZombie,
      });
    }
  } catch {
    // tmux not running or no sessions
  }

  return sessions;
}

/**
 * Kill zombie tmux sessions (older than 24h)
 * Returns number of sessions killed
 */
function cleanupZombies(sessions: TmuxSession[]): number {
  const zombies = sessions.filter(s => s.isZombie);
  let killed = 0;

  for (const zombie of zombies) {
    try {
      execSync(`tmux kill-session -t "${zombie.name}" 2>/dev/null`, { stdio: 'pipe' });
      killed++;
    } catch {
      // Session may have already ended
    }
  }

  return killed;
}

function formatAge(hours: number): string {
  if (hours < 1) return '<1h';
  if (hours < 24) return `${Math.floor(hours)}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export async function workersCommand(options: { verbose?: boolean; kill?: string; cleanup?: boolean; all?: boolean } = {}): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}workers${RESET}`);
  writeLine();

  // Get tmux sessions first (needed for cleanup)
  const tmuxSessions = getTmuxSessions();
  const zombies = tmuxSessions.filter(s => s.isZombie);

  // Kill ALL agent tmux sessions if requested (safe - doesn't touch interactive terminals)
  if (options.all) {
    if (tmuxSessions.length === 0) {
      writeLine(`  ${icons.success} No agent sessions to clean up`);
      writeLine();
      return;
    }

    writeLine(`  ${colors.yellow}Killing ${tmuxSessions.length} agent session(s)...${RESET}`);
    writeLine(`  ${colors.dim}(Only tmux sessions from 'squads run', not interactive terminals)${RESET}`);
    writeLine();

    let killed = 0;
    for (const session of tmuxSessions) {
      writeLine(`  ${icons.pending} Killing ${colors.cyan}${session.squad}/${session.agent}${RESET} ${colors.dim}(${formatAge(session.ageHours)} old)${RESET}`);
      try {
        execSync(`tmux kill-session -t "${session.name}" 2>/dev/null`, { stdio: 'pipe' });
        killed++;
      } catch {
        // Session may have already ended
      }
    }

    writeLine();
    writeLine(`  ${icons.success} Killed ${colors.green}${killed}${RESET} agent session(s)`);
    writeLine();
    return;
  }

  // Cleanup zombies if requested
  if (options.cleanup) {
    if (zombies.length === 0) {
      writeLine(`  ${icons.success} No zombie sessions to clean up`);
      writeLine();
      return;
    }

    writeLine(`  ${colors.yellow}Cleaning up ${zombies.length} zombie session(s)...${RESET}`);
    writeLine();

    for (const zombie of zombies) {
      writeLine(`  ${icons.pending} Killing ${colors.cyan}${zombie.squad}/${zombie.agent}${RESET} ${colors.dim}(${formatAge(zombie.ageHours)} old)${RESET}`);
    }

    const killed = cleanupZombies(tmuxSessions);
    writeLine();
    writeLine(`  ${icons.success} Cleaned up ${colors.green}${killed}${RESET} zombie session(s)`);
    writeLine();
    return;
  }

  // Kill a process if requested
  if (options.kill) {
    // Check if it's a tmux session name
    const tmuxSession = tmuxSessions.find(s => s.name === options.kill || s.name.includes(options.kill!));
    if (tmuxSession) {
      try {
        execSync(`tmux kill-session -t "${tmuxSession.name}" 2>/dev/null`, { stdio: 'pipe' });
        writeLine(`  ${icons.success} Killed tmux session ${colors.cyan}${tmuxSession.name}${RESET}`);
        writeLine();
        return;
      } catch {
        writeLine(`  ${icons.error} Failed to kill tmux session ${colors.red}${tmuxSession.name}${RESET}`);
        writeLine();
        return;
      }
    }

    // Otherwise try as PID
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
    `${colors.green}${tmuxSessions.length}${RESET} agents`,
    `${zombies.length > 0 ? colors.red : colors.dim}${zombies.length}${RESET} zombies`,
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

  // Tmux sessions (agent workers from squads run)
  if (tmuxSessions.length > 0) {
    writeLine(`  ${bold}Agent Workers${RESET} ${colors.dim}(squads run background)${RESET}`);
    writeLine();

    const w = { squad: 14, agent: 18, age: 6, status: 12 };
    const tableWidth = w.squad + w.agent + w.age + w.status + 8;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
    writeLine(`  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('SQUAD', w.squad)}${padEnd('AGENT', w.agent)}${padEnd('AGE', w.age)}${padEnd('STATUS', w.status)}${RESET} ${colors.purple}${box.vertical}${RESET}`);
    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    for (const session of tmuxSessions) {
      const ageColor = session.isZombie ? colors.red : colors.dim;
      const status = session.isZombie
        ? `${colors.red}${icons.error} zombie${RESET}`
        : `${colors.green}${icons.active} running${RESET}`;

      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${colors.cyan}${padEnd(session.squad, w.squad)}${RESET}` +
        `${colors.dim}${padEnd(session.agent, w.agent)}${RESET}` +
        `${ageColor}${padEnd(formatAge(session.ageHours), w.age)}${RESET}` +
        `${padEnd(status, w.status + 10)}` + // Extra for color codes
        ` ${colors.purple}${box.vertical}${RESET}`;
      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
    writeLine();

    if (zombies.length > 0) {
      writeLine(`  ${colors.yellow}${icons.warning} ${zombies.length} zombie session(s) detected (>24h old)${RESET}`);
      writeLine(`  ${colors.dim}Run \`squads workers --cleanup\` to remove them${RESET}`);
      writeLine();
    }
  }

  // No workers message
  if (categorized.claude.length === 0 && tmuxSessions.length === 0 && activeTasks.length === 0) {
    writeLine(`  ${colors.dim}No active workers${RESET}`);
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads workers --kill <pid|session>  ${colors.dim}Kill a process or tmux session${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads workers --cleanup             ${colors.dim}Kill all zombie sessions (>24h)${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} tmux attach -t <session>             ${colors.dim}Attach to a session${RESET}`);
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
