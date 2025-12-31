import ora from 'ora';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  loadAgentDefinition
} from '../lib/squad-parser.js';
import { findMemoryDir } from '../lib/memory.js';
import { track, Events } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface RunOptions {
  verbose?: boolean;
  dryRun?: boolean;
  agent?: string;
}

interface ExecutionRecord {
  squadName: string;
  agentName: string;
  startTime: string;
  endTime?: string;
  status: 'running' | 'completed' | 'failed';
  outcome?: string;
}

function getExecutionLogPath(squadName: string, agentName: string): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;
  return join(memoryDir, squadName, agentName, 'executions.md');
}

function logExecution(record: ExecutionRecord): void {
  const logPath = getExecutionLogPath(record.squadName, record.agentName);
  if (!logPath) return;

  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let content = '';
  if (existsSync(logPath)) {
    content = readFileSync(logPath, 'utf-8');
  } else {
    content = `# ${record.squadName}/${record.agentName} - Execution Log\n\n`;
  }

  const entry = `
---
**${record.startTime}** | Status: ${record.status}
${record.endTime ? `Completed: ${record.endTime}` : ''}
${record.outcome ? `Outcome: ${record.outcome}` : ''}
`;

  writeFileSync(logPath, content + entry);
}

function updateExecutionStatus(
  squadName: string,
  agentName: string,
  status: 'completed' | 'failed',
  outcome?: string
): void {
  const logPath = getExecutionLogPath(squadName, agentName);
  if (!logPath || !existsSync(logPath)) return;

  let content = readFileSync(logPath, 'utf-8');
  const endTime = new Date().toISOString();

  // Update the last "running" entry
  content = content.replace(
    /Status: running\n$/,
    `Status: ${status}\nCompleted: ${endTime}\n${outcome ? `Outcome: ${outcome}\n` : ''}`
  );

  writeFileSync(logPath, content);
}

