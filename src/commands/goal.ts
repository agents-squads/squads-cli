import { Command } from 'commander';
import {
  loadSquad,
  findSquadsDir,
  listSquads,
  addGoalToSquad,
  updateGoalInSquad,
} from '../lib/squad-parser.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  truncate,
  icons,
  writeLine,
} from '../lib/terminal.js';
import { track, Events } from '../lib/telemetry.js';

export async function goalSetCommand(
  squadName: string,
  description: string,
  options: { metric?: string[] }
): Promise<void> {
  await track(Events.CLI_GOAL_SET, { squad: squadName });
  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${colors.red}Squad "${squadName}" not found${RESET}`);
    return;
  }

  // Add metric annotations if provided
  let goalText = description;
  if (options.metric && options.metric.length > 0) {
    goalText += ` [metrics: ${options.metric.join(', ')}]`;
  }

  const success = addGoalToSquad(squadName, goalText);

  writeLine();
  if (success) {
    writeLine(`  ${icons.success} Goal added to ${colors.cyan}${squadName}${RESET}`);
    writeLine(`  ${bold}${description}${RESET}`);
    if (options.metric && options.metric.length > 0) {
      writeLine(`  ${colors.dim}Metrics: ${options.metric.join(', ')}${RESET}`);
    }
  } else {
    writeLine(`  ${colors.red}Failed to add goal${RESET}`);
  }
  writeLine();
}

export async function goalListCommand(
  squadName?: string,
  options: { all?: boolean } = {}
): Promise<void> {
  await track(Events.CLI_GOAL_LIST, { squad: squadName || 'all' });
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    return;
  }

  const squadsToCheck = squadName ? [squadName] : listSquads(squadsDir);

  let totalActive = 0;
  let totalCompleted = 0;
  let hasGoals = false;

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}goal list${RESET}`);
  writeLine();

  for (const name of squadsToCheck) {
    const squad = loadSquad(name);
    if (!squad || squad.goals.length === 0) {
      if (squadName) {
        writeLine(`  ${colors.yellow}No goals set for ${name}${RESET}`);
      }
      continue;
    }

    hasGoals = true;
    const activeGoals = squad.goals.filter(g => !g.completed);
    const completedGoals = squad.goals.filter(g => g.completed);

    totalActive += activeGoals.length;
    totalCompleted += completedGoals.length;

    if (activeGoals.length === 0 && !options.all) continue;

    writeLine(`  ${colors.cyan}${name}${RESET}`);
    if (squad.mission) {
      writeLine(`  ${colors.dim}${truncate(squad.mission, 60)}${RESET}`);
    }
    writeLine();

    for (const goal of activeGoals) {
      const globalIdx = squad.goals.indexOf(goal) + 1;
      writeLine(`  ${icons.active} ${colors.dim}[${globalIdx}]${RESET} ${goal.description}`);
      if (goal.progress) {
        writeLine(`    ${colors.dim}└ ${goal.progress}${RESET}`);
      }
    }

    if (options.all && completedGoals.length > 0) {
      for (const goal of completedGoals) {
        const globalIdx = squad.goals.indexOf(goal) + 1;
        writeLine(`  ${icons.success} ${colors.dim}[${globalIdx}] ${goal.description}${RESET}`);
      }
    }
    writeLine();
  }

  if (hasGoals) {
    writeLine(`  ${colors.green}${totalActive}${RESET} active  ${colors.dim}│${RESET}  ${colors.dim}${totalCompleted} completed${RESET}`);
  } else if (!squadName) {
    writeLine(`  ${colors.yellow}No goals defined yet${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}$${RESET} squads goal set ${colors.cyan}<squad>${RESET} ${colors.cyan}"<goal>"${RESET}`);
  }
  writeLine();
}

export async function goalCompleteCommand(
  squadName: string,
  goalIndex: string
): Promise<void> {
  await track(Events.CLI_GOAL_COMPLETE, { squad: squadName });
  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${colors.red}Squad "${squadName}" not found${RESET}`);
    return;
  }

  const idx = parseInt(goalIndex) - 1;
  if (isNaN(idx) || idx < 0 || idx >= squad.goals.length) {
    writeLine(`  ${colors.red}Invalid goal index: ${goalIndex}${RESET}`);
    if (squad.goals.length === 0) {
      writeLine(`  ${colors.dim}Squad has no goals${RESET}`);
    } else {
      writeLine(`  ${colors.dim}Valid indexes: 1-${squad.goals.length}${RESET}`);
      writeLine(`  ${colors.dim}Tip: Run 'squads goal list ${squadName}' to see goals with indexes${RESET}`);
    }
    return;
  }

  const success = updateGoalInSquad(squadName, idx, { completed: true });

  writeLine();
  if (success) {
    writeLine(`  ${icons.success} Goal completed: ${colors.cyan}${squad.goals[idx].description}${RESET}`);
  } else {
    writeLine(`  ${colors.red}Failed to update goal${RESET}`);
  }
  writeLine();
}

export async function goalProgressCommand(
  squadName: string,
  goalIndex: string,
  progress: string
): Promise<void> {
  await track(Events.CLI_GOAL_PROGRESS, { squad: squadName });
  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${colors.red}Squad "${squadName}" not found${RESET}`);
    return;
  }

  const idx = parseInt(goalIndex) - 1;
  if (isNaN(idx) || idx < 0 || idx >= squad.goals.length) {
    writeLine(`  ${colors.red}Invalid goal index: ${goalIndex}${RESET}`);
    if (squad.goals.length === 0) {
      writeLine(`  ${colors.dim}Squad has no goals${RESET}`);
    } else {
      writeLine(`  ${colors.dim}Valid indexes: 1-${squad.goals.length}${RESET}`);
      writeLine(`  ${colors.dim}Tip: Run 'squads goal list ${squadName}' to see goals with indexes${RESET}`);
    }
    return;
  }

  const success = updateGoalInSquad(squadName, idx, { progress });

  writeLine();
  if (success) {
    writeLine(`  ${icons.success} Progress updated: ${colors.cyan}${squad.goals[idx].description}${RESET}`);
    writeLine(`  ${colors.dim}${progress}${RESET}`);
  } else {
    writeLine(`  ${colors.red}Failed to update progress${RESET}`);
  }
  writeLine();
}

export function registerGoalCommand(program: Command): void {
  const goal = program
    .command('goal')
    .description('Manage squad goals')
    .action(() => {
      goal.outputHelp();
    });

  goal
    .command('set <squad> <description>')
    .description('Set a goal for a squad')
    .option('-m, --metric <metrics...>', 'Metrics to track')
    .action(goalSetCommand);

  goal
    .command('list [squad]')
    .description('List goals for squad(s)')
    .option('-a, --all', 'Show completed goals too')
    .option('-j, --json', 'Output as JSON')
    .action(goalListCommand);

  goal
    .command('complete <squad> <index>')
    .description('Mark a goal as completed')
    .action(goalCompleteCommand);

  goal
    .command('progress <squad> <index> <progress>')
    .description('Update goal progress')
    .action(goalProgressCommand);
}
