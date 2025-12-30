import chalk from 'chalk';
import {
  loadSquad,
  findSquadsDir,
  listSquads,
  addGoalToSquad,
  updateGoalInSquad,
  Goal
} from '../lib/squad-parser.js';

export async function goalSetCommand(
  squadName: string,
  description: string,
  options: { metric?: string[] }
): Promise<void> {
  const squad = loadSquad(squadName);
  if (!squad) {
    console.error(chalk.red(`Squad "${squadName}" not found`));
    return;
  }

  // Add metric annotations if provided
  let goalText = description;
  if (options.metric && options.metric.length > 0) {
    goalText += ` [metrics: ${options.metric.join(', ')}]`;
  }

  const success = addGoalToSquad(squadName, goalText);

  if (success) {
    console.log(chalk.green(`✓ Goal added to ${squadName}`));
    console.log(`  ${chalk.bold(description)}`);
    if (options.metric && options.metric.length > 0) {
      console.log(chalk.dim(`  Metrics: ${options.metric.join(', ')}`));
    }
  } else {
    console.error(chalk.red('Failed to add goal'));
  }
}

export async function goalListCommand(
  squadName?: string,
  options: { all?: boolean } = {}
): Promise<void> {
  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    console.error(chalk.red('Error: No .agents/squads directory found'));
    return;
  }

  const squadsToCheck = squadName ? [squadName] : listSquads(squadsDir);

  let totalActive = 0;
  let totalCompleted = 0;
  let hasGoals = false;

  for (const name of squadsToCheck) {
    const squad = loadSquad(name);
    if (!squad || squad.goals.length === 0) {
      if (squadName) {
        console.log(chalk.yellow(`No goals set for ${name}`));
      }
      continue;
    }

    hasGoals = true;
    const activeGoals = squad.goals.filter(g => !g.completed);
    const completedGoals = squad.goals.filter(g => g.completed);

    totalActive += activeGoals.length;
    totalCompleted += completedGoals.length;

    if (activeGoals.length === 0 && !options.all) continue;

    console.log(chalk.bold.cyan(`\n${name}`));
    console.log(chalk.dim(`  Mission: ${squad.mission}`));

    activeGoals.forEach((goal, idx) => {
      const globalIdx = squad.goals.indexOf(goal) + 1;
      console.log(`  ${chalk.green('○')} [${globalIdx}] ${goal.description}`);
      if (goal.progress) {
        console.log(chalk.dim(`      Progress: ${goal.progress}`));
      }
    });

    if (options.all && completedGoals.length > 0) {
      completedGoals.forEach((goal) => {
        const globalIdx = squad.goals.indexOf(goal) + 1;
        console.log(chalk.dim(`  ✓ [${globalIdx}] ${goal.description}`));
      });
    }
  }

  if (hasGoals) {
    console.log(chalk.dim(`\nTotal: ${totalActive} active, ${totalCompleted} completed`));
  } else if (!squadName) {
    console.log(chalk.yellow('\nNo goals defined yet.'));
    console.log(chalk.dim('Add a goal: squads goal set <squad> "<goal>"'));
  }
}

export async function goalCompleteCommand(
  squadName: string,
  goalIndex: string
): Promise<void> {
  const squad = loadSquad(squadName);
  if (!squad) {
    console.error(chalk.red(`Squad "${squadName}" not found`));
    return;
  }

  const idx = parseInt(goalIndex) - 1;
  if (idx < 0 || idx >= squad.goals.length) {
    console.error(chalk.red(`Invalid goal index: ${goalIndex}`));
    console.log(chalk.dim(`Squad has ${squad.goals.length} goal(s)`));
    return;
  }

  const success = updateGoalInSquad(squadName, idx, { completed: true });

  if (success) {
    console.log(chalk.green(`✓ Goal completed: ${squad.goals[idx].description}`));
  } else {
    console.error(chalk.red('Failed to update goal'));
  }
}

export async function goalProgressCommand(
  squadName: string,
  goalIndex: string,
  progress: string
): Promise<void> {
  const squad = loadSquad(squadName);
  if (!squad) {
    console.error(chalk.red(`Squad "${squadName}" not found`));
    return;
  }

  const idx = parseInt(goalIndex) - 1;
  if (idx < 0 || idx >= squad.goals.length) {
    console.error(chalk.red(`Invalid goal index: ${goalIndex}`));
    return;
  }

  const success = updateGoalInSquad(squadName, idx, { progress });

  if (success) {
    console.log(chalk.green(`✓ Progress updated: ${squad.goals[idx].description}`));
    console.log(chalk.dim(`  ${progress}`));
  } else {
    console.error(chalk.red('Failed to update progress'));
  }
}
