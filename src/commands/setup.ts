/**
 * squads setup - Guided interactive onboarding
 *
 * Transforms `squads init` from "dump files and hope" into a guided experience:
 * 1. Sets up all infrastructure
 * 2. Validates all requirements
 * 3. Helps user define their first real goal
 * 4. Creates their first squad to accomplish it
 * 5. Runs the full workflow (issue -> PR -> slack)
 */

import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { homedir } from 'os';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';
import {
  checkDockerPrereqs,
  checkClaudeCli,
  checkGhCli,
  checkGhPermissions,
  runPrereqChecks,
  runAuthChecks,
  displayCheckResults,
  attemptFix,
  waitForService,
  isDockerRunning,
  commandExists,
  PROVIDERS,
  type CheckResult,
} from '../lib/setup-checks.js';
import {
  loadTemplate,
  loadTemplateDirectory,
  toKebabCase,
  toTitleCase,
  getTemplateSource,
  isUsingRepoTemplates,
  getDomainStarters,
  getDomainStarterPath,
  type TemplateVariables,
} from '../lib/templates.js';
import { stackUpCommand, stackHealthCommand } from './stack.js';
import { checkGitStatus, getRepoName } from '../lib/git.js';
import { track, Events } from '../lib/telemetry.js';

export interface SetupOptions {
  resume?: boolean;
  yes?: boolean;
  provider?: string;
  skipInfra?: boolean;
}

export type SetupStep =
  | 'prereqs'
  | 'infra'
  | 'auth'
  | 'goal'
  | 'create'
  | 'execute'
  | 'complete';

interface SetupState {
  step: SetupStep;
  provider: string;
  squadName?: string;
  squadId?: string;
  goal?: string;
  infraReady?: boolean;
  authReady?: boolean;
  domainStarter?: string;  // Selected domain starter (if any)
  createdAt: string;
  updatedAt: string;
}

const STATE_FILE = path.join(homedir(), '.squads', 'setup-state.json');

/**
 * Load saved setup state for resume functionality
 */
