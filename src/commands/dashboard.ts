import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { findSquadsDir, listSquads, loadSquad, Goal } from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  progressBar,
  box,
  padEnd,
  truncate,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface SquadMetrics {
  name: string;
  mission: string;
  goals: Goal[];
  lastActivity: string;
  status: 'active' | 'stale' | 'needs-goal';
}

function getLastActivityDate(squadName: string): string {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return 'unknown';

  const squadMemory = join(memoryDir, squadName);
  if (!existsSync(squadMemory)) return '—';

  let latestTime = 0;

  try {
    const agents = readdirSync(squadMemory, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const agent of agents) {
      const agentPath = join(squadMemory, agent.name);
      const files = readdirSync(agentPath).filter(f => f.endsWith('.md'));

      for (const file of files) {
        const filePath = join(agentPath, file);
        const stats = statSync(filePath);
        if (stats.mtimeMs > latestTime) {
          latestTime = stats.mtimeMs;
        }
      }
    }
  } catch {
    return '—';
  }

  if (latestTime === 0) return '—';

  const ageMs = Date.now() - latestTime;
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  if (ageDays === 0) return 'today';
  if (ageDays === 1) return '1d';
  if (ageDays < 7) return `${ageDays}d`;
  return `${Math.floor(ageDays / 7)}w`;
}

export async function dashboardCommand(_options: { verbose?: boolean } = {}): Promise<void> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    return;
  }

  const squadNames = listSquads(squadsDir);
  const squadData: SquadMetrics[] = [];

  for (const name of squadNames) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const lastActivity = getLastActivityDate(name);

    let status: SquadMetrics['status'] = 'active';
    const activeGoals = squad.goals.filter(g => !g.completed);
    if (activeGoals.length === 0) {
      status = 'needs-goal';
    } else if (lastActivity.includes('w') || lastActivity === '—') {
      status = 'stale';
    }

    squadData.push({
      name,
      mission: squad.mission,
      goals: squad.goals,
      lastActivity,
      status,
    });
  }

  // Stats
  const totalGoals = squadData.reduce((sum, s) => sum + s.goals.length, 0);
  const activeGoals = squadData.reduce((sum, s) => sum + s.goals.filter(g => !g.completed).length, 0);
  const completedGoals = totalGoals - activeGoals;
  const completionRate = totalGoals > 0 ? Math.round((completedGoals / totalGoals) * 100) : 0;
  const activeSquads = squadData.filter(s => s.status === 'active').length;

  // Render
  writeLine();

  // Header
  writeLine(`  ${gradient('squads')} ${colors.dim}v1.0.0${RESET}`);
  writeLine();

  // Stats row
  const stats = [
    `${colors.cyan}${activeSquads}${RESET}/${squadData.length} active`,
    `${colors.green}${completedGoals}${RESET}/${totalGoals} done`,
    `${colors.purple}${activeGoals}${RESET} in progress`,
  ].join(`  ${colors.dim}│${RESET}  `);
  writeLine(`  ${stats}`);
  writeLine();

  // Progress
  writeLine(`  ${progressBar(completionRate, 32)} ${colors.dim}${completionRate}%${RESET}`);
  writeLine();

  // Table header
  const w = { name: 14, status: 8, goals: 5, activity: 6, bar: 16 };
  const tableWidth = w.name + w.status + w.goals + w.activity + w.bar + 10;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
    `${bold}${padEnd('STATUS', w.status)}${RESET}` +
    `${bold}${padEnd('GOALS', w.goals)}${RESET}` +
    `${bold}${padEnd('LAST', w.activity)}${RESET}` +
    `${bold}PROGRESS${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  // Table rows
  for (const squad of squadData) {
    const activeCount = squad.goals.filter(g => !g.completed).length;
    const totalCount = squad.goals.length;
    const pct = totalCount > 0 ? Math.round(((totalCount - activeCount) / totalCount) * 100) : 0;

    let statusIcon: string;
    let statusText: string;
    if (squad.status === 'active') {
      statusIcon = icons.active;
      statusText = `${colors.green}active${RESET}`;
    } else if (squad.status === 'stale') {
      statusIcon = icons.error;
      statusText = `${colors.red}stale${RESET}`;
    } else {
      statusIcon = icons.warning;
      statusText = `${colors.yellow}—${RESET}`;
    }

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(squad.name, w.name)}${RESET}` +
      `${statusIcon} ${padEnd(statusText, w.status - 2)}` +
      `${padEnd(`${activeCount}/${totalCount}`, w.goals)}` +
      `${colors.dim}${padEnd(squad.lastActivity, w.activity)}${RESET}` +
      `${progressBar(pct, 12)}` +
      ` ${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Active goals (compact)
  const allActiveGoals = squadData.flatMap(s =>
    s.goals.filter(g => !g.completed).map(g => ({ squad: s.name, goal: g }))
  );

  if (allActiveGoals.length > 0) {
    writeLine(`  ${bold}Goals${RESET}`);
    writeLine();

    const maxGoals = 6;
    for (const { squad, goal } of allActiveGoals.slice(0, maxGoals)) {
      const hasProgress = goal.progress && goal.progress.length > 0;
      const icon = hasProgress ? icons.progress : icons.empty;
      const squadLabel = `${colors.dim}${squad}${RESET}`;
      const goalText = truncate(goal.description, 48);

      writeLine(`  ${icon} ${squadLabel} ${goalText}`);

      if (hasProgress) {
        const progressText = truncate(goal.progress!, 52);
        writeLine(`    ${colors.dim}└${RESET} ${colors.green}${progressText}${RESET}`);
      }
    }

    if (allActiveGoals.length > maxGoals) {
      writeLine(`  ${colors.dim}  +${allActiveGoals.length - maxGoals} more${RESET}`);
    }
    writeLine();
  }

  // Quick actions
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}<squad>${RESET}    ${colors.dim}Execute a squad${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads goal set    ${colors.dim}Add a goal${RESET}`);
  writeLine();
}
