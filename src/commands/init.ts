/**
 * squads init - Plant the seed
 *
 * Creates:
 * - Use-case specific squads (Engineering, Marketing, Operations, or all)
 * - CLI skill (teaches agents how to use squads CLI)
 * - Core squads (company + research + intelligence) for all use cases
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
  PROVIDERS,
  checkGhCli,
  runAuthChecks,
  displayCheckResults,
} from '../lib/setup-checks.js';
import { writeLine } from '../lib/terminal.js';

export interface InitOptions {
  provider?: string;
  skipInfra?: boolean;
  force?: boolean;
  yes?: boolean;
  quick?: boolean;
}

type Provider = 'claude' | 'gemini' | 'openai' | 'ollama' | 'cursor' | 'aider' | 'none';

type UseCase = 'engineering' | 'marketing' | 'operations' | 'full-company' | 'custom';

/**
 * Use-case configuration: squads, files, memory dirs, and display info
 */
interface UseCaseConfig {
  label: string;
  description: string;
  squads: SquadConfig[];
}

interface SquadConfig {
  name: string;
  agentCount: number;
  agentSummary: string;
  dirs: string[];
  files: [string, string][];       // [destPath, templatePath]
  memoryFiles: [string, string][]; // [destPath, templatePath]
}

/**
 * Define what each use case creates
 */
function getUseCaseConfig(useCase: UseCase): UseCaseConfig {
  const configs: Record<UseCase, UseCaseConfig> = {
    engineering: {
      label: 'Engineering',
      description: 'Ships code',
      squads: [getEngineeringSquad()],
    },
    marketing: {
      label: 'Marketing',
      description: 'Grows audience',
      squads: [getMarketingSquad()],
    },
    operations: {
      label: 'Operations',
      description: 'Runs the business',
      squads: [getOperationsSquad()],
    },
    'full-company': {
      label: 'Full Company',
      description: 'Engineering + Marketing + Operations',
      squads: [getEngineeringSquad(), getMarketingSquad(), getOperationsSquad()],
    },
    custom: {
      label: 'Custom',
      description: 'Empty scaffold — you build from scratch',
      squads: [],
    },
  };

  return configs[useCase];
}

function getEngineeringSquad(): SquadConfig {
  return {
    name: 'engineering',
    agentCount: 3,
    agentSummary: 'issue-solver, code-reviewer, test-writer',
    dirs: [
      '.agents/squads/engineering',
      '.agents/memory/engineering/issue-solver',
      '.agents/memory/engineering/code-reviewer',
      '.agents/memory/engineering/test-writer',
    ],
    files: [
      ['.agents/squads/engineering/SQUAD.md', 'squads/engineering/SQUAD.md'],
      ['.agents/squads/engineering/issue-solver.md', 'squads/engineering/issue-solver.md'],
      ['.agents/squads/engineering/code-reviewer.md', 'squads/engineering/code-reviewer.md'],
      ['.agents/squads/engineering/test-writer.md', 'squads/engineering/test-writer.md'],
    ],
    memoryFiles: [
      ['.agents/memory/engineering/issue-solver/state.md', 'memory/engineering/issue-solver/state.md'],
    ],
  };
}

function getMarketingSquad(): SquadConfig {
  return {
    name: 'marketing',
    agentCount: 3,
    agentSummary: 'content-drafter, social-poster, growth-analyst',
    dirs: [
      '.agents/squads/marketing',
      '.agents/memory/marketing/content-drafter',
      '.agents/memory/marketing/social-poster',
      '.agents/memory/marketing/growth-analyst',
    ],
    files: [
      ['.agents/squads/marketing/SQUAD.md', 'squads/marketing/SQUAD.md'],
      ['.agents/squads/marketing/content-drafter.md', 'squads/marketing/content-drafter.md'],
      ['.agents/squads/marketing/social-poster.md', 'squads/marketing/social-poster.md'],
      ['.agents/squads/marketing/growth-analyst.md', 'squads/marketing/growth-analyst.md'],
    ],
    memoryFiles: [
      ['.agents/memory/marketing/content-drafter/state.md', 'memory/marketing/content-drafter/state.md'],
    ],
  };
}

