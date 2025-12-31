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

export async function dashboardCommand(options: { verbose?: boolean; ceo?: boolean } = {}): Promise<void> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    return;
  }

  // CEO mode: executive summary
  if (options.ceo) {
    await renderCeoReport(squadsDir);
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

// Priority keywords that indicate high priority goals
const P0_KEYWORDS = ['revenue', 'first', 'launch', 'publish', 'ship', 'critical', 'urgent'];
const P1_KEYWORDS = ['track', 'establish', 'identify', 'define', 'fix'];

function inferPriority(goal: string): 'P0' | 'P1' | 'P2' {
  const lower = goal.toLowerCase();
  if (P0_KEYWORDS.some(k => lower.includes(k))) return 'P0';
  if (P1_KEYWORDS.some(k => lower.includes(k))) return 'P1';
  return 'P2';
}

async function renderCeoReport(squadsDir: string): Promise<void> {
  const squadNames = listSquads(squadsDir);
  const allGoals: { squad: string; goal: Goal; priority: 'P0' | 'P1' | 'P2' }[] = [];
  const blockers: string[] = [];
  let activeSquads = 0;
  let staleSquads = 0;

  for (const name of squadNames) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const lastActivity = getLastActivityDate(name);
    const activeGoals = squad.goals.filter(g => !g.completed);

    // Check for blockers
    if (activeGoals.length === 0) {
      blockers.push(`${name}: No active goals`);
    } else if (lastActivity.includes('w') || lastActivity === '—') {
      blockers.push(`${name}: Stale (${lastActivity})`);
      staleSquads++;
    } else {
      activeSquads++;
    }

    // Collect goals with inferred priority
    for (const goal of activeGoals) {
      allGoals.push({
        squad: name,
        goal,
        priority: inferPriority(goal.description),
      });
    }
  }

  // Sort by priority
  allGoals.sort((a, b) => {
    const order = { P0: 0, P1: 1, P2: 2 };
    return order[a.priority] - order[b.priority];
  });

  const p0Goals = allGoals.filter(g => g.priority === 'P0');
  const p1Goals = allGoals.filter(g => g.priority === 'P1');

  // Render
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}CEO Report${RESET}`);
  writeLine(`  ${colors.dim}${new Date().toISOString().split('T')[0]}${RESET}`);
  writeLine();

  // Key metrics
  const w = { label: 20, value: 12 };
  const tableWidth = w.label + w.value + 4;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${bold}${padEnd('METRIC', w.label)}${RESET}${bold}VALUE${RESET}       ${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Active Squads', w.label)}${colors.green}${padEnd(`${activeSquads}/${squadNames.length}`, w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('P0 Goals', w.label)}${colors.red}${padEnd(String(p0Goals.length), w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('P1 Goals', w.label)}${colors.yellow}${padEnd(String(p1Goals.length), w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);
  writeLine(`  ${colors.purple}${box.vertical}${RESET} ${padEnd('Blockers', w.label)}${blockers.length > 0 ? colors.red : colors.green}${padEnd(String(blockers.length), w.value)}${RESET}${colors.purple}${box.vertical}${RESET}`);

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();

  // Top Priorities (P0)
  if (p0Goals.length > 0) {
    writeLine(`  ${bold}${colors.red}P0${RESET} ${bold}Priorities${RESET} ${colors.dim}(revenue/launch critical)${RESET}`);
    writeLine();
    for (const { squad, goal } of p0Goals.slice(0, 5)) {
      writeLine(`  ${icons.error} ${colors.cyan}${squad}${RESET} ${goal.description}`);
      if (goal.progress) {
        writeLine(`    ${colors.dim}└ ${goal.progress}${RESET}`);
      }
    }
    writeLine();
  }

  // P1 Goals
  if (p1Goals.length > 0) {
    writeLine(`  ${bold}${colors.yellow}P1${RESET} ${bold}Important${RESET} ${colors.dim}(tracking/foundations)${RESET}`);
    writeLine();
    for (const { squad, goal } of p1Goals.slice(0, 3)) {
      writeLine(`  ${icons.warning} ${colors.cyan}${squad}${RESET} ${truncate(goal.description, 50)}`);
    }
    if (p1Goals.length > 3) {
      writeLine(`  ${colors.dim}  +${p1Goals.length - 3} more${RESET}`);
    }
    writeLine();
  }

  // Blockers
  if (blockers.length > 0) {
    writeLine(`  ${bold}Blockers${RESET}`);
    writeLine();
    for (const blocker of blockers.slice(0, 3)) {
      writeLine(`  ${icons.error} ${colors.red}${blocker}${RESET}`);
    }
    writeLine();
  }

  // Next Steps
  writeLine(`  ${bold}Next Steps${RESET}`);
  writeLine();
  if (p0Goals.length > 0) {
    writeLine(`  ${icons.active} Focus on P0: ${colors.cyan}${p0Goals[0].squad}${RESET} - ${truncate(p0Goals[0].goal.description, 40)}`);
  }
  if (blockers.length > 0) {
    writeLine(`  ${icons.warning} Unblock: ${colors.yellow}${blockers[0]}${RESET}`);
  }
  if (staleSquads > 0) {
    writeLine(`  ${icons.progress} Revive ${staleSquads} stale squad(s)`);
  }
  writeLine();

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads dash              ${colors.dim}Full operational view${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads goal list         ${colors.dim}All active goals${RESET}`);
  writeLine();
}
