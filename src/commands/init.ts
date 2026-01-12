import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { createInterface } from 'readline';
import { checkGitStatus, getRepoName } from '../lib/git.js';
import { track, Events } from '../lib/telemetry.js';

interface InitOptions {
  template: string;
  skipInfra?: boolean;
  force?: boolean;
  yes?: boolean;
}

// Check if running in interactive mode (has TTY)
function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

// Simple yes/no prompt - returns default if non-interactive
async function confirm(question: string, defaultYes = true, forceYes = false): Promise<boolean> {
  // In non-interactive mode or with --yes, use defaults
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

// Optional email prompt for updates - skips in non-interactive mode
async function promptEmail(forceSkip = false): Promise<string | null> {
  // Skip in non-interactive mode or with --yes
  if (forceSkip || !isInteractive()) {
    return null;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`  ${chalk.dim('📬 Get product updates? (optional, Enter to skip):')} `, (answer) => {
      rl.close();
      const email = answer.trim();

      // Skip if empty
      if (!email) {
        resolve(null);
        return;
      }

      // Basic email validation
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (emailRegex.test(email)) {
        resolve(email);
      } else {
        console.log(chalk.dim('  Invalid email, skipping...'));
        resolve(null);
      }
    });
  });
}

// Check if a command exists
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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

interface RequirementCheck {
  name: string;
  status: 'ok' | 'missing' | 'warning';
  message?: string;
  hint?: string;
}

// Check if Claude CLI is installed and logged in
function checkClaudeAuth(): { installed: boolean; loggedIn: boolean } {
  try {
    execSync('which claude', { stdio: 'ignore' });
  } catch {
    return { installed: false, loggedIn: false };
  }

  try {
    // Check if claude is authenticated
    const result = execSync('claude --version', { stdio: 'pipe' }).toString();
    // If we get here, claude is installed. Check auth status.
    // Claude CLI doesn't have a direct "am I logged in" check, but if it works, assume ok
    return { installed: true, loggedIn: result.includes('claude') };
  } catch {
    return { installed: true, loggedIn: false };
  }
}

