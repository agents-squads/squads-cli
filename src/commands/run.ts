import chalk from 'chalk';
import ora from 'ora';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  loadAgentDefinition
} from '../lib/squad-parser.js';

interface RunOptions {
  verbose?: boolean;
  dryRun?: boolean;
  agent?: string;
}

export async function runCommand(
  target: string,
  options: RunOptions
): Promise<void> {
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    console.error(chalk.red('No .agents/squads directory found.'));
    console.log(chalk.dim('Run `squads init` to create one.'));
    process.exit(1);
  }

  // Check if target is a squad or an agent
  const squad = loadSquad(target);

  if (squad) {
    await runSquad(squad, squadsDir, options);
  } else {
    // Try to find as an agent
    const agents = listAgents(squadsDir);
    const agent = agents.find(a => a.name === target);

    if (agent && agent.filePath) {
      await runAgent(agent.name, agent.filePath, options);
    } else {
      console.error(chalk.red(`Squad or agent "${target}" not found.`));
      console.log(chalk.dim('Run `squads list` to see available squads and agents.'));
      process.exit(1);
    }
  }
}

async function runSquad(
  squad: ReturnType<typeof loadSquad>,
  squadsDir: string,
  options: RunOptions
): Promise<void> {
  if (!squad) return;

  console.log(`
${chalk.bold.magenta('Running Squad:')} ${chalk.cyan(squad.name)}
${chalk.dim('Mission:')} ${squad.mission || 'Not defined'}
`);

  // If there's a pipeline, run agents in order
  if (squad.pipelines.length > 0) {
    const pipeline = squad.pipelines[0];
    console.log(chalk.dim('Pipeline:'), pipeline.agents.join(' → '));
    console.log();

    for (let i = 0; i < pipeline.agents.length; i++) {
      const agentName = pipeline.agents[i];
      const agentPath = join(squadsDir, squad.name, `${agentName}.md`);

      if (existsSync(agentPath)) {
        console.log(chalk.dim(`[${i + 1}/${pipeline.agents.length}]`));
        await runAgent(agentName, agentPath, options);
        console.log();
      } else {
        console.log(chalk.yellow(`  ⚠ Agent ${agentName} not found, skipping`));
      }
    }
  } else {
    // Run orchestrator if exists, otherwise list agents
    const orchestrator = squad.agents.find(a =>
      a.name.includes('lead') || a.trigger === 'Manual'
    );

    if (orchestrator) {
      const agentPath = join(squadsDir, squad.name, `${orchestrator.name}.md`);
      if (existsSync(agentPath)) {
        await runAgent(orchestrator.name, agentPath, options);
      }
    } else {
      console.log(chalk.dim('No pipeline defined. Available agents:'));
      for (const agent of squad.agents) {
        console.log(`  ${chalk.cyan(agent.name)} - ${agent.role}`);
      }
      console.log();
      console.log(chalk.dim('Run a specific agent with:'));
      console.log(`  ${chalk.cyan(`squads run ${squad.name} --agent <name>`)}`);
    }
  }
}

async function runAgent(
  agentName: string,
  agentPath: string,
  options: RunOptions
): Promise<void> {
  const spinner = ora(`Running agent: ${agentName}`).start();

  const definition = loadAgentDefinition(agentPath);

  if (options.dryRun) {
    spinner.info(`[DRY RUN] Would run ${agentName}`);
    if (options.verbose) {
      console.log(chalk.dim('\nAgent definition:'));
      console.log(chalk.dim(definition.slice(0, 500) + '...'));
    }
    return;
  }

  // Generate the Claude Code command
  const prompt = `Execute the agent defined in ${agentPath}

Read the agent definition and follow its instructions exactly. The agent definition contains:
- Purpose/role
- Tools it can use
- Step-by-step instructions
- Expected output format

After completion, update the agent's memory in .agents/memory/ if it exists.`;

  if (options.verbose) {
    spinner.info(`Agent path: ${agentPath}`);
    console.log(chalk.dim('Prompt:'), prompt.slice(0, 200) + '...');
  }

  // For now, show the command to run with Claude Code
  spinner.succeed(`Agent ${chalk.cyan(agentName)} ready`);

  console.log(`
${chalk.dim('To execute with Claude Code:')}
  ${chalk.cyan(`claude "${prompt.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)}

${chalk.dim('Or in Claude Code session:')}
  ${chalk.cyan(`Run the ${agentName} agent from ${agentPath}`)}
`);

  // In the future, we could auto-execute via Claude Code CLI
  // const claude = spawn('claude', ['--prompt', prompt], { stdio: 'inherit' });
}

export async function runSquadCommand(
  squadName: string,
  options: RunOptions
): Promise<void> {
  return runCommand(squadName, options);
}