function loadState(): SetupState | null {
  try {
    if (existsSync(STATE_FILE)) {
      const content = readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Save setup state for resume
 */
function saveState(state: SetupState): void {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal
  }
}

/**
 * Clear saved state after completion
 */
function clearState(): void {
  try {
    if (existsSync(STATE_FILE)) {
      require('fs').unlinkSync(STATE_FILE);
    }
  } catch {
    // Non-fatal
  }
}

/**
 * Check if running in interactive mode
 */
function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Prompt for yes/no confirmation
 */
async function confirm(question: string, defaultYes = true, forceYes = false): Promise<boolean> {
  if (forceYes || !isInteractive()) {
    return defaultYes;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultYes ? '[Y/n]' : '[y/N]';

  return new Promise((resolve) => {
    rl.question(`  ${question} ${chalk.dim(suffix)} `, (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      if (normalized === '') {
        resolve(defaultYes);
      } else {
        resolve(normalized === 'y' || normalized === 'yes');
      }
    });
  });
}

/**
 * Prompt for text input
 */
async function promptText(question: string, defaultValue?: string): Promise<string> {
  if (!isInteractive()) {
    return defaultValue || '';
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const suffix = defaultValue ? chalk.dim(` [${defaultValue}]`) : '';

  return new Promise((resolve) => {
    rl.question(`  ${question}${suffix}: `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

/**
 * Prompt for provider selection
 */
async function promptProvider(forceProvider?: string): Promise<string> {
  if (forceProvider && forceProvider in PROVIDERS) {
    return forceProvider;
  }

  if (!isInteractive()) {
    return 'claude';
  }

  writeLine();
  writeLine(`  ${bold}Select your AI assistant:${RESET}`);
  writeLine();
  writeLine(`  ${colors.cyan}1)${RESET} Claude Code ${chalk.dim('(recommended)')}`);
  writeLine(`  ${colors.cyan}2)${RESET} Gemini`);
  writeLine(`  ${colors.cyan}3)${RESET} OpenAI GPT`);
  writeLine(`  ${colors.cyan}4)${RESET} Ollama ${chalk.dim('(local)')}`);
  writeLine(`  ${colors.cyan}5)${RESET} Cursor IDE`);
  writeLine(`  ${colors.cyan}6)${RESET} Aider`);
  writeLine(`  ${colors.cyan}7)${RESET} Other/None ${chalk.dim('(planning only)')}`);
  writeLine();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`  ${chalk.dim('Enter choice [1-7]:')} `, (answer) => {
      rl.close();
      const choice = answer.trim() || '1';
      switch (choice) {
        case '1': resolve('claude'); break;
        case '2': resolve('gemini'); break;
        case '3': resolve('openai'); break;
        case '4': resolve('ollama'); break;
        case '5': resolve('cursor'); break;
        case '6': resolve('aider'); break;
        case '7': resolve('none'); break;
        default: resolve('claude'); break;
      }
    });
  });
}

/**
 * Prompt for domain starter selection
 */
async function promptDomainStarter(): Promise<string | null> {
  const domains = getDomainStarters();

  if (domains.length === 0) {
    return null;
  }

  if (!isInteractive()) {
    return null;
  }

  writeLine();
  writeLine(`  ${bold}Domain Starters Available${RESET}`);
  writeLine(`  ${chalk.dim('Pre-configured squads for common use cases')}`);
  writeLine();

  const domainDescriptions: Record<string, string> = {
    'engineering': 'Platform & infrastructure automation',
    'research': 'Research & intelligence gathering',
    'marketing': 'Content creation & social media',
    'finance': 'Cost tracking & budgets',
    'operations': 'Process improvement & automation',
  };

  writeLine(`  ${colors.cyan}0)${RESET} Start from scratch ${chalk.dim('(blank template)')}`);

  domains.forEach((domain, i) => {
    const desc = domainDescriptions[domain] || '';
    writeLine(`  ${colors.cyan}${i + 1})${RESET} ${toTitleCase(domain)} ${chalk.dim(desc)}`);
  });

  writeLine();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`  ${chalk.dim(`Enter choice [0-${domains.length}]:`)} `, (answer) => {
      rl.close();
      const choice = parseInt(answer.trim() || '0', 10);
      if (choice === 0 || isNaN(choice)) {
        resolve(null);
      } else if (choice > 0 && choice <= domains.length) {
        resolve(domains[choice - 1]);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Step 1: Prerequisites check (Docker/Colima)
 */
async function stepPrereqs(state: SetupState, options: SetupOptions): Promise<boolean> {
  writeLine();
  writeLine(`  ${bold}Step 1: Prerequisites${RESET}`);
  writeLine();

  const checks = runPrereqChecks();
  const { hasErrors, errorChecks } = displayCheckResults(checks);

  if (hasErrors) {
    writeLine();

    // Offer to fix Docker
    const dockerCheck = errorChecks.find(c => c.name === 'Docker');
    if (dockerCheck?.fixCommand) {
      const shouldFix = await confirm(`Install Docker/Colima now?`, true, options.yes);
      if (shouldFix) {
        const success = await attemptFix(dockerCheck);
        if (!success) {
          writeLine(`  ${colors.red}${icons.error}${RESET} Failed to install. Please install manually.`);
          return false;
        }
        // Wait for Docker to be ready
        writeLine(`  ${colors.cyan}${icons.progress}${RESET} Waiting for Docker...`);
        const ready = await waitForService('Docker', isDockerRunning, 60, 2000);
        if (!ready) {
          writeLine(`  ${colors.red}${icons.error}${RESET} Docker not ready. Please start Docker Desktop.`);
          return false;
        }
      } else {
        writeLine();
        writeLine(`  ${chalk.dim('Install Docker, then run: squads setup --resume')}`);
        return false;
      }
    }

    // Offer to fix gh CLI
    const ghCheck = errorChecks.find(c => c.name === 'GitHub CLI');
    if (ghCheck?.fixCommand) {
      const shouldFix = await confirm(`Install GitHub CLI now?`, true, options.yes);
      if (shouldFix) {
        const success = await attemptFix(ghCheck);
        if (!success) {
          writeLine(`  ${colors.yellow}${icons.warning}${RESET} GitHub CLI install failed. Continuing without GitHub integration.`);
        }
      }
    }
  }

  writeLine();
  writeLine(`  ${colors.green}${icons.success}${RESET} Prerequisites ready`);
  return true;
}

/**
 * Step 2: Infrastructure setup (stack up + health)
 */
async function stepInfra(state: SetupState, options: SetupOptions): Promise<boolean> {
  if (options.skipInfra) {
    writeLine();
    writeLine(`  ${colors.dim}Skipping infrastructure setup (--skip-infra)${RESET}`);
    return true;
  }

  writeLine();
  writeLine(`  ${bold}Step 2: Infrastructure${RESET}`);
  writeLine();

  // Check if Docker is running
  if (!isDockerRunning()) {
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} Docker is not running`);

    if (commandExists('colima')) {
      const startColima = await confirm('Start Colima?', true, options.yes);
      if (startColima) {
        writeLine(`  ${colors.cyan}${icons.progress}${RESET} Starting Colima...`);
        try {
          execSync('colima start', { stdio: 'inherit' });
        } catch {
          writeLine(`  ${colors.red}${icons.error}${RESET} Failed to start Colima`);
          return false;
        }
      }
    } else {
      writeLine(`  ${chalk.dim('Please start Docker Desktop and run: squads setup --resume')}`);
      return false;
    }
  }

  // Start the stack
  writeLine(`  ${colors.cyan}${icons.progress}${RESET} Starting services...`);
  writeLine();

  try {
    await stackUpCommand();
  } catch (error) {
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} Stack startup had issues`);
    // Continue - may already be running
  }

  // Wait for health
  writeLine();
  writeLine(`  ${colors.cyan}${icons.progress}${RESET} Checking service health...`);

  let healthy = false;
  for (let i = 0; i < 3; i++) {
    try {
      await stackHealthCommand(false);
      healthy = true;
      break;
    } catch {
      if (i < 2) {
        writeLine(`  ${colors.dim}Retrying in 5 seconds...${RESET}`);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  if (!healthy) {
    writeLine();
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} Some services may not be healthy`);
    writeLine(`  ${chalk.dim('Check manually: squads stack health')}`);
    // Continue anyway - core services may still work
  }

  writeLine();
  writeLine(`  ${colors.green}${icons.success}${RESET} Infrastructure ready`);
  return true;
}

/**
 * Step 3: Auth validation (Claude + GH)
 */
async function stepAuth(state: SetupState, options: SetupOptions): Promise<boolean> {
  writeLine();
  writeLine(`  ${bold}Step 3: Authentication${RESET}`);
  writeLine();

  const checks = runAuthChecks(state.provider);
  const { hasErrors, errorChecks } = displayCheckResults(checks);

  if (hasErrors) {
    writeLine();

    // Try to fix Claude CLI
    const claudeCheck = errorChecks.find(c => c.name === 'Claude CLI');
    if (claudeCheck?.fixCommand) {
      const shouldInstall = await confirm('Install Claude CLI now?', true, options.yes);

      if (shouldInstall) {
        writeLine();
        writeLine(`  ${colors.cyan}${icons.progress}${RESET} Installing Claude CLI...`);

        try {
          execSync('npm install -g @anthropic-ai/claude-code', {
            stdio: 'inherit',
            timeout: 120000
          });
          writeLine();
          writeLine(`  ${colors.green}${icons.success}${RESET} Claude CLI installed`);
          writeLine();

          // Prompt for login
          writeLine(`  ${colors.cyan}${icons.progress}${RESET} Opening Claude login...`);
          writeLine();

          const loginProc = spawn('claude', ['login'], {
            stdio: 'inherit',
            shell: true
          });

          await new Promise<void>((resolve) => {
            loginProc.on('close', () => resolve());
          });

          writeLine();
          writeLine(`  ${colors.green}${icons.success}${RESET} Claude CLI ready`);
        } catch {
          writeLine(`  ${colors.red}${icons.error}${RESET} Failed to install Claude CLI`);
          writeLine(`  ${chalk.dim('Install manually: npm install -g @anthropic-ai/claude-code')}`);
          return false;
        }
      } else {
        writeLine(`  ${chalk.dim('Install Claude CLI, then run: squads setup --resume')}`);
        return false;
      }
    }

    // Try to fix GitHub permissions
    const ghCheck = errorChecks.find(c => c.name.includes('GitHub'));
    if (ghCheck?.fixCommand) {
      const shouldFix = await confirm('Fix GitHub permissions?', true, options.yes);
      if (shouldFix) {
        const success = await attemptFix(ghCheck);
        if (!success) {
          writeLine(`  ${colors.yellow}${icons.warning}${RESET} GitHub auth may have issues. Continuing anyway.`);
        }
      }
    }
  }

  writeLine();
  writeLine(`  ${colors.green}${icons.success}${RESET} Authentication ready`);
  return true;
}

/**
 * Step 4: First goal flow (interactive)
 */
async function stepGoal(state: SetupState, options: SetupOptions): Promise<boolean> {
  writeLine();
  writeLine(`  ${bold}Step 4: Your First Goal${RESET}`);
  writeLine();

  // If using a domain starter, pre-fill defaults
  const domainDefaults: Record<string, { name: string; goal: string }> = {
    'engineering': {
      name: 'Platform',
      goal: 'Maintain infrastructure and platform reliability',
    },
    'research': {
      name: 'Intelligence',
      goal: 'Research and analyze market trends',
    },
    'marketing': {
      name: 'Content',
      goal: 'Create and distribute engaging content',
    },
    'finance': {
      name: 'Cost Tracking',
      goal: 'Monitor and optimize AI spending',
    },
    'operations': {
      name: 'Process',
      goal: 'Improve and automate operational workflows',
    },
  };

  const defaults = state.domainStarter ? domainDefaults[state.domainStarter] : null;

  if (!isInteractive()) {
    // Default for non-interactive mode
    state.squadName = defaults?.name || 'My First Squad';
    state.squadId = toKebabCase(state.squadName);
    state.goal = defaults?.goal || 'Research and document the current state of the project';
    return true;
  }

  if (defaults) {
    writeLine(`  ${chalk.dim(`Using ${toTitleCase(state.domainStarter!)} starter defaults`)}`);
    writeLine(`  ${chalk.dim('Press Enter to accept or type to customize')}`);
    writeLine();
  } else {
    writeLine(`  ${chalk.dim('What do you want to accomplish with your first squad?')}`);
    writeLine(`  ${chalk.dim('Examples: "Build a landing page", "Research competitors", "Create API docs"')}`);
    writeLine();
  }

  const goal = await promptText('Your goal', defaults?.goal);

  if (!goal) {
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} No goal provided`);
    const defaultGoal = defaults?.goal || 'Research and document the current state of the project';
    writeLine(`  ${chalk.dim(`Using default: "${defaultGoal}"`)}`);
    state.goal = defaultGoal;
    state.squadName = defaults?.name || 'My First Squad';
    state.squadId = toKebabCase(state.squadName);
    return true;
  }

  state.goal = goal;

  writeLine();
  const squadName = await promptText('Squad name', defaults?.name || 'My First Squad');
  state.squadName = squadName || defaults?.name || 'My First Squad';
  state.squadId = toKebabCase(state.squadName);

  writeLine();
  writeLine(`  ${colors.green}${icons.success}${RESET} Goal: ${chalk.cyan(state.goal)}`);
  writeLine(`  ${colors.green}${icons.success}${RESET} Squad: ${chalk.cyan(state.squadName)} (${state.squadId})`);

  return true;
}

/**
 * Step 5: Create squad + files
 */
async function stepCreate(state: SetupState, options: SetupOptions): Promise<boolean> {
  writeLine();
  writeLine(`  ${bold}Step 5: Creating Squad${RESET}`);
  writeLine();

  const cwd = process.cwd();
  const spinner = ora('Creating squad structure...').start();

  try {
    const provider = PROVIDERS[state.provider];
    const variables: TemplateVariables = {
      SQUAD_NAME: state.squadName || 'My First Squad',
      SQUAD_ID: state.squadId || 'my-first-squad',
      SQUAD_DESCRIPTION: `Squad to accomplish: ${state.goal}`,
      GOAL: state.goal || 'Research and document the current state of the project',
      PROVIDER: state.provider,
      PROVIDER_NAME: provider?.name || 'Unknown',
    };

    // Create directory structure
    const dirs = [
      `.agents/squads/${variables.SQUAD_ID}`,
      `.agents/memory/${variables.SQUAD_ID}/lead`,
      `.agents/memory/getting-started`,
      '.agents/outputs',
      '.agents/config',
    ];

    // Add provider-specific directories
    if (state.provider === 'claude') {
      dirs.push('.claude', '.claude/skills', '.claude/skills/squads-workflow');
    } else if (state.provider === 'gemini') {
      dirs.push('.gemini');
    }

    for (const dir of dirs) {
      await fs.mkdir(path.join(cwd, dir), { recursive: true });
    }

    spinner.text = 'Loading templates...';

    // Create first squad - from domain starter or templates
    if (state.domainStarter) {
      const domainPath = getDomainStarterPath(state.domainStarter);
      if (domainPath) {
        spinner.text = `Loading ${state.domainStarter} domain starter...`;

        // Map domain to squad name in repo
        const domainSquadMap: Record<string, string> = {
          'engineering': 'platform',
          'research': 'intelligence',
          'marketing': 'content',
          'finance': 'cost-tracking',
          'operations': 'process',
        };

        const squadDirName = domainSquadMap[state.domainStarter] || state.domainStarter;
        const squadSourceDir = path.join(domainPath, '.agents', 'squads', squadDirName);

        // Copy SQUAD.md from domain starter
        const squadSourcePath = path.join(squadSourceDir, 'SQUAD.md');
        if (existsSync(squadSourcePath)) {
          let squadContent = readFileSync(squadSourcePath, 'utf-8');
          // Substitute variables
          for (const [key, value] of Object.entries(variables)) {
            if (value) {
              squadContent = squadContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
              squadContent = squadContent.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
            }
          }
          await fs.writeFile(
            path.join(cwd, `.agents/squads/${variables.SQUAD_ID}/SQUAD.md`),
            squadContent
          );
        }

        // Copy lead.md from domain starter
        const leadSourcePath = path.join(squadSourceDir, 'lead.md');
        if (existsSync(leadSourcePath)) {
          let leadContent = readFileSync(leadSourcePath, 'utf-8');
          for (const [key, value] of Object.entries(variables)) {
            if (value) {
              leadContent = leadContent.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
              leadContent = leadContent.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
            }
          }
          await fs.writeFile(
            path.join(cwd, `.agents/squads/${variables.SQUAD_ID}/lead.md`),
            leadContent
          );
        }
      } else {
        // Fallback to templates if domain path not found
        const squadMd = loadTemplate('first-squad/SQUAD.md.template', variables);
        const leadMd = loadTemplate('first-squad/lead.md.template', variables);
        await fs.writeFile(
          path.join(cwd, `.agents/squads/${variables.SQUAD_ID}/SQUAD.md`),
          squadMd
        );
        await fs.writeFile(
          path.join(cwd, `.agents/squads/${variables.SQUAD_ID}/lead.md`),
          leadMd
        );
      }
    } else {
      // Use bundled templates
      const squadMd = loadTemplate('first-squad/SQUAD.md.template', variables);
      const leadMd = loadTemplate('first-squad/lead.md.template', variables);

      await fs.writeFile(
        path.join(cwd, `.agents/squads/${variables.SQUAD_ID}/SQUAD.md`),
        squadMd
      );
      await fs.writeFile(
        path.join(cwd, `.agents/squads/${variables.SQUAD_ID}/lead.md`),
        leadMd
      );
    }

    // Create core files
    const agentsMd = loadTemplate('core/AGENTS.md.template', variables);
    const businessBrief = loadTemplate('core/BUSINESS_BRIEF.md.template', variables);
    const providerYaml = loadTemplate('core/provider.yaml.template', variables);
    const memoryState = loadTemplate('memory/getting-started/state.md.template', variables);

    await fs.writeFile(path.join(cwd, 'AGENTS.md'), agentsMd);
    await fs.writeFile(path.join(cwd, '.agents/BUSINESS_BRIEF.md'), businessBrief);
    await fs.writeFile(path.join(cwd, '.agents/config/provider.yaml'), providerYaml);
    await fs.writeFile(
      path.join(cwd, '.agents/memory/getting-started/state.md'),
      memoryState
    );

    // Create provider-specific files
    if (state.provider === 'claude') {
      const claudeMd = loadTemplate('core/CLAUDE.md.template', variables);
      await fs.writeFile(path.join(cwd, 'CLAUDE.md'), claudeMd);

      // Create Claude settings with hooks
      const claudeSettings = {
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'squads status',
                  timeout: 10,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: 'command',
                  command: 'squads memory sync && echo "\\n💡 Capture learnings: squads learn \\"<what you learned>\\"\\n"',
                  timeout: 15,
                },
              ],
            },
          ],
        },
      };

      await fs.writeFile(
        path.join(cwd, '.claude/settings.json'),
        JSON.stringify(claudeSettings, null, 2)
      );

      // Create squads-workflow skill
      const workflowSkill = loadTemplate('skills/squads-workflow/instruction.md', variables);
      await fs.writeFile(
        path.join(cwd, '.claude/skills/squads-workflow/instruction.md'),
        workflowSkill
      );
    }

    // Install git hooks if in a git repo
    const gitStatus = checkGitStatus(cwd);
    if (gitStatus.isGitRepo) {
      await installGitHooks(cwd);
    }

    spinner.succeed('Squad created');

    // Show what was created
    writeLine();
    writeLine(`  ${chalk.dim('Created:')}`);
    const squadDesc = state.domainStarter
      ? `${toTitleCase(state.domainStarter)} domain starter`
      : 'Your first squad';
    writeLine(`  ${chalk.dim(`• .agents/squads/${variables.SQUAD_ID}/  - ${squadDesc}`)}`);
    writeLine(`  ${chalk.dim('• .agents/config/                       - Provider configuration')}`);
    writeLine(`  ${chalk.dim('• .agents/memory/                       - Persistent memory')}`);
    writeLine(`  ${chalk.dim('• AGENTS.md                             - Agent instructions')}`);
    if (state.provider === 'claude') {
      writeLine(`  ${chalk.dim('• .claude/settings.json                 - Claude Code hooks')}`);
      writeLine(`  ${chalk.dim('• CLAUDE.md                             - Claude-specific instructions')}`);
    }

    // Track success
    await track(Events.CLI_INIT, {
      success: true,
      provider: state.provider,
      hasGoal: !!state.goal,
      squadName: state.squadId,
      domainStarter: state.domainStarter,
    });

    return true;

  } catch (error) {
    spinner.fail('Failed to create squad');
    writeLine(`  ${colors.red}${icons.error}${RESET} ${error}`);
    return false;
  }
}

/**
 * Step 6: Execute full cycle (optional)
 */
async function stepExecute(state: SetupState, options: SetupOptions): Promise<boolean> {
  writeLine();
  writeLine(`  ${bold}Step 6: Run Your Squad${RESET}`);
  writeLine();

  if (!isInteractive()) {
    writeLine(`  ${chalk.dim(`Run your squad with: squads run ${state.squadId} --execute`)}`);
    return true;
  }

  const shouldRun = await confirm(`Run your squad now?`, false, options.yes);

  if (!shouldRun) {
    writeLine();
    writeLine(`  ${chalk.dim(`Run later with: squads run ${state.squadId} --execute`)}`);
    return true;
  }

  writeLine();
  writeLine(`  ${colors.cyan}${icons.progress}${RESET} Launching squad...`);
  writeLine();

  try {
    // Create a GitHub issue for the goal (optional)
    if (commandExists('gh')) {
      try {
        execSync(
          `gh issue create --title "[${state.squadName}] ${state.goal}" --body "Created by squads setup.\n\nGoal: ${state.goal}\n\nSquad: ${state.squadId}"`,
          { stdio: 'pipe' }
        );
        writeLine(`  ${colors.green}${icons.success}${RESET} GitHub issue created`);
      } catch {
        // Non-fatal - may not have permissions
        writeLine(`  ${colors.dim}Skipped GitHub issue (no permissions or not a GitHub repo)${RESET}`);
      }
    }

    // Run the squad
    const runProc = spawn('squads', ['run', state.squadId!, '--execute'], {
      stdio: 'inherit',
      shell: true
    });

    await new Promise<void>((resolve) => {
      runProc.on('close', () => resolve());
    });

    writeLine();
    writeLine(`  ${colors.green}${icons.success}${RESET} Squad execution complete`);

  } catch (error) {
    writeLine(`  ${colors.yellow}${icons.warning}${RESET} Execution had issues: ${error}`);
    writeLine(`  ${chalk.dim(`You can run manually: squads run ${state.squadId} --execute`)}`);
  }

  return true;
}

/**
 * Install git hooks
 */
async function installGitHooks(cwd: string): Promise<void> {
  const hooksDir = path.join(cwd, '.git', 'hooks');

  try {
    await fs.mkdir(hooksDir, { recursive: true });

    // Post-commit hook for Slack sync
    const postCommitHook = `#!/bin/bash
# Auto-sync Slack channels when SQUAD.md files change
# Installed by: squads setup

CHANGED_SQUADS=$(git diff-tree --no-commit-id --name-only -r HEAD | grep "SQUAD.md" || true)

if [ -n "$CHANGED_SQUADS" ]; then
  echo "SQUAD.md changed - syncing Slack channels..."
  (
    sleep 1
    if [ -f ".env" ]; then
      export $(grep -E "^SLACK_BOT_TOKEN=" .env | xargs 2>/dev/null)
    fi
    if [ -n "$SLACK_BOT_TOKEN" ]; then
      squads slack sync 2>&1 | sed 's/^/  [slack-sync] /'
    fi
  ) &
fi
`;

    await fs.writeFile(path.join(hooksDir, 'post-commit'), postCommitHook, { mode: 0o755 });
  } catch {
    // Non-fatal
  }
}

/**
 * Main setup command entry point
 */
export async function setupCommand(options: SetupOptions): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}setup${RESET}`);
  writeLine();

  // Show template source
  const templateSource = getTemplateSource();
  if (templateSource.type === 'repo') {
    writeLine(`  ${colors.green}${icons.success}${RESET} Using templates from agents-squads repo`);
    writeLine(`  ${chalk.dim(`  ${templateSource.path}`)}`);
  } else if (templateSource.type === 'global') {
    writeLine(`  ${colors.cyan}${icons.progress}${RESET} Using global templates`);
    writeLine(`  ${chalk.dim('  ~/.squads/templates/')}`);
  } else {
    writeLine(`  ${chalk.dim('Using bundled templates')}`);
  }
  writeLine();

  // Check for resume
  let state: SetupState;

  if (options.resume) {
    const savedState = loadState();
    if (savedState) {
      writeLine(`  ${colors.cyan}${icons.progress}${RESET} Resuming from step: ${savedState.step}`);
      state = savedState;
    } else {
      writeLine(`  ${colors.yellow}${icons.warning}${RESET} No saved state found. Starting fresh.`);
      state = {
        step: 'prereqs',
        provider: 'claude',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
  } else {
    state = {
      step: 'prereqs',
      provider: 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  // Select provider first
  if (state.step === 'prereqs') {
    state.provider = await promptProvider(options.provider);
    const provider = PROVIDERS[state.provider];
    writeLine();
    writeLine(`  ${colors.green}${icons.success}${RESET} Provider: ${chalk.cyan(provider?.name || state.provider)}`);

    // Offer domain starters if using repo templates
    if (isUsingRepoTemplates()) {
      state.domainStarter = await promptDomainStarter() || undefined;
      if (state.domainStarter) {
        writeLine();
        writeLine(`  ${colors.green}${icons.success}${RESET} Domain: ${chalk.cyan(toTitleCase(state.domainStarter))}`);
      }
    }
  }

  // Run through steps
  const steps: Array<{
    name: SetupStep;
    fn: (state: SetupState, options: SetupOptions) => Promise<boolean>;
  }> = [
    { name: 'prereqs', fn: stepPrereqs },
    { name: 'infra', fn: stepInfra },
    { name: 'auth', fn: stepAuth },
    { name: 'goal', fn: stepGoal },
    { name: 'create', fn: stepCreate },
    { name: 'execute', fn: stepExecute },
  ];

  // Find starting step
  const startIndex = steps.findIndex(s => s.name === state.step);

  for (let i = startIndex; i < steps.length; i++) {
    const step = steps[i];
    state.step = step.name;
    state.updatedAt = new Date().toISOString();
    saveState(state);

    const success = await step.fn(state, options);

    if (!success) {
      writeLine();
      writeLine(`  ${colors.yellow}${icons.warning}${RESET} Setup paused at step: ${step.name}`);
      writeLine(`  ${chalk.dim('Resume with: squads setup --resume')}`);
      return;
    }
  }

  // Complete!
  state.step = 'complete';
  clearState();

  writeLine();
  writeLine(`  ${colors.green}${bold}${icons.success} Setup complete!${RESET}`);
  writeLine();
  writeLine(`  ${bold}Next steps:${RESET}`);
  writeLine();
  writeLine(`     ${chalk.yellow.bold('squads status')}          Overview of your squads`);
  writeLine(`     ${chalk.yellow.bold(`squads run ${state.squadId}`)}  Run your first squad`);
  writeLine(`     ${chalk.yellow.bold('squads dash')}            Full dashboard`);
  writeLine();
  writeLine(`  ${chalk.dim('Documentation: https://github.com/agents-squads/squads-cli')}`);
  writeLine();
}
