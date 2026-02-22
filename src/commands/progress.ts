import { Command } from 'commander';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import '../lib/squad-parser.js';
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
  completedAt?: string;
  commits?: string[];
}

interface TasksFile {
  tasks: TaskEntry[];
  lastUpdated: string;
}

function getTasksFilePath(): string {
  const memoryDir = findMemoryDir();
  if (!memoryDir) {
    const cwd = process.cwd();
    const agentsDir = join(cwd, '.agents');
    if (!existsSync(agentsDir)) {
      mkdirSync(agentsDir, { recursive: true });
    }
    return join(agentsDir, 'tasks.json');
  }
  return join(memoryDir, '..', 'tasks.json');
}

function loadTasks(): TasksFile {
  const tasksPath = getTasksFilePath();
  if (existsSync(tasksPath)) {
    try {
      return JSON.parse(readFileSync(tasksPath, 'utf-8'));
    } catch {
      return { tasks: [], lastUpdated: new Date().toISOString() };
    }
  }
  return { tasks: [], lastUpdated: new Date().toISOString() };
}

function saveTasks(data: TasksFile): void {
  const tasksPath = getTasksFilePath();
  data.lastUpdated = new Date().toISOString();
  writeFileSync(tasksPath, JSON.stringify(data, null, 2));
}

// Get recent commits to infer activity
function getRecentActivity(): { squad: string; message: string; hash: string; date: string }[] {
  const activity: { squad: string; message: string; hash: string; date: string }[] = [];

  const squadKeywords: Record<string, string[]> = {
    website: ['website', 'web', 'homepage', 'astro', 'page'],
    product: ['cli', 'squads-cli', 'command'],
    research: ['research', 'report', 'analysis'],
    engineering: ['infra', 'engineering', 'build'],
    intelligence: ['intel', 'monitor', 'competitor'],
    customer: ['lead', 'customer', 'outreach'],
    finance: ['cost', 'finance', 'budget'],
    company: ['company', 'strategy', 'mission'],
    marketing: ['marketing', 'content', 'social'],
  };

  try {
    const logOutput = execSync(
      'git log --since="24 hours ago" --format="%h|%aI|%s" 2>/dev/null',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!logOutput) return activity;

    for (const line of logOutput.split('\n')) {
      const [hash, date, ...msgParts] = line.split('|');
      const message = msgParts.join('|');
      if (!hash || !message) continue;

      // Detect squad from commit message
      const msgLower = message.toLowerCase();
      let detectedSquad = 'unknown';

      for (const [squad, keywords] of Object.entries(squadKeywords)) {
        if (keywords.some(k => msgLower.includes(k))) {
          detectedSquad = squad;
          break;
        }
      }

      activity.push({
        squad: detectedSquad,
        message,
        hash,
        date: date.split('T')[0],
      });
    }
  } catch {
    // Not in git repo
  }

  return activity;
}

