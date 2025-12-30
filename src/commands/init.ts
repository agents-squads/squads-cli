import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import path from 'path';

interface InitOptions {
  template: string;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const spinner = ora('Initializing squad project...').start();

  try {
    const cwd = process.cwd();

    // Create directory structure
    const dirs = [
      '.agents/squads',
      '.agents/memory',
      '.agents/outputs',
    ];

    for (const dir of dirs) {
      await fs.mkdir(path.join(cwd, dir), { recursive: true });
    }

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

## Squads
This project uses AI agent squads for automation.

Run agents with: \`squads run <agent-name>\`
`
      );
    }

    spinner.succeed('Squad project initialized!');

    console.log(`
${chalk.green('Success!')} Created squad project structure:

  ${chalk.cyan('.agents/')}
  ${chalk.dim('├──')} ${chalk.cyan('squads/')}      Agent definitions
  ${chalk.dim('├──')} ${chalk.cyan('memory/')}      Agent memory/state
  ${chalk.dim('└──')} ${chalk.cyan('outputs/')}     Agent outputs

${chalk.dim('Next steps:')}
  ${chalk.cyan('1.')} Edit ${chalk.yellow('.agents/squads/example-agent.md')}
  ${chalk.cyan('2.')} Run ${chalk.yellow('squads run example-agent')}
`);

  } catch (error) {
    spinner.fail('Failed to initialize project');
    console.error(chalk.red(error));
    process.exit(1);
  }
}