export async function runCommand(
  target: string,
  options: RunOptions
): Promise<void> {
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    writeLine(`  ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`  ${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  // Check if target is a squad or an agent
  const squad = loadSquad(target);

  if (squad) {
    await track(Events.CLI_RUN, { type: 'squad', target: squad.name });
    await runSquad(squad, squadsDir, options);
  } else {
    // Try to find as an agent
    const agents = listAgents(squadsDir);
    const agent = agents.find(a => a.name === target);

    if (agent && agent.filePath) {
      // Extract squad name from path
      const pathParts = agent.filePath.split('/');
      const squadIdx = pathParts.indexOf('squads');
      const squadName = squadIdx >= 0 ? pathParts[squadIdx + 1] : 'unknown';
      await runAgent(agent.name, agent.filePath, squadName, options);
    } else {
      writeLine(`  ${colors.red}Squad or agent "${target}" not found${RESET}`);
      writeLine(`  ${colors.dim}Run \`squads list\` to see available squads and agents.${RESET}`);
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

  const startTime = new Date().toISOString();

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}run${RESET} ${colors.cyan}${squad.name}${RESET}`);
  writeLine();
  if (squad.mission) {
    writeLine(`  ${colors.dim}${squad.mission}${RESET}`);
    writeLine();
  }
  writeLine(`  ${colors.dim}Started: ${startTime}${RESET}`);
  writeLine();

  // If there's a pipeline, run agents in order
  if (squad.pipelines.length > 0) {
    const pipeline = squad.pipelines[0];
    writeLine(`  ${bold}Pipeline${RESET} ${colors.dim}${pipeline.agents.join(' → ')}${RESET}`);
    writeLine();

    for (let i = 0; i < pipeline.agents.length; i++) {
      const agentName = pipeline.agents[i];
      const agentPath = join(squadsDir, squad.name, `${agentName}.md`);

      if (existsSync(agentPath)) {
        writeLine(`  ${colors.dim}[${i + 1}/${pipeline.agents.length}]${RESET}`);
        await runAgent(agentName, agentPath, squad.name, options);
        writeLine();
      } else {
        writeLine(`  ${icons.warning} ${colors.yellow}Agent ${agentName} not found, skipping${RESET}`);
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
        await runAgent(orchestrator.name, agentPath, squad.name, options);
      }
    } else {
      writeLine(`  ${colors.dim}No pipeline defined. Available agents:${RESET}`);
      for (const agent of squad.agents) {
        writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
      }
      writeLine();
      writeLine(`  ${colors.dim}Run a specific agent:${RESET}`);
      writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --agent ${colors.cyan}<name>${RESET}`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}After execution, record outcome:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads feedback add ${colors.cyan}${squad.name}${RESET} ${colors.cyan}<1-5>${RESET} ${colors.cyan}"<feedback>"${RESET}`);
  writeLine();
}

async function runAgent(
  agentName: string,
  agentPath: string,
  squadName: string,
  options: RunOptions & { execute?: boolean }
): Promise<void> {
  const spinner = ora(`Running agent: ${agentName}`).start();
  const startTime = new Date().toISOString();

  const definition = loadAgentDefinition(agentPath);

  if (options.dryRun) {
    spinner.info(`[DRY RUN] Would run ${agentName}`);
    if (options.verbose) {
      writeLine(`  ${colors.dim}Agent definition:${RESET}`);
      writeLine(`  ${colors.dim}${definition.slice(0, 500)}...${RESET}`);
    }
    return;
  }

  // Log execution start
  logExecution({
    squadName,
    agentName,
    startTime,
    status: 'running',
  });

  // Generate the Claude Code prompt
  const prompt = `Execute the ${agentName} agent from squad ${squadName}.

Read the agent definition at ${agentPath} and follow its instructions exactly.

The agent definition contains:
- Purpose/role
- Tools it can use (MCP servers, skills)
- Step-by-step instructions
- Expected output format

After completion:
1. Update the agent's memory in .agents/memory/${squadName}/${agentName}/state.md
2. Log any learnings to learnings.md
3. Report what was accomplished`;

  // Check if Claude CLI is available
  const claudeAvailable = await checkClaudeCliAvailable();

  if (options.execute && claudeAvailable) {
    spinner.text = `Executing ${agentName} with Claude Code...`;

    try {
      const result = await executeWithClaude(prompt, options.verbose);
      spinner.succeed(`Agent ${agentName} completed`);
      updateExecutionStatus(squadName, agentName, 'completed', 'Executed via Claude CLI');

      if (result) {
        writeLine(`  ${colors.dim}Output:${RESET}`);
        writeLine(`  ${result.slice(0, 500)}`);
        if (result.length > 500) writeLine(`  ${colors.dim}... (truncated)${RESET}`);
      }
    } catch (error) {
      spinner.fail(`Agent ${agentName} failed`);
      updateExecutionStatus(squadName, agentName, 'failed', String(error));
      writeLine(`  ${colors.red}${String(error)}${RESET}`);
    }
  } else {
    // Show instructions for manual execution
    spinner.succeed(`Agent ${agentName} ready`);
    writeLine(`  ${colors.dim}Execution logged: ${startTime}${RESET}`);

    if (!claudeAvailable) {
      writeLine();
      writeLine(`  ${colors.yellow}Claude CLI not found${RESET}`);
      writeLine(`  ${colors.dim}Install: npm install -g @anthropic-ai/claude-code${RESET}`);
    }

    writeLine();
    writeLine(`  ${colors.dim}To execute with Claude Code:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} claude --print "${prompt.replace(/"/g, '\\"').replace(/\n/g, ' ').slice(0, 80)}..."`);
    writeLine();
    writeLine(`  ${colors.dim}Or run with --execute flag:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET} --execute`);
    writeLine();
    writeLine(`  ${colors.dim}Or in Claude Code session:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} Run the ${colors.cyan}${agentName}${RESET} agent from ${agentPath}`);
  }
}

async function checkClaudeCliAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const check = spawn('which', ['claude'], { stdio: 'pipe' });
    check.on('close', (code) => resolve(code === 0));
    check.on('error', () => resolve(false));
  });
}

async function executeWithClaude(prompt: string, verbose?: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['--print', prompt];
    if (verbose) {
      writeLine(`  ${colors.dim}Spawning: claude ${args.slice(0, 1).join(' ')} ...${RESET}`);
    }

    const claude = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let output = '';
    let error = '';

    claude.stdout?.on('data', (data) => {
      output += data.toString();
      if (verbose) {
        process.stdout.write(data.toString());
      }
    });

    claude.stderr?.on('data', (data) => {
      error += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(error || `Claude exited with code ${code}`));
      }
    });

    claude.on('error', (err) => {
      reject(err);
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      claude.kill();
      reject(new Error('Execution timed out after 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

export async function runSquadCommand(
  squadName: string,
  options: RunOptions
): Promise<void> {
  return runCommand(squadName, options);
}
