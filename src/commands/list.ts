import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';

interface ListOptions {
  squads?: boolean;
  agents?: boolean;
}

export async function listCommand(options: ListOptions): Promise<void> {
  const cwd = process.cwd();
  const squadsDir = path.join(cwd, '.agents/squads');

  try {
    // Check if squads directory exists
    await fs.access(squadsDir);

    // Read all .md files in squads directory
    const files = await fs.readdir(squadsDir);
    const agentFiles = files.filter((f) => f.endsWith('.md'));

    if (agentFiles.length === 0) {
      console.log(chalk.yellow('No agents found.'));
      console.log(`Run ${chalk.cyan('squads init')} to create example agents.`);
      return;
    }

    console.log(`
${chalk.bold('Agents')} ${chalk.dim(`(${agentFiles.length})`)}
`);

    for (const file of agentFiles) {
      const name = file.replace('.md', '');
      const content = await fs.readFile(path.join(squadsDir, file), 'utf-8');

      // Extract model from content
      const modelMatch = content.match(/##\s*Model\s*\n([^\n#]+)/i);
      const model = modelMatch ? modelMatch[1].trim() : 'unknown';

      console.log(`  ${chalk.cyan(name)} ${chalk.dim(`(${model})`)}`);
    }

    console.log('');

  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(chalk.yellow('No squad project found in current directory.'));
      console.log(`Run ${chalk.cyan('squads init')} to initialize a project.`);
    } else {
      console.error(chalk.red(error));
      process.exit(1);
    }
  }
}
