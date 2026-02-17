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
  checkGhCli,
  checkClaudeCli,
  checkProviderAuth,
  runAuthChecks,
  displayCheckResults,
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

  // 1. Welcome
  console.log();
  console.log(chalk.bold('  Plant the seed for your AI workforce'));
  console.log(chalk.dim('  https://agents-squads.com/docs/getting-started'));
  console.log();

  // 2. Select provider
  const selectedProvider = await promptProvider(options.provider);
  const provider = PROVIDERS[selectedProvider];

  // 3. Prerequisite checks
  console.log();
  console.log(chalk.bold('  Checking prerequisites...'));
  console.log();

  const checks = [
    ...runAuthChecks(selectedProvider),
    checkGhCli(),
  ];

  // Check Git
  const gitStatus = checkGitStatus(cwd);
  if (!gitStatus.isGitRepo) {
    checks.push({
      name: 'Git Repository',
      status: 'missing' as const,
      message: 'Git is the coordination layer',
      hint: 'Run: git init',
      fixCommand: 'git init',
    });
  } else {
    checks.push({ name: 'Git Repository', status: 'ok' as const });
    if (gitStatus.hasRemote) {
      const repoName = getRepoName(gitStatus.remoteUrl);
      checks.push({ name: `Remote: ${repoName || gitStatus.remoteUrl}`, status: 'ok' as const });
    }
  }

  const { hasErrors } = displayCheckResults(checks);

  if (hasErrors && !options.force) {
    console.log();
    console.log(chalk.red('  Fix the errors above before continuing.'));
    console.log(chalk.dim('  Or run with --force to skip checks.'));
    console.log();
    process.exit(1);
  }

  console.log();

  // 4. Ask about the business
  let businessName: string;
  let businessDescription: string;
  let businessFocus: string;

  if (options.yes || options.quick || !isInteractive()) {
    businessName = path.basename(cwd);
    businessDescription = 'General business operations';
    businessFocus = 'Our market, competitors, and growth opportunities';
  } else {
    const dirName = path.basename(cwd);

    console.log(chalk.bold('  Tell us about your business:'));
    console.log();

    businessName = await prompt(
      'Company or project name?',
      dirName
    );

    businessDescription = await prompt(
      'What does it do? (one sentence)',
      ''
    );

    console.log();

    businessFocus = await prompt(
      'What should your first research squad investigate?',
      'Our market, competitors, and growth opportunities'
    );
  }

  console.log();
  console.log(`  ${chalk.green('✓')} Business: ${chalk.cyan(businessName)}${businessDescription ? chalk.dim(` — ${businessDescription}`) : ''}`);
  console.log(`  ${chalk.green('✓')} Provider: ${chalk.cyan(provider?.name || selectedProvider)}`);
  console.log(`  ${chalk.green('✓')} Research focus: ${chalk.cyan(businessFocus)}`);
  console.log();

  // 4. Create the seed
  const spinner = ora('Planting the seed...').start();

  try {
    const variables: TemplateVariables = {
      BUSINESS_NAME: businessName,
      BUSINESS_DESCRIPTION: businessDescription || `${businessName} — details to be added by the manager agent.`,
      BUSINESS_FOCUS: businessFocus,
      PROVIDER: selectedProvider,
      PROVIDER_NAME: provider?.name || 'Unknown',
    };

    // Create all directories
    const dirs = [
      '.agents/squads/company',
      '.agents/squads/research',
      '.agents/squads/intelligence',
      '.agents/memory/company/manager',
      '.agents/memory/company/event-dispatcher',
      '.agents/memory/company/goal-tracker',
      '.agents/memory/company/company-eval',
      '.agents/memory/company/company-critic',
      '.agents/memory/research/researcher',
      '.agents/memory/research/analyst',
      '.agents/memory/research/research-eval',
      '.agents/memory/research/research-critic',
      '.agents/memory/intelligence/intel-lead',
      '.agents/memory/intelligence/intel-eval',
      '.agents/memory/intelligence/intel-critic',
      '.agents/skills/squads-cli',
      '.agents/skills/gh',
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

    // Intelligence squad agents
    const intelligenceFiles: [string, string][] = [
      ['.agents/squads/intelligence/SQUAD.md', 'squads/intelligence/SQUAD.md'],
      ['.agents/squads/intelligence/intel-lead.md', 'squads/intelligence/intel-lead.md'],
      ['.agents/squads/intelligence/intel-eval.md', 'squads/intelligence/intel-eval.md'],
      ['.agents/squads/intelligence/intel-critic.md', 'squads/intelligence/intel-critic.md'],
    ];

    // Write squad files
    for (const [dest, template] of [...companyFiles, ...researchFiles, ...intelligenceFiles]) {
      const content = loadSeedTemplate(template, variables);
      await writeFile(path.join(cwd, dest), content);
    }

    spinner.text = 'Creating memory and config...';

    // Memory state files
    const memoryFiles: [string, string][] = [
      ['.agents/memory/company/manager/state.md', 'memory/company/manager/state.md'],
      ['.agents/memory/research/researcher/state.md', 'memory/research/researcher/state.md'],
      ['.agents/memory/intelligence/intel-lead/state.md', 'memory/intelligence/intel-lead/state.md'],
    ];

    for (const [dest, template] of memoryFiles) {
      await writeIfNew(path.join(cwd, dest), loadSeedTemplate(template, variables));
    }

    // Skills
    const skillContent = loadSeedTemplate('skills/squads-cli/SKILL.md', variables);
    await writeFile(path.join(cwd, '.agents/skills/squads-cli/SKILL.md'), skillContent);

    const ghSkillContent = loadSeedTemplate('skills/gh/SKILL.md', variables);
    await writeFile(path.join(cwd, '.agents/skills/gh/SKILL.md'), ghSkillContent);

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
      agentCount: 12,
      squadCount: 3,
      hasBusinessName: businessName !== path.basename(cwd),
      hasBusinessDescription: businessDescription.length > 0,
    });

  } catch (error) {
    spinner.fail('Failed to plant the seed');
    console.error(chalk.red(`  ${error}`));
    process.exit(1);
  }

  // 5. Success message
  console.log();
  console.log(chalk.green.bold(`  ${businessName}'s AI workforce is ready.`));
  console.log();
  console.log(chalk.dim('  Created:'));
  console.log(chalk.dim('  • .agents/squads/research/      4 agents (researcher, analyst, eval, critic)'));
  console.log(chalk.dim('  • .agents/squads/intelligence/  3 agents (intel-lead, eval, critic)'));
  console.log(chalk.dim('  • .agents/squads/company/       5 agents (manager, dispatcher, tracker, eval, critic)'));
  console.log(chalk.dim('  • .agents/skills/               CLI + GitHub workflow skills'));
  console.log(chalk.dim('  • .agents/memory/          Persistent state'));
  console.log(chalk.dim('  • .agents/BUSINESS_BRIEF.md'));
  if (selectedProvider === 'claude') {
    console.log(chalk.dim('  • CLAUDE.md                Operating manual'));
    console.log(chalk.dim('  • .claude/settings.json    Session hooks'));
  }
  console.log();
  console.log(chalk.bold('  Getting started:'));
  console.log();
  console.log(`     ${chalk.cyan('1.')} ${chalk.yellow('git add -A && git commit -m "feat: init AI workforce"')}`);
  console.log(chalk.dim('        Git is the coordination layer — commit first'));
  console.log();
  console.log(`     ${chalk.cyan('2.')} ${chalk.yellow('squads run research/researcher')}`);
  console.log(chalk.dim('        Your first agent researches the topic you set'));
  console.log();
  console.log(`     ${chalk.cyan('3.')} ${chalk.yellow('squads eval research/researcher')}`);
  console.log(chalk.dim('        Evaluate the output — is it useful?'));
  console.log();
  console.log(`     ${chalk.cyan('4.')} ${chalk.yellow('gh issue create --title "Research: [topic]" --body "..."')}`);
  console.log(chalk.dim('        Create an issue for deeper investigation'));
  console.log();
  console.log(`     ${chalk.cyan('5.')} ${chalk.yellow('squads run research/researcher')}`);
  console.log(chalk.dim('        Agent works on the issue, commits to a branch, opens a PR'));
  console.log();
  console.log(chalk.dim('  Docs: https://agents-squads.com/docs/getting-started'));
  console.log();
}
