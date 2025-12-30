import chalk from 'chalk';
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { findSquadsDir, listSquads, loadSquad, Goal } from '../lib/squad-parser.js';
import { findMemoryDir, searchMemory } from '../lib/memory.js';

interface SquadMetrics {
  name: string;
  mission: string;
  goals: Goal[];
  lastActivity: string;
  keyMetrics: { name: string; value: string }[];
  status: 'active' | 'stale' | 'needs-goal';
}

function getLastActivityDate(squadName: string): string {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return 'unknown';

  const squadMemory = join(memoryDir, squadName);
  if (!existsSync(squadMemory)) return 'no memory';

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
    return 'error';
  }

  if (latestTime === 0) return 'no activity';

  const ageMs = Date.now() - latestTime;
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

  if (ageDays === 0) return 'today';
  if (ageDays === 1) return 'yesterday';
  if (ageDays < 7) return `${ageDays}d ago`;
  return `${Math.floor(ageDays / 7)}w ago`;
}

function extractKeyMetrics(squadName: string): { name: string; value: string }[] {
  const metrics: { name: string; value: string }[] = [];
  const memoryDir = findMemoryDir();
  if (!memoryDir) return metrics;

  // Define what metrics to look for per squad
  const metricPatterns: Record<string, { pattern: RegExp; name: string }[]> = {
    finance: [
      { pattern: /MRR[:\s|]+\$?([\d,.]+|Unknown|\d+)/i, name: 'MRR' },
      { pattern: /Revenue[:\s|]+\$?([\d,.]+|Unknown)/i, name: 'Revenue' },
      { pattern: /Runway[:\s|]+([\w\s]+)/i, name: 'Runway' },
    ],
    customer: [
      { pattern: /Identified[:\s|]+(\d+)/i, name: 'Leads' },
      { pattern: /Pipeline[:\s|]+([\w\s]+)/i, name: 'Pipeline' },
    ],
    product: [
      { pattern: /Version[:\s|]+([\d.]+)/i, name: 'CLI Version' },
      { pattern: /npm publish[:\s|]+([\w\s]+)/i, name: 'npm' },
    ],
    intelligence: [
      { pattern: /Gen AI spend[:\s|]+\$?([\d.]+B?)/i, name: 'Market Size' },
      { pattern: /Pilot.*Production[:\s|]+<?(\d+%)/i, name: 'Pilot Success' },
    ],
    website: [
      { pattern: /Completion rate[:\s|]+(\d+%)/i, name: 'Tasks Done' },
    ],
  };

  const patterns = metricPatterns[squadName] || [];
  const squadMemory = join(memoryDir, squadName);

  if (!existsSync(squadMemory)) return metrics;

  try {
    const agents = readdirSync(squadMemory, { withFileTypes: true })
      .filter(e => e.isDirectory());

    for (const agent of agents) {
      const statePath = join(squadMemory, agent.name, 'state.md');
      if (!existsSync(statePath)) continue;

      const content = readFileSync(statePath, 'utf-8');

      for (const { pattern, name } of patterns) {
        const match = content.match(pattern);
        if (match && !metrics.find(m => m.name === name)) {
          metrics.push({ name, value: match[1].trim() });
        }
      }
    }
  } catch {
    // ignore errors
  }

  return metrics;
}

