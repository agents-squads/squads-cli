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
import { execSync } from 'child_process';
import { createInterface } from 'readline';
import { checkGitStatus, getRepoName } from '../lib/git.js';
import { track, Events } from '../lib/telemetry.js';
import { existsSync, readFileSync } from 'fs';
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
  pack?: string[];
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
  description: string;
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
      description: 'Enterprise — Engineering + Marketing + Operations',
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

function getProductSquad(): SquadConfig {
  return {
    name: 'product',
    description: 'Roadmap, specs, user feedback synthesis',
    agentCount: 3,
    agentSummary: 'lead, scanner, worker',
    dirs: [
      '.agents/squads/product',
      '.agents/memory/product/lead',
      '.agents/memory/product/scanner',
      '.agents/memory/product/worker',
    ],
    files: [
      ['.agents/squads/product/SQUAD.md', 'squads/product/SQUAD.md'],
      ['.agents/squads/product/lead.md', 'squads/product/lead.md'],
      ['.agents/squads/product/scanner.md', 'squads/product/scanner.md'],
      ['.agents/squads/product/worker.md', 'squads/product/worker.md'],
    ],
    memoryFiles: [
      ['.agents/memory/product/lead/state.md', 'memory/product/lead/state.md'],
    ],
  };
}

function getEngineeringSquad(): SquadConfig {
  return {
    name: 'engineering',
    description: 'Solves GitHub issues, reviews code, writes tests',
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
    description: 'Creates content, grows audience, tracks growth',
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
    description: 'Runs daily ops, tracks finances and goals',
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

interface ProjectInfo {
  name: string;
  type: 'product' | 'domain';
  stack: string;
  repoName: string;
  buildCommand: string | null;
  testCommand: string | null;
}

/**
 * Auto-detect project metadata from the filesystem
 */
function detectProjectInfo(cwd: string, gitStatus: { remoteUrl?: string }): ProjectInfo {
  const dirName = path.basename(cwd);

  // Name: from git remote (last segment) or directory name
  let name = dirName;
  let repoName = dirName;
  if (gitStatus.remoteUrl) {
    const full = getRepoName(gitStatus.remoteUrl);
    if (full) {
      repoName = full;
      name = full.includes('/') ? full.split('/')[1] : full;
    }
  }

  // Stack: detect from project files
  let stack = 'unknown';
  let type: 'product' | 'domain' = 'domain';
  let buildCommand: string | null = null;
  let testCommand: string | null = null;

  if (existsSync(path.join(cwd, 'package.json'))) {
    stack = 'node';
    type = 'product';
    buildCommand = 'npm run build';
    testCommand = 'npm test';
    // Check for specific frameworks
    try {
      const pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next']) stack = 'next';
      else if (deps['nuxt']) stack = 'nuxt';
      else if (deps['astro']) stack = 'astro';
      else if (deps['react']) stack = 'react';
      else if (deps['vue']) stack = 'vue';
    } catch { /* ignore */ }
  } else if (existsSync(path.join(cwd, 'go.mod'))) {
    stack = 'go';
    type = 'product';
    buildCommand = 'go build ./...';
    testCommand = 'go test ./...';
  } else if (
    existsSync(path.join(cwd, 'requirements.txt')) ||
    existsSync(path.join(cwd, 'pyproject.toml')) ||
    existsSync(path.join(cwd, 'setup.py'))
  ) {
    stack = 'python';
    type = 'product';
    testCommand = 'pytest';
  } else if (existsSync(path.join(cwd, 'Gemfile'))) {
    stack = 'ruby';
    type = 'product';
    testCommand = 'bundle exec rspec';
  } else if (existsSync(path.join(cwd, 'Cargo.toml'))) {
    stack = 'rust';
    type = 'product';
    buildCommand = 'cargo build';
    testCommand = 'cargo test';
  }

  return { name, type, stack, repoName, buildCommand, testCommand };
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

  // 4. Detect project info (used for IDP catalog)
  const projectInfo = detectProjectInfo(cwd, gitStatus);

  // Ask about the business
  let businessName: string;
  let businessDescription: string;
  let businessFocus: string;
  let businessCompetitors: string;
  let selectedUseCase: UseCase;

  if (options.yes || options.quick || !isInteractive()) {
    businessName = path.basename(cwd);
    businessDescription = 'A startup building and integrating AI smart capabilities for autonomous execution.';
    businessFocus = 'Track the big AI players — Anthropic, OpenAI, Google, Amazon, Meta, and xAI: latest model releases, API changes, pricing shifts, and strategic moves that affect builders.';
    businessCompetitors = '';
    selectedUseCase = 'custom'; // Core 4 squads only; use --pack for more
  } else {
    const dirName = path.basename(cwd);

    writeLine(chalk.bold('  Tell us about your business:'));
    writeLine(chalk.dim('  (Agents read this to produce useful output — be specific)'));
    writeLine();

    businessName = await prompt(
      'Company or project name?',
      dirName
    );

    writeLine(chalk.dim('    e.g., "We sell handmade coffee mugs online" or "B2B SaaS for construction teams"'));
    businessDescription = await prompt(
      'What does it do? (one sentence)',
      ''
    );
    // Require a non-empty description — empty = generic output on first run
    if (!businessDescription) {
      writeLine(chalk.dim(`    Tip: Without a description, agents produce generic output. You can edit .agents/BUSINESS_BRIEF.md later.`));
      businessDescription = `${businessName} — add your business description to .agents/BUSINESS_BRIEF.md`;
    }

    writeLine();
    writeLine(chalk.dim('    e.g., "Identify our top 3 competitors and what they do better than us"'));
    businessFocus = await prompt(
      'What should your agents research first?',
      'Our market position, top competitors, and biggest growth opportunity'
    );

    writeLine();
    writeLine(chalk.dim('    e.g., "BlueCart, MarketMan" — leave blank to skip'));
    businessCompetitors = await prompt(
      'Who are your main competitors? (optional)',
      ''
    );

    // 4b. Additional packs
    if (!options.pack) {
      writeLine();
      writeLine(chalk.bold('  Add squad packs? (optional)'));
      writeLine();
      writeLine(`  ${chalk.cyan('1)')} Core only ${chalk.dim('— intelligence, research, product, company')} ${chalk.green('(recommended)')}`);
      writeLine(`  ${chalk.cyan('2)')} + Engineering ${chalk.dim('— issue-solver, code-reviewer, test-writer')}`);
      writeLine(`  ${chalk.cyan('3)')} + All packs ${chalk.dim('— engineering, marketing, operations')}`);
      writeLine();

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const packChoice = await new Promise<string>((resolve) => {
        rl.question(`  ${chalk.dim('Enter choice [1-3]:')} `, (answer) => {
          rl.close();
          resolve(answer.trim() || '1');
        });
      });

      if (packChoice === '2') {
        options.pack = ['engineering'];
      } else if (packChoice === '3') {
        options.pack = ['all'];
      }
    }

    selectedUseCase = 'custom'; // Core 4 squads; packs handled separately
  }

  const useCaseConfig = getUseCaseConfig(selectedUseCase);

  // 4c. Pack support
  if (options.pack && options.pack.length > 0) {
    const additionalSquads: SquadConfig[] = [];
    for (const pack of options.pack) {
      if (pack === 'engineering') additionalSquads.push(getEngineeringSquad());
      if (pack === 'marketing') additionalSquads.push(getMarketingSquad());
      if (pack === 'operations') additionalSquads.push(getOperationsSquad());
      if (pack === 'all') {
        additionalSquads.push(getEngineeringSquad(), getMarketingSquad(), getOperationsSquad());
      }
    }
    // De-duplicate squads by name
    const existingNames = new Set(useCaseConfig.squads.map(s => s.name));
    for (const squad of additionalSquads) {
      if (!existingNames.has(squad.name)) {
        useCaseConfig.squads.push(squad);
        existingNames.add(squad.name);
      }
    }
  }

  // Calculate totals (core squads + use-case squads)
  const coreAgentCount = 14; // company(5) + research(3) + intelligence(3) + product(3)
  const coreSquadCount = 4;
  const useCaseAgentCount = useCaseConfig.squads.reduce((sum, s) => sum + s.agentCount, 0);
  const totalAgentCount = coreAgentCount + useCaseAgentCount;
  const totalSquadCount = coreSquadCount + useCaseConfig.squads.length;

  writeLine();
  writeLine(`  ${chalk.green('✓')} Business: ${chalk.cyan(businessName)}${businessDescription ? chalk.dim(` — ${businessDescription}`) : ''}`);
  writeLine(`  ${chalk.green('✓')} Provider: ${chalk.cyan(provider?.name || selectedProvider)}`);
  writeLine(`  ${chalk.green('✓')} Research focus: ${chalk.cyan(businessFocus)}`);
  if (businessCompetitors) {
    writeLine(`  ${chalk.green('✓')} Competitors: ${chalk.cyan(businessCompetitors)}`);
  }
  if (options.pack && options.pack.length > 0) {
    writeLine(`  ${chalk.green('✓')} Packs: ${chalk.cyan(options.pack.join(', '))}`);
  }
  writeLine();

  // 5. Create the seed
  const spinner = ora('Planting the seed...').start();

  try {
    // Only show PLACEHOLDER sentinel when user skipped the description in interactive mode
    const isPlaceholder = businessDescription.includes('add your business description');
    const variables: TemplateVariables = {
      BUSINESS_NAME: businessName,
      BUSINESS_DESCRIPTION: businessDescription || `${businessName} — details to be added by the manager agent.`,
      BUSINESS_FOCUS: businessFocus,
      COMPETITORS_SECTION: businessCompetitors
        ? `## Competitors\n\n${businessCompetitors}\n\n`
        : '',
      PLACEHOLDER_SENTINEL: isPlaceholder
        ? '<!-- STATUS: PLACEHOLDER — Edit this file before running agents. -->\n<!-- Agents that read "PLACEHOLDER" in this comment will ask you to fill it in. -->\n\n'
        : '',
      PROVIDER: selectedProvider,
      PROVIDER_NAME: provider?.name || 'Unknown',
      CURRENT_DATE: new Date().toISOString().split('T')[0],
    };

    // Core directories (always created)
    const dirs = [
      '.agents/squads/company',
      '.agents/squads/research',
      '.agents/squads/intelligence',
      '.agents/squads/product',
      '.agents/memory/company/manager',
      '.agents/memory/company/event-dispatcher',
      '.agents/memory/company/goal-tracker',
      '.agents/memory/company/company-eval',
      '.agents/memory/company/company-critic',
      '.agents/memory/research/lead',
      '.agents/memory/research/analyst',
      '.agents/memory/research/synthesizer',
      '.agents/memory/intelligence/intel-lead',
      '.agents/memory/intelligence/intel-eval',
      '.agents/memory/intelligence/intel-critic',
      '.agents/memory/product/lead',
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
      ['.agents/squads/research/lead.md', 'squads/research/lead.md'],
      ['.agents/squads/research/analyst.md', 'squads/research/analyst.md'],
      ['.agents/squads/research/synthesizer.md', 'squads/research/synthesizer.md'],
    ];

    const intelligenceFiles: [string, string][] = [
      ['.agents/squads/intelligence/SQUAD.md', 'squads/intelligence/SQUAD.md'],
      ['.agents/squads/intelligence/intel-lead.md', 'squads/intelligence/intel-lead.md'],
      ['.agents/squads/intelligence/intel-eval.md', 'squads/intelligence/intel-eval.md'],
      ['.agents/squads/intelligence/intel-critic.md', 'squads/intelligence/intel-critic.md'],
    ];

    const productFiles: [string, string][] = getProductSquad().files;

    // Collect all use-case squad files
    const useCaseFiles: [string, string][] = [];
    for (const squad of useCaseConfig.squads) {
      useCaseFiles.push(...squad.files);
    }

    // Write all squad files
    for (const [dest, template] of [...companyFiles, ...researchFiles, ...intelligenceFiles, ...productFiles, ...useCaseFiles]) {
      const content = loadSeedTemplate(template, variables);
      await writeFile(path.join(cwd, dest), content);
    }

    spinner.text = 'Creating memory and config...';

    // Core memory state files
    const coreMemoryFiles: [string, string][] = [
      ['.agents/memory/company/manager/state.md', 'memory/company/manager/state.md'],
      ['.agents/memory/research/lead/state.md', 'memory/research/lead/state.md'],
      ['.agents/memory/intelligence/intel-lead/state.md', 'memory/intelligence/intel-lead/state.md'],
      ['.agents/memory/product/lead/state.md', 'memory/product/lead/state.md'],
    ];

    // Use-case memory state files
    const useCaseMemoryFiles: [string, string][] = [];
    for (const squad of useCaseConfig.squads) {
      useCaseMemoryFiles.push(...squad.memoryFiles);
    }

    for (const [dest, template] of [...coreMemoryFiles, ...useCaseMemoryFiles]) {
      await writeIfNew(path.join(cwd, dest), loadSeedTemplate(template, variables));
    }

    // Squad-level priorities and goals (all squads including use-case squads)
    const reviewDate = new Date();
    reviewDate.setDate(reviewDate.getDate() + 14);
    const allSquads = [
      { name: 'company', label: 'Company', lead: 'manager' },
      { name: 'research', label: 'Research', lead: 'lead' },
      { name: 'intelligence', label: 'Intelligence', lead: 'intel-lead' },
      { name: 'product', label: 'Product', lead: 'lead' },
      ...useCaseConfig.squads.map(s => ({
        name: s.name,
        label: s.name.charAt(0).toUpperCase() + s.name.slice(1),
        lead: s.agentSummary.split(',')[0].trim(),
      })),
    ];
    for (const squad of allSquads) {
      const squadVars: TemplateVariables = {
        ...variables,
        SQUAD_NAME: squad.name,
        SQUAD_LABEL: squad.label,
        SQUAD_LEAD: squad.lead,
        REVIEW_DATE: reviewDate.toISOString().split('T')[0],
      };
      await writeIfNew(
        path.join(cwd, `.agents/memory/${squad.name}/priorities.md`),
        loadSeedTemplate('memory/_squad/priorities.md', squadVars),
      );
      await writeIfNew(
        path.join(cwd, `.agents/memory/${squad.name}/goals.md`),
        loadSeedTemplate('memory/_squad/goals.md', squadVars),
      );
    }

    // Skills
    const skillContent = loadSeedTemplate('skills/squads-cli/SKILL.md', variables);
    await writeFile(path.join(cwd, '.agents/skills/squads-cli/SKILL.md'), skillContent);

    const skillRefContent = loadSeedTemplate('skills/squads-cli/references/commands.md', variables);
    await writeFile(path.join(cwd, '.agents/skills/squads-cli/references/commands.md'), skillRefContent);

    const ghSkillContent = loadSeedTemplate('skills/gh/SKILL.md', variables);
    await writeFile(path.join(cwd, '.agents/skills/gh/SKILL.md'), ghSkillContent);

    // Provider config
    const providerConfig = loadSeedTemplate('config/provider.yaml', variables);
    await writeFile(path.join(cwd, '.agents/config/provider.yaml'), providerConfig);

    // System protocol (Layer 0 of context cascade)
    const systemMd = loadSeedTemplate('config/SYSTEM.md', variables);
    await writeFile(path.join(cwd, '.agents/config/SYSTEM.md'), systemMd);

    // IDP catalog entry (only if .agents/idp/ doesn't already exist)
    const idpCatalogDir = path.join(cwd, '.agents', 'idp', 'catalog');
    if (!existsSync(idpCatalogDir)) {
      const ownerSquad = useCaseConfig.squads[0]?.name || 'engineering';
      const isProduct = projectInfo.type === 'product';
      const idpVariables: TemplateVariables = {
        ...variables,
        SERVICE_NAME: projectInfo.name,
        SERVICE_TYPE: projectInfo.type,
        SERVICE_STACK: projectInfo.stack,
        SERVICE_SCORECARD: isProduct ? 'product' : 'domain',
        REPO_NAME: projectInfo.repoName,
        OWNER_SQUAD: ownerSquad,
        BRANCHES_WORKFLOW: isProduct ? 'pr-to-develop' : 'direct-to-main',
        BRANCHES_DEVELOPMENT: isProduct ? 'develop' : '',
        CI_TEMPLATE: isProduct ? projectInfo.stack : 'null',
        BUILD_COMMAND: projectInfo.buildCommand ?? 'null',
        TEST_COMMAND: projectInfo.testCommand ?? 'null',
      };
      const catalogContent = loadSeedTemplate('idp/catalog/service.yaml.template', idpVariables);
      await writeFile(path.join(idpCatalogDir, `${projectInfo.name}.yaml`), catalogContent);
    }

    // Company context (Layer 1 of context cascade)
    const companyMd = loadSeedTemplate('memory/company/company.md', variables);
    await writeIfNew(path.join(cwd, '.agents/memory/company/company.md'), companyMd);

    // Directives (Layer 3 of context cascade)
    const directivesMd = loadSeedTemplate('memory/company/directives.md', variables);
    await writeIfNew(path.join(cwd, '.agents/memory/company/directives.md'), directivesMd);

    // Business brief
    const businessBrief = loadSeedTemplate('BUSINESS_BRIEF.md.template', variables);
    await writeFile(path.join(cwd, '.agents/BUSINESS_BRIEF.md'), businessBrief);

    // AGENTS.md (repo root — vendor-neutral agent instructions)
    const agentsMd = loadTemplate('core/AGENTS.md.template', variables);
    await writeIfNew(path.join(cwd, 'AGENTS.md'), agentsMd);

    // README.md (only if it doesn't already exist or is the default single-line stub)
    const readmePath = path.join(cwd, 'README.md');
    let existingReadme = '';
    try {
      existingReadme = await fs.readFile(readmePath, 'utf-8');
    } catch {
      // File doesn't exist
    }
    const isStub = existingReadme.trim() === '' || /^# [^\n]+\s*$/.test(existingReadme.trim());
    if (isStub) {
      const readmeContent = loadSeedTemplate('README.md.template', variables);
      await writeFile(readmePath, readmeContent);
    }

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

  // 5b. Auto-commit scaffolding (agents need at least one commit for worktrees)
  try {
    execSync('git add -A && git commit -q -m "feat: init AI workforce\n\nCo-Authored-By: Claude <noreply@anthropic.com>"', {
      cwd,
      stdio: 'ignore',
    });
  } catch {
    // Commit may fail if nothing to add or git not configured — non-fatal
  }

  // 6. Success message
  writeLine();
  writeLine(chalk.green.bold(`  ${businessName}'s AI workforce is ready.`));
  writeLine();
  writeLine(chalk.dim('  Created:'));

  // Core squads (always present)
  writeLine(chalk.dim('  • research/    3 agents — Researches your market, competitors, and opportunities'));
  writeLine(chalk.dim('  • company/     5 agents — Manages goals, events, and strategy'));
  writeLine(chalk.dim('  • intelligence/ 3 agents — Monitors trends and competitive signals'));
  writeLine(chalk.dim('  • product/      3 agents — Roadmap, specs, user feedback synthesis'));

  // Additional pack squads
  for (const squad of useCaseConfig.squads) {
    const namePad = ' '.repeat(Math.max(0, 14 - squad.name.length));
    writeLine(chalk.dim(`  • ${squad.name}/${namePad}${squad.agentCount} agents — ${squad.description}`));
  }

  writeLine(chalk.dim('  • .agents/skills/               CLI + GitHub workflow skills'));
  writeLine(chalk.dim('  • .agents/memory/               Persistent state'));
  writeLine(chalk.dim('  • .agents/BUSINESS_BRIEF.md'));
  writeLine(chalk.dim('  • AGENTS.md                     Agent instructions (vendor-neutral)'));
  if (selectedProvider === 'claude') {
    writeLine(chalk.dim('  • CLAUDE.md                     Operating manual'));
    writeLine(chalk.dim('  • .claude/settings.json         Session hooks'));
  }
  writeLine();
  writeLine(chalk.bold('  Getting started:'));
  writeLine();
  writeLine(`     ${chalk.cyan('1.')} ${chalk.yellow('$EDITOR .agents/BUSINESS_BRIEF.md')}`);
  writeLine(chalk.dim('        Set your business context — agents use this for every run'));
  writeLine();
  // Dynamic "first run" suggestion based on use case
  const firstRunCommand = getFirstRunCommand(selectedUseCase);
  const squadCommand = firstRunCommand.command.replace(/\/[^/]+$/, '');
  writeLine(`     ${chalk.cyan('2.')} ${chalk.yellow(firstRunCommand.command)}`);
  writeLine(chalk.dim(`        ${firstRunCommand.description}`));
  writeLine(chalk.dim(`        Full squad (4+ agents, longer): ${squadCommand}`));
  writeLine();
  writeLine(`     ${chalk.cyan('3.')} ${chalk.yellow(`squads run`)}`);
  writeLine(chalk.dim('        Autopilot — runs all squads on schedule, learns between cycles'));
  writeLine(chalk.dim(`        Options: squads run --once (single cycle), squads run -i 15 --budget 50`));
  writeLine();
  writeLine(chalk.dim('  Docs: https://agents-squads.com/docs/getting-started'));
  writeLine();
  }

/**
 * Get the suggested first command based on installed packs
 */
function getFirstRunCommand(useCase: UseCase): { command: string; description: string } {
  switch (useCase) {
    case 'engineering':
      return {
        command: 'squads run engineering/issue-solver',
        description: 'Run a single agent — finds and solves GitHub issues (~2 min)',
      };
    case 'marketing':
      return {
        command: 'squads run marketing/content-drafter',
        description: 'Run a single agent — drafts content for your business (~2 min)',
      };
    case 'operations':
      return {
        command: 'squads run operations/ops-lead',
        description: 'Run a single agent — coordinates daily operations (~2 min)',
      };
    case 'full-company':
    case 'custom':
    default:
      return {
        command: 'squads run research/lead',
        description: 'Run a single agent — researches the topic you set (~2 min)',
      };
  }
}

