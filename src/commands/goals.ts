/**
 * squads goals — dashboard view of all squad goals.
 */

import { Command } from 'commander';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { findSquadsDir } from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { colors, bold, RESET, writeLine } from '../lib/terminal.js';

interface GoalInfo {
  name: string;
  status: string;
  section: 'active' | 'achieved' | 'abandoned' | 'proposed';
}

function parseGoals(filePath: string): GoalInfo[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const goals: GoalInfo[] = [];

  let currentSection: GoalInfo['section'] = 'active';

  for (const line of content.split('\n')) {
    if (line.startsWith('## Active')) currentSection = 'active';
    else if (line.startsWith('## Achieved')) currentSection = 'achieved';
    else if (line.startsWith('## Abandoned')) currentSection = 'abandoned';
    else if (line.startsWith('## Proposed')) currentSection = 'proposed';

    const match = line.match(/\*\*([^*]+)\*\*.*status:\s*(\S+)/);
    if (match) {
      goals.push({ name: match[1].trim(), status: match[2].trim(), section: currentSection });
    }

    // Achieved goals don't have status field — detect by section
    if (currentSection === 'achieved' && line.match(/\*\*([^*]+)\*\*.*achieved:/)) {
      const nameMatch = line.match(/\*\*([^*]+)\*\*/);
      if (nameMatch) {
        goals.push({ name: nameMatch[1].trim(), status: 'achieved', section: 'achieved' });
      }
    }
  }

  return goals;
}

export function registerGoalsCommand(program: Command): void {
  program
    .command('goals')
    .description('Dashboard of all squad goals — status at a glance')
    .option('-s, --squad <squad>', 'Show goals for a specific squad')
    .option('--json', 'Output as JSON')
    .action((opts) => {
      const squadsDir = findSquadsDir();
      const memoryDir = findMemoryDir();
      if (!squadsDir || !memoryDir) {
        writeLine(`\n  ${colors.dim}No squads found. Run squads init.${RESET}\n`);
        return;
      }

      const squadDirs = readdirSync(squadsDir).filter(d => {
        return existsSync(join(squadsDir, d, 'SQUAD.md'));
      }).sort();

      const allData: Record<string, { goals: GoalInfo[]; active: number; achieved: number; blocked: number }> = {};

      for (const squad of squadDirs) {
        if (opts.squad && squad !== opts.squad) continue;
        const goalsPath = join(memoryDir, squad, 'goals.md');
        const goals = parseGoals(goalsPath);
        const active = goals.filter(g => g.section === 'active').length;
        const achieved = goals.filter(g => g.section === 'achieved').length;
        const blocked = goals.filter(g => g.status === 'blocked' || g.status === 'AT-RISK').length;
        allData[squad] = { goals, active, achieved, blocked };
      }

      if (opts.json) {
        console.log(JSON.stringify(allData, null, 2));
        return;
      }

      // Summary view
      const totalActive = Object.values(allData).reduce((s, d) => s + d.active, 0);
      const totalAchieved = Object.values(allData).reduce((s, d) => s + d.achieved, 0);
      const totalBlocked = Object.values(allData).reduce((s, d) => s + d.blocked, 0);

      writeLine();
      writeLine(`  ${bold}Goals Dashboard${RESET}  ${totalActive} active | ${colors.green}${totalAchieved} achieved${RESET} | ${totalBlocked > 0 ? colors.red : colors.dim}${totalBlocked} blocked${RESET}`);
      writeLine();
      writeLine(`  ${'Squad'} ${''.padEnd(10)} ${'Active'.padStart(6)} ${'Done'.padStart(6)} ${'Block'.padStart(6)}  Top Goal`);
      writeLine(`  ${'-'.repeat(78)}`);

      for (const [squad, data] of Object.entries(allData)) {
        const frozen = data.active === 0 && data.achieved === 0;
        if (frozen) continue; // Skip frozen squads in summary

        const activeGoals = data.goals.filter(g => g.section === 'active');
        const topGoal = activeGoals[0];
        const topStr = topGoal
          ? `${topGoal.name.slice(0, 30).padEnd(30)} ${statusIcon(topGoal.status)}`
          : `${colors.dim}(no active goals)${RESET}`;

        writeLine(`  ${squad.padEnd(15)} ${String(data.active).padStart(6)} ${String(data.achieved).padStart(6)} ${String(data.blocked).padStart(6)}  ${topStr}`);
      }

      // Detail view for specific squad
      if (opts.squad && allData[opts.squad]) {
        const data = allData[opts.squad];
        writeLine();
        writeLine(`  ${bold}${opts.squad} — Detail${RESET}`);

        for (const section of ['active', 'achieved', 'abandoned', 'proposed'] as const) {
          const sectionGoals = data.goals.filter(g => g.section === section);
          if (sectionGoals.length === 0) continue;
          writeLine(`\n  ${colors.cyan}${section.toUpperCase()}${RESET}`);
          for (const g of sectionGoals) {
            writeLine(`    ${statusIcon(g.status)}  ${g.name}`);
          }
        }
      }

      writeLine();
    });
}

function statusIcon(status: string): string {
  switch (status) {
    case 'achieved':
    case 'complete': return `${colors.green}done${RESET}`;
    case 'in-progress':
    case 'improving': return `${colors.cyan}prog${RESET}`;
    case 'not-started': return `${colors.dim}todo${RESET}`;
    case 'blocked':
    case 'AT-RISK': return `${colors.red}block${RESET}`;
    default: return `${colors.dim}${status.slice(0, 5)}${RESET}`;
  }
}