function getOperationsSquad(): SquadConfig {
  return {
    name: 'operations',
    agentCount: 3,
    agentSummary: 'ops-lead, finance-tracker, goal-tracker',
    dirs: [
      '.agents/squads/operations',
      '.agents/memory/operations/ops-lead',
      '.agents/memory/operations/finance-tracker',
      '.agents/memory/operations/goal-tracker',
    ],
    files: [
      ['.agents/squads/operations/SQUAD.md', 'squads/operations/SQUAD.md'],
      ['.agents/squads/operations/ops-lead.md', 'squads/operations/ops-lead.md'],
      ['.agents/squads/operations/finance-tracker.md', 'squads/operations/finance-tracker.md'],
      ['.agents/squads/operations/goal-tracker.md', 'squads/operations/goal-tracker.md'],
    ],
    memoryFiles: [
      ['.agents/memory/operations/ops-lead/state.md', 'memory/operations/ops-lead/state.md'],
    ],
  };
}

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

  writeLine();
  writeLine(chalk.bold('  Select your AI assistant:'));
  writeLine();
  writeLine(`  ${chalk.cyan('1)')} Claude Code ${chalk.dim('(recommended)')}`);
  writeLine(`  ${chalk.cyan('2)')} Gemini`);
  writeLine(`  ${chalk.cyan('3)')} OpenAI GPT`);
  writeLine(`  ${chalk.cyan('4)')} Ollama ${chalk.dim('(local)')}`);
  writeLine(`  ${chalk.cyan('5)')} Other/None`);
  writeLine();

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