export async function progressCommand(options: { verbose?: boolean } = {}): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}progress${RESET}`);
  writeLine();

  const tasksData = loadTasks();
  const recentActivity = getRecentActivity();

  // Active tasks
  const activeTasks = tasksData.tasks.filter(t => t.status === 'active');
  const completedToday = tasksData.tasks.filter(t =>
    t.status === 'completed' &&
    t.completedAt?.startsWith(new Date().toISOString().split('T')[0])
  );

  // Stats row
  const stats = [
    `${colors.cyan}${activeTasks.length}${RESET} active`,
    `${colors.green}${completedToday.length}${RESET} done today`,
    `${colors.purple}${recentActivity.length}${RESET} commits (24h)`,
  ].join(`  ${colors.dim}│${RESET}  `);
  writeLine(`  ${stats}`);
  writeLine();

  // Active tasks section
  if (activeTasks.length > 0) {
    writeLine(`  ${bold}Active Tasks${RESET}`);
    writeLine();

    for (const task of activeTasks) {
      const elapsed = getElapsedTime(task.startedAt);
      writeLine(`  ${icons.progress} ${colors.cyan}${task.squad}${RESET} ${truncate(task.description, 45)}`);
      writeLine(`    ${colors.dim}started ${elapsed} ago${RESET}`);
    }
    writeLine();
  } else {
    writeLine(`  ${colors.dim}No active tasks${RESET}`);
    writeLine();
  }

  // Recent activity from git
  if (recentActivity.length > 0) {
    writeLine(`  ${bold}Recent Activity${RESET} ${colors.dim}(last 24h)${RESET}`);
    writeLine();

    const w = { squad: 12, message: 50 };
    const tableWidth = w.squad + w.message + 4;

    writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
    writeLine(`  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('SQUAD', w.squad)}${RESET}${bold}COMMIT${RESET}${' '.repeat(w.message - 6)} ${colors.purple}${box.vertical}${RESET}`);
    writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

    const maxRows = options.verbose ? 15 : 8;
    for (const act of recentActivity.slice(0, maxRows)) {
      const squadColor = act.squad === 'unknown' ? colors.dim : colors.cyan;
      const row = `  ${colors.purple}${box.vertical}${RESET} ` +
        `${squadColor}${padEnd(act.squad, w.squad)}${RESET}` +
        `${truncate(act.message, w.message - 2)}` +
        ` ${colors.purple}${box.vertical}${RESET}`;
      writeLine(row);
    }

    writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);

    if (recentActivity.length > maxRows) {
      writeLine(`  ${colors.dim}+${recentActivity.length - maxRows} more commits${RESET}`);
    }
    writeLine();
  }

  // Completed today
  if (completedToday.length > 0) {
    writeLine(`  ${bold}Completed Today${RESET}`);
    writeLine();
    for (const task of completedToday.slice(0, 5)) {
      writeLine(`  ${icons.success} ${colors.cyan}${task.squad}${RESET} ${truncate(task.description, 50)}`);
    }
    if (completedToday.length > 5) {
      writeLine(`  ${colors.dim}+${completedToday.length - 5} more${RESET}`);
    }
    writeLine();
  }

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads results          ${colors.dim}KPI goals vs actuals${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads dash             ${colors.dim}Full dashboard${RESET}`);
  writeLine();
}

// Register a new task (called by agents)
export async function progressStartCommand(
  squad: string,
  description: string
): Promise<void> {
  const tasksData = loadTasks();
  const id = Math.random().toString(36).substring(2, 9);

  tasksData.tasks.push({
    id,
    squad,
    description,
    status: 'active',
    startedAt: new Date().toISOString(),
  });

  saveTasks(tasksData);
  writeLine(`  ${icons.active} Task ${colors.cyan}${id}${RESET} started for ${colors.purple}${squad}${RESET}`);
}

// Complete a task
export async function progressCompleteCommand(
  taskId: string,
  options: { failed?: boolean } = {}
): Promise<void> {
  const tasksData = loadTasks();
  const task = tasksData.tasks.find(t => t.id === taskId);

  if (!task) {
    writeLine(`  ${icons.error} Task ${colors.red}${taskId}${RESET} not found`);
    return;
  }

  task.status = options.failed ? 'failed' : 'completed';
  task.completedAt = new Date().toISOString();

  saveTasks(tasksData);

  const icon = options.failed ? icons.error : icons.success;
  const status = options.failed ? 'failed' : 'completed';
  writeLine(`  ${icon} Task ${colors.cyan}${taskId}${RESET} ${status}`);
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

export function registerProgressCommand(program: Command): void {
  const progress = program
    .command('progress')
    .description('Track active and completed agent tasks')
    .option('-v, --verbose', 'Show more activity')
    .action(progressCommand);

  progress
    .command('start <squad> <description>')
    .description('Register a new active task')
    .action(progressStartCommand);

  progress
    .command('complete <taskId>')
    .description('Mark a task as completed')
    .option('-f, --failed', 'Mark as failed instead')
    .action(progressCompleteCommand);
}
