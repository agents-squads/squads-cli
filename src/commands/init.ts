/**
 * squads init - Plant the seed
 *
 * Creates:
 * - Manager agent (the AI manager that runs operations)
 * - CLI skill (teaches agents how to use squads CLI)
 * - Starter squads (company + research with 9 agents total)
 * - CLAUDE.md (operating manual for all Claude instances)
 * - BUSINESS_BRIEF.md (from user input)
 * - Memory directories (persistent state)
 * - Claude Code hooks (session tracking)
 */

import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import { createInterface } from 'readline';
import { checkGitStatus, getRepoName } from '../lib/git.js';
import { track, Events } from '../lib/telemetry.js';
import {
  loadTemplate,
  type TemplateVariables,
} from '../lib/templates.js';
import {
  commandExists,
  PROVIDERS,
} from '../lib/setup-checks.js';

export interface InitOptions {
  provider?: string;
  skipInfra?: boolean;
  force?: boolean;
  yes?: boolean;
  quick?: boolean;
}

type Provider = 'claude' | 'gemini' | 'openai' | 'ollama' | 'cursor' | 'aider' | 'none';

function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function prompt(question: string, defaultValue = ''): Promise<string> {
  if (!isInteractive()) return defaultValue;

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    const suffix = defaultValue ? chalk.dim(` (${defaultValue})`) : '';
    rl.question(`  ${question}${suffix} `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue);
    });
  });
}

async function promptProvider(forceProvider?: string): Promise<Provider> {
  if (forceProvider && forceProvider in PROVIDERS) {
    return forceProvider as Provider;
  }
  if (!isInteractive()) return 'claude';

  console.log();
  console.log(chalk.bold('  Select your AI assistant:'));
  console.log();
  console.log(`  ${chalk.cyan('1)')} Claude Code ${chalk.dim('(recommended)')}`);
  console.log(`  ${chalk.cyan('2)')} Gemini`);
  console.log(`  ${chalk.cyan('3)')} OpenAI GPT`);
  console.log(`  ${chalk.cyan('4)')} Ollama ${chalk.dim('(local)')}`);
  console.log(`  ${chalk.cyan('5)')} Other/None`);
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`  ${chalk.dim('Enter choice [1-5]:')} `, (answer) => {
      rl.close();
      const choice = answer.trim() || '1';
      switch (choice) {
        case '1': resolve('claude'); break;
        case '2': resolve('gemini'); break;
        case '3': resolve('openai'); break;
        case '4': resolve('ollama'); break;
        case '5': resolve('none'); break;
        default: resolve('claude'); break;
      }
    });
  });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Load a seed template from templates/seed/
 * Falls back to bundled templates in dist/templates/seed/
 */
function loadSeedTemplate(templatePath: string, variables: TemplateVariables = {}): string {
  // Try loading from seed directory
  return loadTemplate(`seed/${templatePath}`, variables);
}

/**
 * Write a file only if it doesn't already exist (safe for re-runs)
 */
async function writeIfNew(filePath: string, content: string): Promise<boolean> {
  if (await fileExists(filePath)) return false;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return true;
}

/**
 * Write a file, creating directories as needed
 */
async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

/**
 * Main init command - plant the seed
 */
