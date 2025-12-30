import { Command } from 'commander';
import chalk from 'chalk';
import { version } from './version.js';
import { initCommand } from './commands/init.js';
import { runCommand } from './commands/run.js';
import { listCommand } from './commands/list.js';

const program = new Command();

program
  .name('squads')
  .description('CLI for managing AI agent squads')
  .version(version);

program
  .command('init')
  .description('Initialize a new squad project')
  .option('-t, --template <template>', 'Project template', 'default')
  .action(initCommand);

program
  .command('run <agent>')
  .description('Run an agent')
  .option('-s, --squad <squad>', 'Squad name')
  .option('-v, --verbose', 'Verbose output')
  .action(runCommand);

program
  .command('list')
  .description('List agents and squads')
  .option('-s, --squads', 'List squads only')
  .option('-a, --agents', 'List agents only')
  .action(listCommand);

program
  .command('status')
  .description('Show squad status')
  .action(() => {
    console.log(chalk.cyan('Squad status coming soon...'));
  });

// Parse arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  console.log(`
${chalk.bold.magenta('squads')} - AI agent squad management

${chalk.dim('Quick start:')}
  ${chalk.cyan('squads init')}          Initialize a new project
  ${chalk.cyan('squads run <agent>')}   Run an agent
  ${chalk.cyan('squads list')}          List agents and squads

${chalk.dim('Run')} ${chalk.cyan('squads --help')} ${chalk.dim('for all commands.')}
`);
}
