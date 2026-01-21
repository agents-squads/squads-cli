/**
 * squads init - Initialize a new squad project
 *
 * By default, runs the guided setup experience.
 * Use --quick for fast, non-interactive initialization (CI/automation).
 */

import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import { existsSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { checkGitStatus, getRepoName } from '../lib/git.js';
import { track, Events } from '../lib/telemetry.js';
import {
  loadTemplate,
  toKebabCase,
  type TemplateVariables,
} from '../lib/templates.js';
import {
  checkClaudeCli,
  checkGhCli,
  checkDockerPrereqs,
  commandExists,
  isDockerRunning,
  PROVIDERS,
  type CheckResult,
} from '../lib/setup-checks.js';
import { setupCommand } from './setup.js';

export interface InitOptions {
  template: string;
  skipInfra?: boolean;
  force?: boolean;
  yes?: boolean;
  provider?: string;
  quick?: boolean;  // Skip guided flow, just create files
}

type Provider = 'claude' | 'gemini' | 'openai' | 'ollama' | 'cursor' | 'aider' | 'none';

// Check if running in interactive mode (has TTY)
function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

// Simple yes/no prompt
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

// Provider selection prompt
async function promptProvider(forceProvider?: string): Promise<Provider> {
  if (forceProvider && forceProvider in PROVIDERS) {
    return forceProvider as Provider;
  }

  if (!isInteractive()) {
    return 'claude';
  }

  console.log();
  console.log(chalk.bold('  Select your AI assistant:'));
  console.log();
  console.log(`  ${chalk.cyan('1)')} Claude Code ${chalk.dim('(recommended)')}`);
  console.log(`  ${chalk.cyan('2)')} Gemini`);
  console.log(`  ${chalk.cyan('3)')} OpenAI GPT`);
  console.log(`  ${chalk.cyan('4)')} Ollama ${chalk.dim('(local)')}`);
  console.log(`  ${chalk.cyan('5)')} Cursor IDE`);
  console.log(`  ${chalk.cyan('6)')} Aider`);
  console.log(`  ${chalk.cyan('7)')} Other/None ${chalk.dim('(planning only)')}`);
  console.log();

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

// Check if Docker is running
function dockerRunning(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function installGitHooks(cwd: string): Promise<boolean> {
  const hooksDir = path.join(cwd, '.git', 'hooks');

  if (!(await fileExists(path.join(cwd, '.git')))) {
    return false;
  }

  try {
    await fs.mkdir(hooksDir, { recursive: true });

    const postCommitHook = `#!/bin/bash
# Auto-sync Slack channels when SQUAD.md files change
# Installed by: squads init

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
    return true;
  } catch {
    return false;
  }
}

async function setupInfrastructure(cwd: string): Promise<boolean> {
  const spinner = ora('Setting up infrastructure...').start();

  try {
    let dockerDir: string | null = null;

    const localDockerCompose = path.join(cwd, 'docker', 'docker-compose.yml');
    const localDockerComposeRoot = path.join(cwd, 'docker-compose.yml');

    if (await fileExists(localDockerCompose)) {
      dockerDir = path.join(cwd, 'docker');
    } else if (await fileExists(localDockerComposeRoot)) {
      dockerDir = cwd;
    } else {
      const cliPath = new URL('../..', import.meta.url).pathname;
      const bundledDockerCompose = path.join(cliPath, 'docker', 'docker-compose.yml');

      if (await fileExists(bundledDockerCompose)) {
        spinner.text = 'Copying infrastructure files...';
        const targetDockerDir = path.join(cwd, 'docker');
        await fs.mkdir(targetDockerDir, { recursive: true });

        const filesToCopy = ['docker-compose.yml', '.env.example', 'init-db.sql', 'README.md'];

        for (const file of filesToCopy) {
          const src = path.join(cliPath, 'docker', file);
          const dest = path.join(targetDockerDir, file);
          if (await fileExists(src)) {
            await fs.copyFile(src, dest);
          }
        }

        const bridgeSrc = path.join(cliPath, 'docker', 'squads-bridge');
        const bridgeDest = path.join(targetDockerDir, 'squads-bridge');
        if (await fileExists(bridgeSrc)) {
          await copyDir(bridgeSrc, bridgeDest);
        }

        const envExample = path.join(targetDockerDir, '.env.example');
        const envFile = path.join(targetDockerDir, '.env');
        if (await fileExists(envExample) && !(await fileExists(envFile))) {
          await fs.copyFile(envExample, envFile);
        }

        dockerDir = targetDockerDir;
      }
    }

    if (!dockerDir) {
      spinner.fail('Could not find docker-compose.yml');
      console.log(chalk.dim('  Try cloning the full repo: git clone https://github.com/agents-squads/hq'));
      return false;
    }

    spinner.text = 'Starting containers...';

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('docker', ['compose', 'up', '-d'], {
        cwd: dockerDir!,
        stdio: 'pipe',
      });

      let stderr = '';
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr || `docker compose failed with code ${code}`));
        }
      });

      proc.on('error', reject);
    });

    spinner.text = 'Waiting for services to be ready...';
    await sleep(3000);

    spinner.succeed('Infrastructure ready');
    console.log();
    console.log(chalk.dim('  Services running:'));
    console.log(chalk.dim('  • postgres:5432  • redis:6379  • bridge:8088'));
    return true;

  } catch (error) {
    spinner.fail('Failed to start infrastructure');
    console.log(chalk.dim(`  ${error}`));
    console.log(chalk.dim('  Try manually: cd docker && docker compose up -d'));
    return false;
  }
}

/**
 * Quick init - creates files without guided flow (for CI/automation)
 */
async function quickInit(options: InitOptions): Promise<void> {
  const cwd = process.cwd();

  // Select provider
  const selectedProvider = await promptProvider(options.provider);
  const provider = PROVIDERS[selectedProvider];

  console.log();
  console.log(`  ${chalk.green('✓')} Provider: ${chalk.cyan(provider?.name || selectedProvider)}`);

  // Check Git status
  console.log();
  console.log(chalk.dim('  Checking project setup...'));

  const gitStatus = checkGitStatus(cwd);

  if (!gitStatus.isGitRepo) {
    console.log(`  ${chalk.yellow('⚠')} No git repository found`);
    console.log(chalk.dim('    Run: git init && git remote add origin <repo-url>'));
  } else {
    console.log(`  ${chalk.green('✓')} Git repository`);
    if (gitStatus.hasRemote) {
      const repoName = getRepoName(gitStatus.remoteUrl);
      console.log(`  ${chalk.green('✓')} Remote: ${chalk.cyan(repoName || gitStatus.remoteUrl)}`);
    }
  }

  console.log();

  // Create project structure
  const spinner = ora('Creating squad structure...').start();

  try {
    const variables: TemplateVariables = {
      SQUAD_NAME: 'Demo Squad',
      SQUAD_ID: 'demo',
      SQUAD_DESCRIPTION: 'Research squad that creates a competitive analysis of enterprise AI agent frameworks.',
      GOAL: 'Generate a report comparing enterprise agent frameworks',
      PROVIDER: selectedProvider,
      PROVIDER_NAME: provider?.name || 'Unknown',
    };

    // Create directory structure
    const dirs = [
      '.agents/squads/demo',
      '.agents/memory',
      '.agents/memory/getting-started',
      '.agents/memory/general/shared',
      '.agents/outputs',
      '.agents/config',
    ];

    if (selectedProvider === 'claude') {
      dirs.push('.claude', '.claude/skills', '.claude/skills/squads-workflow', '.claude/skills/squads-learn');
    } else if (selectedProvider === 'gemini') {
      dirs.push('.gemini');
    }

    for (const dir of dirs) {
      await fs.mkdir(path.join(cwd, dir), { recursive: true });
    }

    // Create provider config
    const providerYaml = loadTemplate('core/provider.yaml.template', variables);
    await fs.writeFile(path.join(cwd, '.agents/config/provider.yaml'), providerYaml);

    // Create demo squad (inline for now since templates are for first-squad)
    const demoSquadMd = `# Demo Squad

Research squad that creates a competitive analysis of enterprise AI agent frameworks.

## Goals

- [ ] Generate a report comparing enterprise agent frameworks

## Agents

| Agent | Purpose |
|-------|---------|
| researcher | Researches enterprise AI agent frameworks |
| reporter | Creates a markdown report from research |

## Pipeline

\`researcher\` → \`reporter\`

## Usage

\`\`\`bash
squads run demo --execute
\`\`\`

Output: \`.agents/outputs/demo/agent-frameworks-report.md\`
`;

    await fs.writeFile(path.join(cwd, '.agents/squads/demo/SQUAD.md'), demoSquadMd);

    // Create researcher agent
    const researcherAgent = `# Researcher Agent

## Purpose
Research enterprise AI agent frameworks and gather competitive intelligence.

## Model
worker

## Tools
- WebSearch
- WebFetch
- Write

## Instructions

Research the following enterprise AI agent frameworks:

1. **LangGraph** (LangChain) - Multi-agent orchestration
2. **CrewAI** - Role-based agent teams
3. **AutoGen** (Microsoft) - Conversational agents
4. **Semantic Kernel** (Microsoft) - Enterprise AI orchestration
5. **Amazon Bedrock Agents** - AWS managed agents
6. **Vertex AI Agents** (Google) - GCP agent builder
7. **Agents Squads** - Transparent AI systems for teams

For each framework, find:
- **Approach**: How it structures agent work
- **Strengths**: What it does well
- **Limitations**: Known challenges
- **Best for**: Ideal use cases
- **Pricing**: Cost model (if available)

Save raw research notes to: \`.agents/outputs/demo/research-notes.md\`

## Output
Research notes saved to .agents/outputs/demo/research-notes.md

## Labels
- demo
- research
`;

    await fs.writeFile(path.join(cwd, '.agents/squads/demo/researcher.md'), researcherAgent);

    // Create reporter agent
    const reporterAgent = `# Reporter Agent

## Purpose
Create a presentation-ready report from research on enterprise agent frameworks.

## Model
worker

## Tools
- Read
- Write

## Instructions

1. Read the research notes from \`.agents/outputs/demo/research-notes.md\`

2. Create a structured report with:

   ### Executive Summary
   - 2-3 sentence overview of the enterprise agent landscape
   - Key trend: where the market is heading

   ### Framework Comparison Table
   | Framework | Approach | Best For | Pricing |
   |-----------|----------|----------|---------|
   | ... | ... | ... | ... |

   ### Detailed Analysis
   For each framework, one paragraph covering strengths and limitations.

   ### Recommendation Matrix
   - **For rapid prototyping**: [recommendation]
   - **For enterprise scale**: [recommendation]
   - **For team transparency**: Agents Squads
   - **For AWS shops**: Bedrock Agents
   - **For GCP shops**: Vertex AI Agents

   ### Sources
   List URLs from research.

3. Save to: \`.agents/outputs/demo/agent-frameworks-report.md\`

## Output
Report saved to .agents/outputs/demo/agent-frameworks-report.md

## Labels
- demo
- report
`;

    await fs.writeFile(path.join(cwd, '.agents/squads/demo/reporter.md'), reporterAgent);

    // Create core files from templates
    const agentsMd = loadTemplate('core/AGENTS.md.template', variables);
    const businessBrief = loadTemplate('core/BUSINESS_BRIEF.md.template', variables);
    const memoryState = loadTemplate('memory/getting-started/state.md.template', variables);

    // Write AGENTS.md only if it doesn't exist
    if (!(await fileExists(path.join(cwd, 'AGENTS.md')))) {
      await fs.writeFile(path.join(cwd, 'AGENTS.md'), agentsMd);
    }

    await fs.writeFile(path.join(cwd, '.agents/BUSINESS_BRIEF.md'), businessBrief);
    await fs.writeFile(path.join(cwd, '.agents/memory/getting-started/state.md'), memoryState);

    // Provider-specific files
    if (selectedProvider === 'claude') {
      const claudeMd = loadTemplate('core/CLAUDE.md.template', variables);

      if (!(await fileExists(path.join(cwd, 'CLAUDE.md')))) {
        await fs.writeFile(path.join(cwd, 'CLAUDE.md'), claudeMd);
      }

      const claudeSettings = {
        hooks: {
          SessionStart: [{
            hooks: [{
              type: 'command',
              command: 'squads status',
              timeout: 10,
            }],
          }],
          Stop: [{
            hooks: [{
              type: 'command',
              command: 'squads memory sync && echo "\\n💡 Capture learnings: squads learn \\"<what you learned>\\"\\n"',
              timeout: 15,
            }],
          }],
        },
      };

      await fs.writeFile(
        path.join(cwd, '.claude/settings.json'),
        JSON.stringify(claudeSettings, null, 2)
      );

      const workflowSkill = loadTemplate('skills/squads-workflow/instruction.md', variables);
      await fs.writeFile(
        path.join(cwd, '.claude/skills/squads-workflow/instruction.md'),
        workflowSkill
      );
    }

    // Install git hooks
    await installGitHooks(cwd);

    spinner.succeed('Squad structure created');

    // Track initialization
    await track(Events.CLI_INIT, {
      success: true,
      hasGit: gitStatus.isGitRepo,
      hasRemote: gitStatus.hasRemote,
      template: options.template,
      hasDocker: commandExists('docker'),
      provider: selectedProvider,
      quick: true,
    });

  } catch (error) {
    spinner.fail('Failed to create structure');
    console.error(chalk.red(`  ${error}`));
    process.exit(1);
  }

  // Offer infrastructure setup
  const hasDocker = commandExists('docker');

  if (!options.skipInfra && hasDocker && dockerRunning()) {
    console.log();
    const setupInfra = await confirm('Set up local infrastructure (postgres, redis)?', true, options.yes);

    if (setupInfra) {
      console.log();
      await setupInfrastructure(cwd);
    }
  }

  // Success message
  console.log();
  console.log(chalk.green.bold('  ✓ Squads initialized!'));
  console.log();
  console.log(chalk.dim('  Created:'));
  console.log(chalk.dim('  • .agents/squads/demo/     - Demo squad (research report)'));
  console.log(chalk.dim('  • .agents/config/          - Provider configuration'));
  console.log(chalk.dim('  • .agents/memory/          - Persistent memory'));
  console.log(chalk.dim('  • AGENTS.md                - Agent instructions'));
  if (selectedProvider === 'claude') {
    console.log(chalk.dim('  • .claude/settings.json    - Claude Code hooks'));
    console.log(chalk.dim('  • CLAUDE.md                - Claude-specific instructions'));
  }
  console.log();
  console.log(chalk.bold('  👉 Try it now:'));
  console.log();
  console.log(`     ${chalk.yellow.bold('squads status')}`);
  console.log();
  console.log(chalk.dim('  Then explore:'));
  console.log(chalk.dim(`  • ${chalk.cyan('squads dash')}      Full dashboard`));
  console.log(chalk.dim(`  • ${chalk.cyan('squads run demo')}  Try demo agents`));
  console.log(chalk.dim(`  • ${chalk.cyan('squads --help')}    All commands`));
  console.log();
}

/**
 * Main init command entry point
 */
export async function initCommand(options: InitOptions): Promise<void> {
  // If --quick flag or non-interactive (CI), do fast init
  if (options.quick || options.yes || !isInteractive()) {
    return quickInit(options);
  }

  // Default: run full guided setup
  return setupCommand({
    provider: options.provider,
    skipInfra: options.skipInfra,
    yes: options.yes,
  });
}