async function promptUseCase(): Promise<UseCase> {
  if (!isInteractive()) return 'full-company';

  writeLine();
  writeLine(chalk.bold('  What does your AI workforce need to do?'));
  writeLine();
  writeLine(`  ${chalk.cyan('1)')} Engineering       ${chalk.dim('— ships code (issue-solver, code-reviewer, test-writer)')}`);
  writeLine(`  ${chalk.cyan('2)')} Marketing          ${chalk.dim('— grows audience (content-drafter, social-poster, growth-analyst)')}`);
  writeLine(`  ${chalk.cyan('3)')} Operations         ${chalk.dim('— runs the business (ops-lead, finance-tracker, goal-tracker)')}`);
  writeLine(`  ${chalk.cyan('4)')} Full Company       ${chalk.dim('— all of the above')} ${chalk.green('(recommended)')}`);
  writeLine(`  ${chalk.cyan('5)')} Custom             ${chalk.dim('— empty scaffold, you build from scratch')}`);
  writeLine();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`  ${chalk.dim('Enter choice [1-5]:')} `, (answer) => {
      rl.close();
      const choice = answer.trim() || '4';
      switch (choice) {
        case '1': resolve('engineering'); break;
        case '2': resolve('marketing'); break;
        case '3': resolve('operations'); break;
        case '4': resolve('full-company'); break;
        case '5': resolve('custom'); break;
        default: resolve('full-company'); break;
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
  writeLine();
  writeLine(chalk.bold('  Plant the seed for your AI workforce'));
  writeLine(chalk.dim('  https://agents-squads.com/docs/getting-started'));
  writeLine();

  // 2. Select provider
  const selectedProvider = await promptProvider(options.provider);
  const provider = PROVIDERS[selectedProvider];

  // 3. Prerequisite checks
  writeLine();
  writeLine(chalk.bold('  Checking prerequisites...'));
  writeLine();

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
    writeLine();
    writeLine(chalk.red('  Fix the errors above before continuing.'));
    writeLine(chalk.dim('  Or run with --force to skip checks.'));
    writeLine();
    process.exit(1);
  }

  writeLine();

  // 4. Ask about the business
  let businessName: string;
  let businessDescription: string;
  let businessFocus: string;
  let selectedUseCase: UseCase;

  if (options.yes || options.quick || !isInteractive()) {
    businessName = path.basename(cwd);
    businessDescription = 'General business operations';
    businessFocus = 'Our market, competitors, and growth opportunities';
    selectedUseCase = 'full-company';
  } else {
    const dirName = path.basename(cwd);

    writeLine(chalk.bold('  Tell us about your business:'));
    writeLine();

    businessName = await prompt(
      'Company or project name?',
      dirName
    );

    businessDescription = await prompt(
      'What does it do? (one sentence)',
      ''
    );

    writeLine();

    businessFocus = await prompt(
      'What should your first research squad investigate?',
      'Our market, competitors, and growth opportunities'
    );

    // 4b. Use-case selection
    selectedUseCase = await promptUseCase();
  }

  const useCaseConfig = getUseCaseConfig(selectedUseCase);

  // Calculate totals (core squads + use-case squads)
  const coreAgentCount = 12; // company(5) + research(4) + intelligence(3)
  const coreSquadCount = 3;
  const useCaseAgentCount = useCaseConfig.squads.reduce((sum, s) => sum + s.agentCount, 0);
  const totalAgentCount = coreAgentCount + useCaseAgentCount;
  const totalSquadCount = coreSquadCount + useCaseConfig.squads.length;

  writeLine();
  writeLine(`  ${chalk.green('✓')} Business: ${chalk.cyan(businessName)}${businessDescription ? chalk.dim(` — ${businessDescription}`) : ''}`);
  writeLine(`  ${chalk.green('✓')} Provider: ${chalk.cyan(provider?.name || selectedProvider)}`);
  writeLine(`  ${chalk.green('✓')} Research focus: ${chalk.cyan(businessFocus)}`);
  writeLine(`  ${chalk.green('✓')} Use case: ${chalk.cyan(useCaseConfig.label)} ${chalk.dim(`— ${useCaseConfig.description}`)}`);
  writeLine();

  // 5. Create the seed
  const spinner = ora('Planting the seed...').start();

  try {
    const variables: TemplateVariables = {
      BUSINESS_NAME: businessName,
      BUSINESS_DESCRIPTION: businessDescription || `${businessName} — details to be added by the manager agent.`,
      BUSINESS_FOCUS: businessFocus,
      PROVIDER: selectedProvider,
      PROVIDER_NAME: provider?.name || 'Unknown',
    };

    // Core directories (always created)
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

    // Add use-case specific directories
    for (const squad of useCaseConfig.squads) {
      dirs.push(...squad.dirs);
    }

    if (selectedProvider === 'claude') {
      dirs.push('.claude');
    }

    for (const dir of dirs) {
      await fs.mkdir(path.join(cwd, dir), { recursive: true });
    }

    spinner.text = 'Creating squad definitions...';

    // Core squad files (always created)
    const companyFiles: [string, string][] = [
      ['.agents/squads/company/SQUAD.md', 'squads/company/SQUAD.md'],
      ['.agents/squads/company/manager.md', 'squads/company/manager.md'],
      ['.agents/squads/company/event-dispatcher.md', 'squads/company/event-dispatcher.md'],
      ['.agents/squads/company/goal-tracker.md', 'squads/company/goal-tracker.md'],
      ['.agents/squads/company/company-eval.md', 'squads/company/company-eval.md'],
      ['.agents/squads/company/company-critic.md', 'squads/company/company-critic.md'],
    ];

    const researchFiles: [string, string][] = [
      ['.agents/squads/research/SQUAD.md', 'squads/research/SQUAD.md'],
      ['.agents/squads/research/researcher.md', 'squads/research/researcher.md'],
      ['.agents/squads/research/analyst.md', 'squads/research/analyst.md'],
      ['.agents/squads/research/research-eval.md', 'squads/research/research-eval.md'],
      ['.agents/squads/research/research-critic.md', 'squads/research/research-critic.md'],
    ];

    const intelligenceFiles: [string, string][] = [
      ['.agents/squads/intelligence/SQUAD.md', 'squads/intelligence/SQUAD.md'],
      ['.agents/squads/intelligence/intel-lead.md', 'squads/intelligence/intel-lead.md'],
      ['.agents/squads/intelligence/intel-eval.md', 'squads/intelligence/intel-eval.md'],
      ['.agents/squads/intelligence/intel-critic.md', 'squads/intelligence/intel-critic.md'],
    ];

    // Collect all use-case squad files
    const useCaseFiles: [string, string][] = [];
    for (const squad of useCaseConfig.squads) {
      useCaseFiles.push(...squad.files);
    }

    // Write all squad files
    for (const [dest, template] of [...companyFiles, ...researchFiles, ...intelligenceFiles, ...useCaseFiles]) {
      const content = loadSeedTemplate(template, variables);
      await writeFile(path.join(cwd, dest), content);
    }

    spinner.text = 'Creating memory and config...';

    // Core memory state files
    const coreMemoryFiles: [string, string][] = [
      ['.agents/memory/company/manager/state.md', 'memory/company/manager/state.md'],
      ['.agents/memory/research/researcher/state.md', 'memory/research/researcher/state.md'],
      ['.agents/memory/intelligence/intel-lead/state.md', 'memory/intelligence/intel-lead/state.md'],
    ];

    // Use-case memory state files
    const useCaseMemoryFiles: [string, string][] = [];
    for (const squad of useCaseConfig.squads) {
      useCaseMemoryFiles.push(...squad.memoryFiles);
    }

    for (const [dest, template] of [...coreMemoryFiles, ...useCaseMemoryFiles]) {
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
      useCase: selectedUseCase,
      agentCount: totalAgentCount,
      squadCount: totalSquadCount,
      hasBusinessName: businessName !== path.basename(cwd),
      hasBusinessDescription: businessDescription.length > 0,
    });

  } catch (error) {
    spinner.fail('Failed to plant the seed');
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'EACCES' || err?.code === 'EPERM') {
      writeLine(chalk.red('  Permission denied — cannot write to this directory.'));
      writeLine(chalk.dim('  Try running in a directory you own, or check folder permissions.'));
    } else if (err?.code === 'ENOENT') {
      writeLine(chalk.red(`  Could not find or create: ${err.path || 'unknown path'}`));
      writeLine(chalk.dim('  Check that the directory exists and you have write access.'));
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      writeLine(chalk.red(`  ${msg}`));
      writeLine(chalk.dim('  Run with --verbose for more details, or check squads doctor.'));
    }
    process.exit(1);
  }

  // 6. Success message
  writeLine();
  writeLine(chalk.green.bold(`  ${businessName}'s AI workforce is ready.`));
  writeLine();
  writeLine(chalk.dim('  Created:'));

  // Core squads (always present)
  writeLine(chalk.dim('  • .agents/squads/company/       5 agents (manager, dispatcher, tracker, eval, critic)'));
  writeLine(chalk.dim('  • .agents/squads/research/      4 agents (researcher, analyst, eval, critic)'));
  writeLine(chalk.dim('  • .agents/squads/intelligence/  3 agents (intel-lead, eval, critic)'));

  // Use-case specific squads
  for (const squad of useCaseConfig.squads) {
    const padding = ' '.repeat(Math.max(0, 22 - squad.name.length));
    writeLine(chalk.dim(`  • .agents/squads/${squad.name}/${padding}${squad.agentCount} agents (${squad.agentSummary})`));
  }

  writeLine(chalk.dim('  • .agents/skills/               CLI + GitHub workflow skills'));
  writeLine(chalk.dim('  • .agents/memory/               Persistent state'));
  writeLine(chalk.dim('  • .agents/BUSINESS_BRIEF.md'));
  if (selectedProvider === 'claude') {
    writeLine(chalk.dim('  • CLAUDE.md                     Operating manual'));
    writeLine(chalk.dim('  • .claude/settings.json         Session hooks'));
  }
  writeLine();
  writeLine(chalk.bold('  Getting started:'));
  writeLine();
  writeLine(`     ${chalk.cyan('1.')} ${chalk.yellow('git add -A && git commit -m "feat: init AI workforce"')}`);
  writeLine(chalk.dim('        Git is the coordination layer — commit first'));
  writeLine();

  // Dynamic "first run" suggestion based on use case
  const firstRunCommand = getFirstRunCommand(selectedUseCase);
  writeLine(`     ${chalk.cyan('2.')} ${chalk.yellow(firstRunCommand.command)}`);
  writeLine(chalk.dim(`        ${firstRunCommand.description}`));
  writeLine();
  writeLine(`     ${chalk.cyan('3.')} ${chalk.yellow(`squads dash`)}`);
  writeLine(chalk.dim('        See all your squads and agents at a glance'));
  writeLine();
  writeLine(chalk.dim('  Docs: https://agents-squads.com/docs/getting-started'));
  writeLine();
}

/**
 * Get the suggested first command based on use case
 */
function getFirstRunCommand(useCase: UseCase): { command: string; description: string } {
  switch (useCase) {
    case 'engineering':
      return {
        command: 'squads run engineering/issue-solver',
        description: 'Your first agent finds and solves GitHub issues',
      };
    case 'marketing':
      return {
        command: 'squads run marketing/content-drafter',
        description: 'Your first agent drafts content for your business',
      };
    case 'operations':
      return {
        command: 'squads run operations/ops-lead',
        description: 'Your first agent starts running daily operations',
      };
    case 'full-company':
      return {
        command: 'squads run research/researcher',
        description: 'Your first agent researches the topic you set',
      };
    case 'custom':
    default:
      return {
        command: 'squads run research/researcher',
        description: 'Your first agent researches the topic you set',
      };
  }
}