export async function dashboardCommand(options: { verbose?: boolean } = {}): Promise<void> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    console.error(chalk.red('No .agents/squads directory found'));
    return;
  }

  const squadNames = listSquads(squadsDir);
  const squadData: SquadMetrics[] = [];

  for (const name of squadNames) {
    const squad = loadSquad(name);
    if (!squad) continue;

    const lastActivity = getLastActivityDate(name);
    const keyMetrics = extractKeyMetrics(name);

    let status: SquadMetrics['status'] = 'active';
    if (squad.goals.filter(g => !g.completed).length === 0) {
      status = 'needs-goal';
    } else if (lastActivity.includes('w ago') || lastActivity === 'no activity') {
      status = 'stale';
    }

    squadData.push({
      name,
      mission: squad.mission,
      goals: squad.goals,
      lastActivity,
      keyMetrics,
      status,
    });
  }

  // Print header
  console.log(`
${chalk.bold.magenta('AGENTS SQUADS DASHBOARD')}
${chalk.dim('─'.repeat(70))}
`);

  // Goals Matrix
  console.log(chalk.bold.cyan('Goals by Domain\n'));
  console.log(chalk.dim('Domain          Goal                                    Value              Status'));
  console.log(chalk.dim('─'.repeat(70)));

  for (const squad of squadData) {
    const activeGoals = squad.goals.filter(g => !g.completed);

    if (activeGoals.length === 0) {
      // Show squad without goals
      const statusIcon = chalk.yellow('⚠');
      const metricStr = squad.keyMetrics.length > 0
        ? squad.keyMetrics.map(m => `${m.value}`).join(', ').slice(0, 18)
        : chalk.dim('null');

      console.log(
        `${chalk.cyan(squad.name.padEnd(15))} ` +
        `${chalk.dim('(no goals set)'.padEnd(39))} ` +
        `${metricStr.padEnd(18)} ` +
        `${statusIcon} Needs goal`
      );
    } else {
      // Show each goal
      for (let i = 0; i < activeGoals.length; i++) {
        const goal = activeGoals[i];
        const domainCol = i === 0 ? chalk.cyan(squad.name.padEnd(15)) : ' '.repeat(15);
        const goalText = goal.description.slice(0, 37).padEnd(39);
        const valueText = goal.progress
          ? goal.progress.slice(0, 16).padEnd(18)
          : chalk.dim('null'.padEnd(18));
        const statusIcon = goal.progress ? chalk.blue('⏳') : chalk.yellow('○');

        console.log(`${domainCol} ${goalText} ${valueText} ${statusIcon}`);
      }
    }
  }

  // Key Metrics Summary
  console.log(`\n${chalk.bold.cyan('Key Metrics\n')}`);
  console.log(chalk.dim('Metric                Value              Source'));
  console.log(chalk.dim('─'.repeat(50)));

  const allMetrics: { metric: string; value: string; source: string }[] = [];

  for (const squad of squadData) {
    for (const m of squad.keyMetrics) {
      allMetrics.push({ metric: m.name, value: m.value, source: squad.name });
    }
  }

  // Add computed metrics
  const totalGoals = squadData.reduce((sum, s) => sum + s.goals.filter(g => !g.completed).length, 0);
  const completedGoals = squadData.reduce((sum, s) => sum + s.goals.filter(g => g.completed).length, 0);
  const squadsWithGoals = squadData.filter(s => s.goals.length > 0).length;
  const staleSquads = squadData.filter(s => s.status === 'stale').length;

  allMetrics.push({ metric: 'Active Goals', value: String(totalGoals), source: 'system' });
  allMetrics.push({ metric: 'Completed Goals', value: String(completedGoals), source: 'system' });
  allMetrics.push({ metric: 'Squads w/ Goals', value: `${squadsWithGoals}/${squadData.length}`, source: 'system' });

  for (const m of allMetrics) {
    console.log(
      `${m.metric.padEnd(20)} ` +
      `${m.value.padEnd(18)} ` +
      `${chalk.dim(m.source)}`
    );
  }

  // Squad Health
  console.log(`\n${chalk.bold.cyan('Squad Health\n')}`);
  console.log(chalk.dim('Squad           Last Activity    Status'));
  console.log(chalk.dim('─'.repeat(45)));

  for (const squad of squadData) {
    const statusIcon = squad.status === 'active'
      ? chalk.green('●')
      : squad.status === 'stale'
        ? chalk.red('●')
        : chalk.yellow('○');

    const statusText = squad.status === 'active'
      ? chalk.green('Active')
      : squad.status === 'stale'
        ? chalk.red('Stale')
        : chalk.yellow('Needs goal');

    console.log(
      `${squad.name.padEnd(15)} ` +
      `${squad.lastActivity.padEnd(16)} ` +
      `${statusIcon} ${statusText}`
    );
  }

  // Recommendations
  const needsGoals = squadData.filter(s => s.status === 'needs-goal');
  const stale = squadData.filter(s => s.status === 'stale');

  if (needsGoals.length > 0 || stale.length > 0) {
    console.log(`\n${chalk.bold.cyan('Recommendations\n')}`);

    if (needsGoals.length > 0) {
      console.log(chalk.yellow(`⚠ ${needsGoals.length} squad(s) need goals:`));
      for (const s of needsGoals) {
        console.log(chalk.dim(`  squads goal set ${s.name} "<goal>"`));
      }
    }

    if (stale.length > 0) {
      console.log(chalk.red(`\n● ${stale.length} squad(s) are stale:`));
      for (const s of stale) {
        console.log(chalk.dim(`  squads run ${s.name}`));
      }
    }
  }

  console.log();
}