// Check if gh CLI is authenticated
function checkGhAuth(): boolean {
  try {
    execSync('gh auth status', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function checkRequirements(): RequirementCheck[] {
  const checks: RequirementCheck[] = [];

  // Check Claude CLI (subscription-based auth)
  const claudeStatus = checkClaudeAuth();
  if (claudeStatus.installed && claudeStatus.loggedIn) {
    checks.push({ name: 'Claude CLI', status: 'ok' });
  } else if (claudeStatus.installed) {
    checks.push({
      name: 'Claude CLI',
      status: 'warning',
      message: 'Installed but may need login',
      hint: 'Run: claude login',
    });
  } else {
    checks.push({
      name: 'Claude CLI',
      status: 'missing',
      message: 'Required to run agents',
      hint: 'Install: npm install -g @anthropic-ai/claude-code',
    });
  }

  // Check GitHub CLI auth (not raw token) - optional but recommended
  if (checkGhAuth()) {
    checks.push({ name: 'GitHub CLI', status: 'ok' });
  } else if (commandExists('gh')) {
    checks.push({
      name: 'GitHub CLI',
      status: 'warning',
      message: 'Installed but not logged in',
      hint: 'Run: gh auth login',
    });
  } else {
    checks.push({
      name: 'GitHub CLI',
      status: 'warning',
      message: 'Optional - enables GitHub integration',
      hint: 'Install: https://cli.github.com',
    });
  }

  // Check Docker
  if (commandExists('docker')) {
    if (dockerRunning()) {
      checks.push({ name: 'Docker', status: 'ok' });
    } else {
      checks.push({
        name: 'Docker',
        status: 'warning',
        message: 'Installed but not running',
        hint: 'Start Docker Desktop or run: sudo systemctl start docker',
      });
    }
  } else {
    checks.push({
      name: 'Docker',
      status: 'warning',
      message: 'Optional - enables dashboard metrics',
      hint: 'Install: https://docker.com',
    });
  }

  return checks;
}

async function installGitHooks(cwd: string): Promise<boolean> {
  const hooksDir = path.join(cwd, '.git', 'hooks');

  // Check if this is a git repo
  if (!(await fileExists(path.join(cwd, '.git')))) {
    return false;
  }

  try {
    // Ensure hooks directory exists
    await fs.mkdir(hooksDir, { recursive: true });

    // Post-commit hook: sync Slack channels when SQUAD.md changes
    const postCommitHook = `#!/bin/bash
# Auto-sync Slack channels when SQUAD.md files change
# Installed by: squads init

# Check if any SQUAD.md files were changed in the last commit
CHANGED_SQUADS=$(git diff-tree --no-commit-id --name-only -r HEAD | grep "SQUAD.md" || true)

if [ -n "$CHANGED_SQUADS" ]; then
  echo "SQUAD.md changed - syncing Slack channels..."

  # Run sync in background (don't block commit)
  (
    # Small delay to let commit finish cleanly
    sleep 1

    # Load env if available
    if [ -f ".env" ]; then
      export $(grep -E "^SLACK_BOT_TOKEN=" .env | xargs 2>/dev/null)
    fi

    # Run sync if token available
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
    // Find docker-compose.yml - check if it's bundled with CLI or in current dir
    let dockerDir: string | null = null;

    // Check current directory
    const localDockerCompose = path.join(cwd, 'docker', 'docker-compose.yml');
    const localDockerComposeRoot = path.join(cwd, 'docker-compose.yml');

    if (await fileExists(localDockerCompose)) {
      dockerDir = path.join(cwd, 'docker');
    } else if (await fileExists(localDockerComposeRoot)) {
      dockerDir = cwd;
    } else {
      // Try to find bundled docker files from CLI package
      const cliPath = new URL('../..', import.meta.url).pathname;
      const bundledDockerCompose = path.join(cliPath, 'docker', 'docker-compose.yml');

      if (await fileExists(bundledDockerCompose)) {
        // Copy docker files to project
        spinner.text = 'Copying infrastructure files...';
        const targetDockerDir = path.join(cwd, 'docker');
        await fs.mkdir(targetDockerDir, { recursive: true });

        // Copy essential files
        const filesToCopy = [
          'docker-compose.yml',
          '.env.example',
          'init-db.sql',
          'README.md',
        ];

        for (const file of filesToCopy) {
          const src = path.join(cliPath, 'docker', file);
          const dest = path.join(targetDockerDir, file);
          if (await fileExists(src)) {
            await fs.copyFile(src, dest);
          }
        }

        // Copy squads-bridge directory
        const bridgeSrc = path.join(cliPath, 'docker', 'squads-bridge');
        const bridgeDest = path.join(targetDockerDir, 'squads-bridge');
        if (await fileExists(bridgeSrc)) {
          await copyDir(bridgeSrc, bridgeDest);
        }

        // Create .env from example if not exists
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

    // Run docker compose
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

    // Wait a bit for services to start
    await sleep(3000);

    // Verify services
    const services = ['squads-postgres', 'squads-redis', 'squads-bridge'];
    let allRunning = true;

    for (const service of services) {
      try {
        execSync(`docker ps --filter "name=${service}" --filter "status=running" -q`, { stdio: 'pipe' });
      } catch {
        allRunning = false;
      }
    }

    if (allRunning) {
      spinner.succeed('Infrastructure ready');
      console.log();
      console.log(chalk.dim('  Services running:'));
      console.log(chalk.dim('  • postgres:5432  • redis:6379  • bridge:8088'));
      return true;
    } else {
      spinner.warn('Some services may not be running');
      console.log(chalk.dim('  Check with: docker ps'));
      return true; // Still consider it a success, user can debug
    }

  } catch (error) {
    spinner.fail('Failed to start infrastructure');
    console.log(chalk.dim(`  ${error}`));
    console.log(chalk.dim('  Try manually: cd docker && docker compose up -d'));
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

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();

  console.log();
  console.log(chalk.bold('  Checking requirements...'));
  console.log();

  // Check requirements
  const checks = checkRequirements();
  let hasMissingRequired = false;
  let hasDocker = false;
  let dockerReady = false;

  const missingTools: string[] = [];

  for (const check of checks) {
    if (check.status === 'ok') {
      console.log(`  ${chalk.green('✓')} ${check.name}`);
      if (check.name === 'Docker') {
        hasDocker = true;
        dockerReady = true;
      }
    } else if (check.status === 'missing') {
      console.log(`  ${chalk.red('✗')} ${chalk.red(check.name)} ${chalk.dim('(required)')}`);
      if (check.message) {
        console.log(chalk.dim(`    ${check.message}`));
      }
      if (check.hint) {
        console.log(chalk.cyan(`    → ${check.hint}`));
      }
      missingTools.push(check.name);
      hasMissingRequired = true;
    } else if (check.status === 'warning') {
      console.log(`  ${chalk.yellow('○')} ${check.name} ${chalk.dim(`(${check.message})`)}`);
      if (check.hint) {
        console.log(chalk.dim(`    → ${check.hint}`));
      }
      if (check.name === 'Docker') {
        hasDocker = commandExists('docker');
      }
    }
  }

  console.log();

  if (hasMissingRequired && !options.force) {
    console.log(chalk.red(`  Missing required: ${missingTools.join(', ')}`));
    console.log();

    // Offer to install Claude CLI automatically
    if (missingTools.includes('Claude CLI')) {
      const shouldInstall = await confirm('Install Claude CLI now?', true, options.yes);

      if (shouldInstall) {
        console.log();
        console.log(chalk.dim('  Installing Claude CLI...'));

        try {
          execSync('npm install -g @anthropic-ai/claude-code', {
            stdio: 'inherit',
            timeout: 120000
          });
          console.log();
          console.log(chalk.green('  ✓ Claude CLI installed'));
          console.log();

          // Now prompt for login
          console.log(chalk.dim('  Opening browser for Claude login...'));
          console.log();

          const loginProc = spawn('claude', ['login'], {
            stdio: 'inherit',
            shell: true
          });

          await new Promise<void>((resolve) => {
            loginProc.on('close', () => resolve());
          });

          console.log();
          console.log(chalk.green('  ✓ Claude CLI ready'));
          console.log();

          // Remove from missing and continue
          const idx = missingTools.indexOf('Claude CLI');
          if (idx > -1) missingTools.splice(idx, 1);
          hasMissingRequired = missingTools.length > 0;

        } catch (err) {
          console.log();
          console.log(chalk.red('  Failed to install. Try manually:'));
          console.log(chalk.cyan('    npm install -g @anthropic-ai/claude-code'));
          console.log();

          track(Events.CLI_INIT, {
            success: false,
            reason: 'install_failed',
            missingTools: missingTools.join(','),
          });
          return;
        }
      } else {
        console.log();
        console.log(chalk.dim('  To install manually:'));
        console.log(chalk.cyan('    npm install -g @anthropic-ai/claude-code'));
        console.log(chalk.cyan('    claude login'));
        console.log();

        track(Events.CLI_INIT, {
          success: false,
          reason: 'user_declined_install',
          missingTools: missingTools.join(','),
        });
        return;
      }
    }

    // If still missing requirements after install attempt
    if (hasMissingRequired) {
      console.log(chalk.dim('  Install missing tools, then run: squads init'));
      console.log();

      track(Events.CLI_INIT, {
        success: false,
        reason: 'missing_requirements',
        missingTools: missingTools.join(','),
      });
      return;
    }
  }

  // Check Git status
  console.log(chalk.dim('  Checking project setup...'));
  console.log();

  const gitStatus = checkGitStatus(cwd);

  if (!gitStatus.isGitRepo) {
    console.log(`  ${chalk.yellow('⚠')} No git repository found`);
    console.log(chalk.dim('    Run: git init && git remote add origin <repo-url>'));
    console.log();
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
    // Create directory structure
    const dirs = [
      '.agents/squads',
      '.agents/squads/demo',
      '.agents/memory',
      '.agents/memory/getting-started',
      '.agents/memory/general/shared', // For cross-squad learnings
      '.agents/outputs',
      '.claude',
      '.claude/skills',
      '.claude/skills/squads-workflow',
      '.claude/skills/squads-learn',
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(cwd, dir), { recursive: true });
    }

    // Create demo squad
    const demoSquadMd = `# Demo Squad

Demonstrates squads functionality with safe, educational examples.

## Goals

- [ ] Run the demo agents and explore the dashboard

## Agents

| Agent | Purpose |
|-------|---------|
| welcome | Creates a welcome GitHub issue |
| analyzer | Analyzes project structure |

## Triggers

None (manual execution only)

## Usage

\`\`\`bash
squads run demo
\`\`\`

This will:
1. Create a GitHub issue explaining what happened
2. Analyze your project structure
3. Show results in the dashboard

All demo data is clearly labeled [demo] so you can distinguish it from real data.
`;

    await fs.writeFile(
      path.join(cwd, '.agents/squads/demo/SQUAD.md'),
      demoSquadMd
    );

    // Create demo welcome agent
    const welcomeAgent = `# Welcome Agent

## Purpose
Create a welcome GitHub issue to demonstrate squads functionality.

## Model
claude-haiku-3-5

## Tools
- Bash (gh cli)

## Instructions
1. Check if a welcome issue already exists
2. If not, create a new issue titled "[Demo] Welcome to Squads!"
3. The issue body should explain:
   - What just happened (squads run demo executed this agent)
   - What squads are and how they work
   - Next steps to create their own agents

## Output
Confirmation message with issue URL.

## Labels
- demo
- automated
`;

    await fs.writeFile(
      path.join(cwd, '.agents/squads/demo/welcome.md'),
      welcomeAgent
    );

    // Create demo analyzer agent
    const analyzerAgent = `# Project Analyzer Agent

## Purpose
Analyze project structure and provide insights.

## Model
claude-haiku-3-5

## Tools
- Read
- Glob
- Bash (ls, find)

## Instructions
1. Scan the project directory structure
2. Identify key files (package.json, Cargo.toml, pyproject.toml, etc.)
3. Summarize the tech stack
4. Create a brief report

## Output
Markdown report saved to .agents/outputs/demo/project-analysis.md

## Labels
- demo
- analysis
`;

    await fs.writeFile(
      path.join(cwd, '.agents/squads/demo/analyzer.md'),
      analyzerAgent
    );

    // Create squads-workflow skill
    const squadsWorkflowSkill = `# Squads Workflow

Use this skill when working with squads-cli to maintain persistent memory, track goals, and coordinate work.

## Session Start

At session start, you'll see \`squads status\` output automatically. For complex tasks, run:

\`\`\`bash
squads context                # Get business context, goals, decisions
squads memory query "<topic>" # Check what we already know
\`\`\`

**Skip context loading for simple tasks** (typo fixes, quick questions).

## Core Commands

\`\`\`bash
# Context & Status
squads context                # Business context for alignment
squads status                 # Squad overview
squads dash                   # Full dashboard

# Memory
squads memory query "<topic>" # Search memory
squads memory show <squad>    # Squad's full memory

# Goals
squads goal list              # All active goals
squads goal set <squad> "X"   # Add a goal

# Running Agents
squads run <squad>            # Run all agents in squad
squads run <squad>/<agent>    # Run specific agent
squads list                   # List all agents
\`\`\`

## Workflow

### Before Research
Always check memory first to avoid re-researching:
\`\`\`bash
squads memory query "topic"
\`\`\`

### After Work
Update memory with what you learned by editing:
\`.agents/memory/<squad>/<agent>/state.md\`

### Commits
Include goal attribution when relevant:
\`\`\`
feat: add user auth [goal:engineering/1]
\`\`\`

## Agent Execution

When a task could be automated:
1. Check if agent exists: \`squads list | grep <keyword>\`
2. If yes: \`squads run <squad>/<agent>\`
3. If no: Create agent in \`.agents/squads/<squad>/<name>.md\`

## Memory Locations

- \`.agents/memory/<squad>/<agent>/state.md\` - Current knowledge
- \`.agents/memory/<squad>/<agent>/learnings.md\` - Insights over time

## Key Principle

**Memory is your cross-session brain.** Without it, every session starts fresh. With it, you build on previous work.
`;

    await fs.writeFile(
      path.join(cwd, '.claude/skills/squads-workflow/instruction.md'),
      squadsWorkflowSkill
    );

    // Create squads-learn skill
    const squadsLearnSkill = `---
name: squads-learn
description: Capture learnings after completing work. Use when finishing a task, fixing a bug, discovering a pattern, or learning something worth remembering for future sessions.
---

# Capture Learnings

After completing work, capture what you learned so future sessions can benefit.

## When to Use

- After fixing a bug - What was the root cause?
- After completing a feature - What approach worked?
- After research - What's the key insight?
- When you notice a pattern - Something that works consistently

## Quick Commands

\`\`\`bash
# Capture a learning
squads learn "The auth token needs refresh after 1 hour, not on 401"

# With squad and category
squads learn "Always check memory first" --squad engineering --category pattern

# View learnings
squads learnings show engineering
squads learnings search "auth"
\`\`\`

## Categories

- \`success\` - Something that worked well
- \`failure\` - Something that didn't work (learn from mistakes)
- \`pattern\` - A reusable approach
- \`tip\` - General advice

## End of Task Checklist

Before marking done, ask:
1. What worked that I should remember?
2. What didn't work that I should avoid?
3. Is there a pattern worth capturing?

If yes → \`squads learn "<insight>"\`
`;

    await fs.writeFile(
      path.join(cwd, '.claude/skills/squads-learn/SKILL.md'),
      squadsLearnSkill
    );

    // Create seed memory
    const seedMemory = `# Getting Started with Squads

## What You've Set Up

- **Demo squad** ready to run (\`squads run demo\`)
- **Memory system** for persistent context
- **Hooks** that sync status and memory automatically

## Next Steps

1. Run the demo: \`squads run demo\`
2. Check the dashboard: \`squads dash\`
3. Create your first real squad in \`.agents/squads/\`

## Tips

- Check memory before researching: \`squads memory query "<topic>"\`
- Use \`squads context\` for business alignment on complex tasks
- Agents are reusable - if you do something twice, make it an agent
`;

    await fs.writeFile(
      path.join(cwd, '.agents/memory/getting-started/state.md'),
      seedMemory
    );

    // Create business brief template
    const businessBrief = `# Business Brief

## #1 Priority

**[Define your top priority here]**

## Runway

**Pressure**: LOW | MEDIUM | HIGH

## Current Focus

1. **[Focus area 1]** - Description
2. **[Focus area 2]** - Description
3. **[Focus area 3]** - Description

## Blockers

- None currently (or list blockers)

## Decision Framework

1. Does this drive the #1 priority?
2. Is there a simpler approach?
3. What's the opportunity cost?

---

*This file is read by \`squads context\` to provide business alignment.*
`;

    await fs.writeFile(
      path.join(cwd, '.agents/BUSINESS_BRIEF.md'),
      businessBrief
    );

    // Create Claude Code settings with hooks
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

    // Install git hooks (Slack sync on SQUAD.md changes)
    const hooksInstalled = await installGitHooks(cwd);

    // Create git commit template
    const commitTemplate = `
# Commit message format:
# <type>(<scope>): <subject>
#
# 🤖 Generated with [Agents Squads](https://agents-squads.com)
# Co-Authored-By: Claude <model> <noreply@anthropic.com>
`;

    await fs.writeFile(
      path.join(cwd, '.agents/commit-template.txt'),
      commitTemplate
    );

    // Create CLAUDE.md if it doesn't exist
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    if (!(await fileExists(claudeMdPath))) {
      await fs.writeFile(
        claudeMdPath,
        `# Project Instructions

## What is Squads?

Squads is a framework for building AI agent teams that automate real work.
Each **squad** is a team of **agents** (markdown prompts) that execute via Claude.

## For Claude (READ THIS)

**Skill available**: Use \`/squads-workflow\` for detailed workflow guidance.

### Session Start

You'll see \`squads status\` automatically. For complex tasks, also run:
\`\`\`bash
squads context                # Business context, goals, decisions
squads memory query "<topic>" # What we already know
\`\`\`

**Skip for simple tasks** (typo fixes, quick questions).

### Before Research
Always check memory first:
\`\`\`bash
squads memory query "<topic>"
\`\`\`

### Creating Agents
Agents live in \`.agents/squads/<squad-name>/<agent-name>.md\`:

\`\`\`markdown
# Agent Name

## Purpose
One sentence: what this agent does.

## Instructions
1. Specific step
2. Another step
3. Output location

## Output
What it produces and where it goes.
\`\`\`

### Running Agents
\`\`\`bash
squads run <squad>           # Run all agents in squad
squads run <squad>/<agent>   # Run specific agent
\`\`\`

### Tracking Progress
\`\`\`bash
squads dash                  # Full dashboard with goals
squads goal list             # View all goals
squads goal set <squad> "X"  # Add a goal
\`\`\`

### Common User Requests

| User says | You should |
|-----------|------------|
| "Create an agent to..." | Create \`.agents/squads/<squad>/<name>.md\` |
| "Automate X" | Create agent, then \`squads run\` |
| "What's the status?" | Run \`squads dash\` or \`squads status\` |
| "Run the X agent" | \`squads run <squad>/x\` |
| "Check memory" | \`squads memory query "<topic>"\` |
| "Get context" | \`squads context\` |

## Quick Reference

\`\`\`bash
squads context         # Business context for alignment
squads status          # Overview
squads dash            # Full dashboard
squads run demo        # Try demo squad
squads list            # All agents
squads memory query X  # Search memory
squads goal list       # View goals
\`\`\`

## Project Structure

\`\`\`
.agents/
├── squads/           # Agent teams
│   └── <squad>/
│       ├── SQUAD.md  # Squad definition
│       └── *.md      # Agent files
├── memory/           # Persistent context
└── outputs/          # Agent outputs
\`\`\`
`
      );
    }

    spinner.succeed('Squad structure created');

    // Track successful initialization
    await track(Events.CLI_INIT, {
      success: true,
      hasGit: gitStatus.isGitRepo,
      hasRemote: gitStatus.hasRemote,
      template: options.template,
      hasDocker,
    });

  } catch (error) {
    spinner.fail('Failed to create structure');
    console.error(chalk.red(`  ${error}`));

    // Track init failure
    track(Events.CLI_INIT, {
      success: false,
      reason: 'structure_creation_failed',
      error: String(error),
    });
    process.exit(1);
  }

  // Offer infrastructure setup if Docker is available
  if (!options.skipInfra && hasDocker) {
    console.log();

    if (!dockerReady) {
      console.log(chalk.dim('  Docker is installed but not running.'));
      console.log(chalk.dim('  Start Docker to enable infrastructure setup.'));
    } else {
      const setupInfra = await confirm('Set up local infrastructure (postgres, redis)?', true, options.yes);

      if (setupInfra) {
        console.log();
        const success = await setupInfrastructure(cwd);
        if (!success) {
          console.log();
          console.log(chalk.dim('  You can set up infrastructure later with:'));
          console.log(chalk.dim('  cd docker && docker compose up -d'));
        }
      }
    }
  }

  // Success message - clear single next action
  console.log();
  console.log(chalk.green.bold('  ✓ Squads initialized!'));
  console.log();

  // Show what was created (compact)
  console.log(chalk.dim('  Created:'));
  console.log(chalk.dim('  • .agents/squads/demo/     - Demo squad with 2 agents'));
  console.log(chalk.dim('  • .agents/BUSINESS_BRIEF   - Business context template'));
  console.log(chalk.dim('  • .agents/memory/          - Seed memory + learnings'));
  console.log(chalk.dim('  • .claude/settings.json    - Claude Code hooks'));
  console.log(chalk.dim('  • .claude/skills/          - Workflow + learn skills'));
  console.log(chalk.dim('  • CLAUDE.md                - Agent instructions'));
  if (gitStatus.isGitRepo) {
    console.log(chalk.dim('  • .git/hooks/post-commit   - Slack channel sync'));
  }
  console.log();

  // Optional email capture for updates (skip with --yes or non-interactive)
  const email = await promptEmail(options.yes);
  if (email) {
    await track(Events.CLI_INIT, {
      event: 'email_capture',
      email,
    });
    console.log(chalk.dim(`  ✓ We'll send updates to ${email}`));
    console.log();
  }

  // Single clear next action - this is critical for activation
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