export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();

  // 1. Ask the one question
  console.log();
  console.log(chalk.bold('  Plant the seed for your AI workforce'));
  console.log();

  let businessFocus: string;
  if (options.yes || options.quick || !isInteractive()) {
    businessFocus = 'General business operations and research';
  } else {
    businessFocus = await prompt(
      'What do you want your AI workforce to focus on?',
      'General business operations and research'
    );
  }

  // 2. Select provider
  const selectedProvider = await promptProvider(options.provider);
  const provider = PROVIDERS[selectedProvider];

  console.log();
  console.log(`  ${chalk.green('✓')} Focus: ${chalk.cyan(businessFocus)}`);
  console.log(`  ${chalk.green('✓')} Provider: ${chalk.cyan(provider?.name || selectedProvider)}`);

  // 3. Check Git
  const gitStatus = checkGitStatus(cwd);
  if (!gitStatus.isGitRepo) {
    console.log(`  ${chalk.yellow('⚠')} No git repository found`);
    console.log(chalk.dim('    Git is the coordination layer. Run: git init'));
  } else {
    console.log(`  ${chalk.green('✓')} Git repository`);
    if (gitStatus.hasRemote) {
      const repoName = getRepoName(gitStatus.remoteUrl);
      console.log(`  ${chalk.green('✓')} Remote: ${chalk.cyan(repoName || gitStatus.remoteUrl)}`);
    }
  }

  console.log();

  // 4. Create the seed
  const spinner = ora('Planting the seed...').start();

  try {
    const variables: TemplateVariables = {
      BUSINESS_FOCUS: businessFocus,
      PROVIDER: selectedProvider,
      PROVIDER_NAME: provider?.name || 'Unknown',
    };

    // Create all directories
    const dirs = [
      '.agents/squads/company',
      '.agents/squads/research',
      '.agents/memory/company/manager',
      '.agents/memory/company/event-dispatcher',
      '.agents/memory/company/goal-tracker',
      '.agents/memory/company/company-eval',
      '.agents/memory/company/company-critic',
      '.agents/memory/research/researcher',
      '.agents/memory/research/analyst',
      '.agents/memory/research/research-eval',
      '.agents/memory/research/research-critic',
      '.agents/skills/squads-cli',
      '.agents/config',
    ];

    if (selectedProvider === 'claude') {
      dirs.push('.claude');
    }

    for (const dir of dirs) {
      await fs.mkdir(path.join(cwd, dir), { recursive: true });
    }

    spinner.text = 'Creating squad definitions...';

    // Company squad agents
    const companyFiles: [string, string][] = [
      ['.agents/squads/company/SQUAD.md', 'squads/company/SQUAD.md'],
      ['.agents/squads/company/manager.md', 'squads/company/manager.md'],
      ['.agents/squads/company/event-dispatcher.md', 'squads/company/event-dispatcher.md'],
      ['.agents/squads/company/goal-tracker.md', 'squads/company/goal-tracker.md'],
      ['.agents/squads/company/company-eval.md', 'squads/company/company-eval.md'],
      ['.agents/squads/company/company-critic.md', 'squads/company/company-critic.md'],
    ];

    // Research squad agents
    const researchFiles: [string, string][] = [
      ['.agents/squads/research/SQUAD.md', 'squads/research/SQUAD.md'],
      ['.agents/squads/research/researcher.md', 'squads/research/researcher.md'],
      ['.agents/squads/research/analyst.md', 'squads/research/analyst.md'],
      ['.agents/squads/research/research-eval.md', 'squads/research/research-eval.md'],
      ['.agents/squads/research/research-critic.md', 'squads/research/research-critic.md'],
    ];

    // Write squad files
    for (const [dest, template] of [...companyFiles, ...researchFiles]) {
      const content = loadSeedTemplate(template, variables);
      await writeFile(path.join(cwd, dest), content);
    }

    spinner.text = 'Creating memory and config...';

    // Memory state files
    const memoryFiles: [string, string][] = [
      ['.agents/memory/company/manager/state.md', 'memory/company/manager/state.md'],
      ['.agents/memory/research/researcher/state.md', 'memory/research/researcher/state.md'],
    ];

    for (const [dest, template] of memoryFiles) {
      await writeIfNew(path.join(cwd, dest), loadSeedTemplate(template, variables));
    }

    // CLI skill
    const skillContent = loadSeedTemplate('skills/squads-cli/SKILL.md', variables);
    await writeFile(path.join(cwd, '.agents/skills/squads-cli/SKILL.md'), skillContent);

    // Provider config
    const providerConfig = loadSeedTemplate('config/provider.yaml', variables);
    await writeFile(path.join(cwd, '.agents/config/provider.yaml'), providerConfig);

    // Business brief
    const businessBrief = loadSeedTemplate('BUSINESS_BRIEF.md.template', variables);
    await writeFile(path.join(cwd, '.agents/BUSINESS_BRIEF.md'), businessBrief);

    spinner.text = 'Setting up operating manual...';

    // CLAUDE.md (the operating manual — only if it doesn't exist)
    if (selectedProvider === 'claude') {
      const claudeMd = loadSeedTemplate('CLAUDE.md.template', variables);
      await writeIfNew(path.join(cwd, 'CLAUDE.md'), claudeMd);

      // Claude Code hooks
      const hooksContent = loadSeedTemplate('hooks/settings.json.template', variables);
      await writeIfNew(path.join(cwd, '.claude/settings.json'), hooksContent);
    }

    spinner.succeed('Seed planted');

    // Track initialization
    await track(Events.CLI_INIT, {
      success: true,
      hasGit: gitStatus.isGitRepo,
      hasRemote: gitStatus.hasRemote,
      provider: selectedProvider,
      agentCount: 9,
      squadCount: 2,
    });

  } catch (error) {
    spinner.fail('Failed to plant the seed');
    console.error(chalk.red(`  ${error}`));
    process.exit(1);
  }

  // 5. Success message
  console.log();
  console.log(chalk.green.bold('  Your AI workforce is ready.'));
  console.log();
  console.log(chalk.dim('  Created:'));
  console.log(chalk.dim('  • .agents/squads/company/  5 agents (manager, dispatcher, tracker, eval, critic)'));
  console.log(chalk.dim('  • .agents/squads/research/ 4 agents (researcher, analyst, eval, critic)'));
  console.log(chalk.dim('  • .agents/skills/          CLI operations manual'));
  console.log(chalk.dim('  • .agents/memory/          Persistent state'));
  console.log(chalk.dim('  • .agents/BUSINESS_BRIEF.md'));
  if (selectedProvider === 'claude') {
    console.log(chalk.dim('  • CLAUDE.md                Operating manual'));
    console.log(chalk.dim('  • .claude/settings.json    Session hooks'));
  }
  console.log();
  console.log(chalk.bold('  Next steps:'));
  console.log();
  console.log(`     ${chalk.cyan('1.')} ${chalk.yellow('squads status')}                  ${chalk.dim('See your workforce')}`);
  console.log(`     ${chalk.cyan('2.')} ${chalk.yellow('squads run company/manager')}     ${chalk.dim('First run — manager reads context, plans work')}`);
  console.log(`     ${chalk.cyan('3.')} ${chalk.yellow('git add -A && git commit')}       ${chalk.dim('Git is the coordination layer')}`);
  console.log();
  console.log(chalk.dim('  The manager agent will read your business brief and start operating.'));
  console.log();
}
