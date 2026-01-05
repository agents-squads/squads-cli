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
import { track, Events, flushEvents } from '../lib/telemetry.js';
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
  timeout?: number; // minutes, default 30
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
    await flushEvents(); // Ensure telemetry is sent before potential exit
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
    // If specific agent requested via -a flag, run that agent
    if (options.agent) {
      const agentPath = join(squadsDir, squad.name, `${options.agent}.md`);
      if (existsSync(agentPath)) {
        await runAgent(options.agent, agentPath, squad.name, options);
      } else {
        writeLine(`  ${icons.error} ${colors.red}Agent ${options.agent} not found${RESET}`);
        return;
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
    spinner.text = `Launching ${agentName} as background task...`;

    try {
      const result = await executeWithClaude(prompt, options.verbose, options.timeout || 30);
      spinner.succeed(`Agent ${agentName} launched`);
      // Don't mark as completed - it's running in background
      // Agent will update its own memory when done

      writeLine(`  ${colors.dim}${result}${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}Monitor:${RESET} squads workers`);
      writeLine(`  ${colors.dim}Memory:${RESET}  squads memory show ${squadName}`);
    } catch (error) {
      spinner.fail(`Agent ${agentName} failed to launch`);
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
    writeLine(`  ${colors.dim}To launch as background task:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET} -a ${colors.cyan}${agentName}${RESET} --execute`);
    writeLine();
    writeLine(`  ${colors.dim}Or run interactively:${RESET}`);
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

async function executeWithClaude(prompt: string, verbose?: boolean, timeoutMinutes: number = 30): Promise<string> {
  // Use interactive Claude Code (subscription) instead of --print (API credits)
  // Run via tmux for real PTY support and session management
  const userConfigPath = join(process.env.HOME || '', '.claude.json');

  // Extract squad/agent from prompt for telemetry tagging
  const squadMatch = prompt.match(/squad (\w+)/);
  const agentMatch = prompt.match(/(\w+) agent/);
  const squadName = squadMatch?.[1] || 'unknown';
  const agentName = agentMatch?.[1] || 'unknown';

  // Create unique session name
  const timestamp = Date.now();
  const sessionName = `squads-${squadName}-${agentName}-${timestamp}`;

  if (verbose) {
    writeLine(`  ${colors.dim}Spawning tmux session: ${sessionName}${RESET}`);
  }

  // Escape prompt for shell
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Build Claude command with all permissions bypassed for autonomous execution
  const claudeCmd = `claude --dangerously-skip-permissions --mcp-config '${userConfigPath}' -- '${escapedPrompt}'`;

  // Create detached tmux session running Claude
  const tmux = spawn('tmux', [
    'new-session',
    '-d',           // Detached
    '-s', sessionName,
    '-x', '200',    // Wide terminal for better output
    '-y', '50',
    '/bin/sh', '-c', claudeCmd
  ], {
    stdio: 'ignore',
    detached: true,
    env: {
      ...process.env,
      SQUADS_SQUAD: squadName,
      SQUADS_AGENT: agentName,
    },
  });

  tmux.unref();

  // Spawn a background process to auto-accept the dialog after it appears
  // This runs outside the tmux session and sends keys to it
  spawn('/bin/sh', ['-c', `sleep 2 && tmux send-keys -t '${sessionName}' Down Enter`], {
    stdio: 'ignore',
    detached: true,
  }).unref();

  if (verbose) {
    writeLine(`  ${colors.dim}Attach: tmux attach -t ${sessionName}${RESET}`);
  }

  return `tmux session: ${sessionName}. Attach: tmux attach -t ${sessionName}`;
}

export async function runSquadCommand(
  squadName: string,
  options: RunOptions
): Promise<void> {
  return runCommand(squadName, options);
}
