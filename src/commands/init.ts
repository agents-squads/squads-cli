import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';
import { checkGitStatus, initGitRepo, getRepoName } from '../lib/git.js';
import { track, Events } from '../lib/telemetry.js';

interface InitOptions {
  template: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();

  // Check Git status first
  console.log(chalk.dim('Checking project setup...\n'));

  const gitStatus = checkGitStatus(cwd);

  if (!gitStatus.isGitRepo) {
    console.log(chalk.yellow('⚠ No git repository found.'));
    console.log(chalk.dim('  Squads work best with git for version control and GitHub integration.'));
    console.log(chalk.dim('  Run: git init && git remote add origin <your-repo-url>\n'));
  } else {
    console.log(chalk.green('✓ Git repository detected'));

    if (gitStatus.hasRemote) {
      const repoName = getRepoName(gitStatus.remoteUrl);
      console.log(chalk.green(`✓ Remote: ${chalk.cyan(repoName || gitStatus.remoteUrl)}`));
    } else {
      console.log(chalk.yellow('⚠ No remote configured.'));
      console.log(chalk.dim('  Add a remote: git remote add origin <your-repo-url>\n'));
    }

    if (gitStatus.isDirty) {
      console.log(chalk.yellow(`⚠ ${gitStatus.uncommittedCount} uncommitted changes`));
    }
  }

  console.log();

  const spinner = ora('Initializing squad project...').start();

  try {
    // Create directory structure
    const dirs = [
      '.agents/squads',
      '.agents/memory',
      '.agents/outputs',
      '.claude',
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(cwd, dir), { recursive: true });
    }

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
                command: 'squads memory sync',
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

    // Create example agent
    const exampleAgent = `# Example Agent

## Purpose
Demonstrate basic agent structure.

## Model
claude-sonnet-4

## Tools
- Read
- Write
- WebSearch

## Instructions
1. Greet the user
2. Ask how you can help
3. Execute the task

## Output
Markdown summary of actions taken.
`;

    await fs.writeFile(
      path.join(cwd, '.agents/squads/example-agent.md'),
      exampleAgent
    );

    // Create CLAUDE.md if it doesn't exist
    const claudeMdPath = path.join(cwd, 'CLAUDE.md');
    try {
      await fs.access(claudeMdPath);
    } catch {
      await fs.writeFile(
        claudeMdPath,
        `# Project Instructions

## Squads CLI

This project uses AI agent squads. The \`squads\` CLI provides persistent memory across sessions.

### Key Commands

| Command | Purpose |
|---------|---------|
| \`squads status\` | Overview of all squads (runs on session start) |
| \`squads dash\` | Full operational dashboard |
| \`squads dash --ceo\` | Executive summary with P0/P1 priorities |
| \`squads goal list\` | View all active goals |
| \`squads memory query "<topic>"\` | Search squad memory before researching |
| \`squads run <squad>\` | Execute a squad |

### Workflow

1. **Session Start**: \`squads status\` runs automatically via hook
2. **Before Research**: Query memory to avoid re-doing work
3. **Session End**: Memory syncs automatically from git commits

### For Reports

Always use CLI commands for status reports:
- Executive summary: \`squads dash --ceo\`
- Operational view: \`squads dash\`
- Goals: \`squads goal list\`
`
      );
    }

    spinner.succeed('Squad project initialized!');

    // Track initialization
    await track(Events.CLI_INIT, {
      hasGit: gitStatus.isGitRepo,
      hasRemote: gitStatus.hasRemote,
      template: options.template,
    });

    console.log(`
${chalk.green('Success!')} Created squad project structure:

  ${chalk.cyan('.agents/')}
  ${chalk.dim('├──')} ${chalk.cyan('squads/')}      Squad & agent definitions
  ${chalk.dim('├──')} ${chalk.cyan('memory/')}      Persistent squad memory
  ${chalk.dim('└──')} ${chalk.cyan('outputs/')}     Squad outputs

${chalk.dim('Next steps:')}
  ${chalk.cyan('1.')} Create a squad: ${chalk.yellow('mkdir .agents/squads/my-squad && touch .agents/squads/my-squad/SQUAD.md')}
  ${chalk.cyan('2.')} Set a goal: ${chalk.yellow('squads goal set my-squad "Solve a problem"')}
  ${chalk.cyan('3.')} Run it: ${chalk.yellow('squads run my-squad')}

${chalk.dim('Put your first squad to work solving a problem in minutes.')}
`);

  } catch (error) {
    spinner.fail('Failed to initialize project');
    console.error(chalk.red(error));
    process.exit(1);
  }
}
