/**
 * squads add <name> — Add a new squad with directory structure and starter files.
 *
 * Creates:
 *   .agents/squads/<name>/SQUAD.md
 *   .agents/squads/<name>/lead.md
 *   .agents/memory/<name>/lead/  (empty, ready for state)
 *
 * Squad discovery is filesystem-based (squad-parser.ts), so creating the
 * directory + SQUAD.md is all that's needed for `squads status` to find it.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { findSquadsDir, findProjectRoot, listSquads } from '../lib/squad-parser.js';
import { loadTemplate, toKebabCase, toTitleCase, type TemplateVariables } from '../lib/templates.js';
import { track } from '../lib/telemetry.js';
import { createGitHubRepo, detectGitHubOrg } from '../lib/github.js';
import { createSquadChannel } from '../lib/slack.js';

interface CreateOptions {
  description?: string;
  mission?: string;
  goal?: string;
  model?: string;
  force?: boolean;
  yes?: boolean;
  repo?: boolean;
  org?: string;
  slack?: boolean;
}

export async function createCommand(name: string, options: CreateOptions): Promise<void> {
  const squadId = toKebabCase(name);
  const squadName = toTitleCase(squadId);

  if (!squadId) {
    console.error(chalk.red('\n  Invalid squad name. Use letters, numbers, and hyphens.\n'));
    process.exit(1);
  }

  // Find project root (where .agents/ lives)
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    console.error(chalk.red('\n  Not in a squads project. Run `squads init` first.\n'));
    process.exit(1);
  }

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    console.error(chalk.red('\n  No .agents/squads directory found. Run `squads init` first.\n'));
    process.exit(1);
  }

  // Check if squad already exists
  const squadDir = join(squadsDir, squadId);
  if (existsSync(join(squadDir, 'SQUAD.md')) && !options.force) {
    console.error(chalk.red(`\n  Squad "${squadId}" already exists. Use --force to overwrite.\n`));
    process.exit(1);
  }

  // Collect description and goal — prompt interactively if not provided via flags
  // --mission is an alias for --description
  let description = options.mission || options.description;
  let goal = options.goal;

  if (!options.yes && (!description || !goal)) {
    const inquirer = await import('inquirer');

    if (!description) {
      const answer = await inquirer.default.prompt([{
        type: 'input',
        name: 'description',
        message: 'Squad mission (one sentence):',
        default: `The ${squadName} squad handles ${squadId}-related tasks.`,
      }]);
      description = answer.description;
    }

    if (!goal) {
      const answer = await inquirer.default.prompt([{
        type: 'input',
        name: 'goal',
        message: 'First goal:',
        default: `Define ${squadId} squad objectives and deliver first results`,
      }]);
      goal = answer.goal;
    }
  }

  // Defaults for non-interactive mode
  description = description || `The ${squadName} squad handles ${squadId}-related tasks.`;
  goal = goal || `Define ${squadId} squad objectives and deliver first results`;
  const model = options.model || 'sonnet';

  // Template variables
  const vars: TemplateVariables = {
    SQUAD_NAME: squadName,
    SQUAD_ID: squadId,
    SQUAD_DESCRIPTION: description,
    GOAL: goal,
  };

  // 1. Create squad directory
  mkdirSync(squadDir, { recursive: true });

  // 2. Create SQUAD.md from template
  let squadContent: string;
  try {
    squadContent = loadTemplate('first-squad/SQUAD.md.template', vars);
  } catch {
    // Fallback if template not found
    squadContent = `# ${squadName}\n\n${description}\n\n## Goals\n\n- [ ] ${goal}\n\n## Agents\n\n| Agent | Purpose |\n|-------|--------|\n| lead | Orchestrates the squad and coordinates work |\n\n## Pipeline\n\n\`lead\` (orchestrates all work)\n\n## Usage\n\n\`\`\`bash\nsquads run ${squadId} --execute\n\`\`\`\n`;
  }
  writeFileSync(join(squadDir, 'SQUAD.md'), squadContent);

  // 3. Create lead agent from template
  let leadContent: string;
  try {
    leadContent = loadTemplate('first-squad/lead.md.template', vars);
  } catch {
    // Fallback if template not found
    leadContent = `# Lead Agent\n\n## Purpose\nOrchestrate the ${squadName} squad to achieve its goals.\n\n## Model\n${model}\n\n## Tools\n- Read\n- Write\n- Edit\n- Bash\n- WebSearch\n- WebFetch\n- Task\n\n## Instructions\n\nYou are the lead agent for the ${squadName} squad.\n\n**Goal**: ${goal}\n\n### Approach\n\n1. **Understand the goal** - Break down what needs to be accomplished\n2. **Plan the work** - Create a clear execution plan\n3. **Execute** - Work through the plan step by step\n4. **Verify** - Confirm the goal is achieved\n5. **Document** - Update memory with learnings\n\n## Output\nProgress updates and work artifacts as appropriate.\n\n## Labels\n- lead\n- orchestration\n`;
  }
  writeFileSync(join(squadDir, 'lead.md'), leadContent);

  // 4. Create memory directories
  const memoryDir = join(projectRoot, '.agents', 'memory', squadId, 'lead');
  mkdirSync(memoryDir, { recursive: true });

  // Track creation event
  await track('cli.create', {
    squad: squadId,
    hasDescription: !!(options.description || options.mission),
    hasGoal: !!options.goal,
    force: !!options.force,
    repo: !!options.repo,
  }).catch(() => {});

  // 5. Create Slack channel if --slack flag is set
  let slackChannelId: string | null = null;
  if (options.slack) {
    slackChannelId = await createSquadChannel(squadId, `Channel for the ${squadName} squad`);
    if (!slackChannelId) {
      console.error(chalk.red('\n  Slack channel creation failed (check SLACK_BOT_TOKEN).\n'));
      console.error(chalk.dim('  Local squad was created. Create the channel manually.\n'));
    }
  }

  // 6. Create GitHub repo if --repo flag is set
  let repoUrl: string | undefined;
  if (options.repo) {
    const org = options.org ?? detectGitHubOrg();
    try {
      const result = createGitHubRepo(squadId, { org, description });
      repoUrl = result.url;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  GitHub repo creation failed: ${message}\n`));
      console.error(chalk.dim('  Local squad was created. Create the repo manually with:'));
      console.error(chalk.dim(`  gh repo create ${org ? `${org}/` : ''}${squadId} --private\n`));
    }
  }

  // 7. Show success
  const existing = listSquads(squadsDir);
  console.log();
  console.log(chalk.green('  ✓ Squad created:'), chalk.cyan(squadId));
  console.log();
  console.log(chalk.dim('  Files:'));
  console.log(`    .agents/squads/${squadId}/SQUAD.md`);
  console.log(`    .agents/squads/${squadId}/lead.md`);
  console.log(`    .agents/memory/${squadId}/lead/`);
  if (slackChannelId) {
    console.log();
    console.log(chalk.dim('  Slack channel:'));
    console.log(`    ${chalk.cyan(`#squad-${squadId}`)}`);
  }
  if (repoUrl) {
    console.log();
    console.log(chalk.dim('  GitHub repo:'));
    console.log(`    ${chalk.cyan(repoUrl)}`);
  }
  console.log();
  console.log(chalk.dim('  Next steps:'));
  console.log(`    ${chalk.cyan('$')} squads run ${squadId}              ${chalk.dim('# run the squad')}`);
  console.log(`    ${chalk.cyan('$')} squads status ${squadId}           ${chalk.dim('# check status')}`);
  console.log(`    ${chalk.cyan('$')} squads status                     ${chalk.dim(`# ${existing.length} squads total`)}`);
  console.log();
}
