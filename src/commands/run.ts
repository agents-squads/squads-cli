import ora from 'ora';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import {
  findSquadsDir,
  loadSquad,
  listAgents,
  loadAgentDefinition,
  EffortLevel,
  resolveExecutionContext,
  Squad,
} from '../lib/squad-parser.js';
import { resolveMcpConfigPath } from '../lib/mcp-config.js';
import {
  buildContextFromSquad,
  validateExecution,
  formatViolations,
  ExecutionRequest
} from '../lib/permissions.js';
import { findMemoryDir } from '../lib/memory.js';
import { track, Events, flushEvents } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine,
} from '../lib/terminal.js';

interface RunOptions {
  verbose?: boolean;
  dryRun?: boolean;
  agent?: string;
  timeout?: number; // minutes, default 30
  execute?: boolean;
  parallel?: boolean; // Run all agents in parallel
  lead?: boolean; // Run as lead session using Task tool for parallelization
  foreground?: boolean; // Run in foreground (no tmux)
  useApi?: boolean; // Use API credits instead of subscription
  effort?: EffortLevel; // Effort level: high, medium, low
  skills?: string[]; // Skills to load (skill IDs or local paths)
  trigger?: 'manual' | 'scheduled' | 'event' | 'smart'; // Trigger source for telemetry
}

/**
 * Execution context for telemetry tagging
 * Passed to Claude via environment variables for per-agent cost tracking
 */
interface ExecutionContext {
  squad: string;
  agent: string;
  taskType: 'evaluation' | 'execution' | 'research' | 'lead';
  trigger: 'manual' | 'scheduled' | 'event' | 'smart';
  executionId: string;
}

/**
 * Register execution context with the squads-bridge for telemetry
 * This allows the bridge to tag incoming OTel data with correct squad/agent info
 */
async function registerContextWithBridge(ctx: ExecutionContext): Promise<boolean> {
  const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';

  try {
    const response = await fetch(`${bridgeUrl}/api/context/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        execution_id: ctx.executionId,
        squad: ctx.squad,
        agent: ctx.agent,
        task_type: ctx.taskType,
        trigger: ctx.trigger,
      }),
    });

    if (!response.ok) {
      // Non-fatal - continue even if bridge is unavailable
      return false;
    }
    return true;
  } catch {
    // Bridge not available - continue anyway
    return false;
  }
}

/**
 * Generate a unique execution ID for telemetry tracking
 */
function generateExecutionId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `exec_${timestamp}_${random}`;
}

/**
 * Select MCP config based on squad name and context
 * Uses three-tier resolution:
 * 1. Squad context.mcp from SQUAD.md frontmatter (dynamic)
 * 2. User override at ~/.claude/mcp-configs/{squad}.json
 * 3. Legacy hardcoded mapping (backward compatibility)
 * 4. Fallback to ~/.claude.json
 */
function selectMcpConfig(squadName: string, squad?: Squad | null): string {
  // Tier 1 & 2: Use new context-based resolution if squad has context.mcp
  if (squad?.context?.mcp && squad.context.mcp.length > 0) {
    return resolveMcpConfigPath(squadName, squad.context.mcp);
  }

  // Tier 3: Legacy hardcoded mapping (for squads without context block)
  const home = process.env.HOME || '';
  const configsDir = join(home, '.claude', 'mcp-configs');

  const squadConfigs: Record<string, string> = {
    website: 'website.json',      // chrome-devtools, nano-banana
    research: 'research.json',    // x-mcp
    intelligence: 'research.json', // x-mcp
    analytics: 'data.json',       // supabase, grafana, ga4-admin
    engineering: 'data.json',     // supabase, grafana
  };

  const configFile = squadConfigs[squadName.toLowerCase()];
  if (configFile) {
    const configPath = join(configsDir, configFile);
    if (existsSync(configPath)) {
      return configPath;
    }
  }

  // Tier 4: Fallback to default user config
  return join(home, '.claude.json');
}

/**
 * Detect task type from agent name patterns
 * - *-eval, *-critic, *-review → evaluation
 * - *-lead, *-orchestrator → lead
 * - *-research, *-analyst → research
 * - everything else → execution
 */
function detectTaskType(agentName: string): ExecutionContext['taskType'] {
  const name = agentName.toLowerCase();
  if (name.includes('eval') || name.includes('critic') || name.includes('review') || name.includes('test')) {
    return 'evaluation';
  }
  if (name.includes('lead') || name.includes('orchestrator')) {
    return 'lead';
  }
  if (name.includes('research') || name.includes('analyst') || name.includes('intel')) {
    return 'research';
  }
  return 'execution';
}

/**
 * Ensure the project directory is trusted in Claude's config.
 * This prevents the workspace trust dialog from blocking autonomous execution.
 */
function ensureProjectTrusted(projectPath: string): void {
  const configPath = join(process.env.HOME || '', '.claude.json');

  if (!existsSync(configPath)) {
    // No Claude config yet - will be created on first interactive run
    return;
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));

    if (!config.projects) {
      config.projects = {};
    }

    if (!config.projects[projectPath]) {
      config.projects[projectPath] = {};
    }

    // Mark as trusted for autonomous execution
    if (!config.projects[projectPath].hasTrustDialogAccepted) {
      config.projects[projectPath].hasTrustDialogAccepted = true;
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    }
  } catch {
    // Don't fail execution if we can't update config
    // The dialog will just appear
  }
}

/**
 * Get the project root directory (where .agents/ lives)
 */
function getProjectRoot(): string {
  const squadsDir = findSquadsDir();
  if (squadsDir) {
    // .agents/squads -> .agents -> project root
    return dirname(dirname(squadsDir));
  }
  return process.cwd();
}

interface ExecutionRecord {
  squadName: string;
  agentName: string;
  executionId: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  status: 'running' | 'completed' | 'failed';
  trigger?: 'manual' | 'scheduled' | 'event' | 'smart';
  taskType?: 'evaluation' | 'execution' | 'research' | 'lead';
  outcome?: string;
  error?: string;
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
    content = readFileSync(logPath, 'utf-8').trimEnd();
  } else {
    content = `# ${record.squadName}/${record.agentName} - Execution Log`;
  }

  // Structured entry format for parsing
  const entry = `

---
<!-- exec:${record.executionId} -->
**${record.startTime}** | Status: ${record.status}
- ID: \`${record.executionId}\`
- Trigger: ${record.trigger || 'manual'}
- Task Type: ${record.taskType || 'execution'}
`;

  writeFileSync(logPath, content + entry);
}

function updateExecutionStatus(
  squadName: string,
  agentName: string,
  executionId: string,
  status: 'completed' | 'failed',
  details?: {
    outcome?: string;
    error?: string;
    durationMs?: number;
  }
): void {
  const logPath = getExecutionLogPath(squadName, agentName);
  if (!logPath || !existsSync(logPath)) return;

  let content = readFileSync(logPath, 'utf-8');
  const endTime = new Date().toISOString();

  // Find and update the specific execution by ID
  const execMarker = `<!-- exec:${executionId} -->`;
  const markerIndex = content.indexOf(execMarker);

  if (markerIndex === -1) return;

  // Find the next entry marker or end of file
  const nextEntryIndex = content.indexOf('\n---\n', markerIndex + 1);
  const entryEnd = nextEntryIndex === -1 ? content.length : nextEntryIndex;

  // Extract and update the entry
  const entryStart = content.lastIndexOf('\n---\n', markerIndex);
  const currentEntry = content.slice(entryStart, entryEnd);

  // Build completion details
  const durationStr = details?.durationMs
    ? `${(details.durationMs / 1000).toFixed(1)}s`
    : 'unknown';

  let updatedEntry = currentEntry
    .replace(/Status: running/, `Status: ${status}`)
    + `- Completed: ${endTime}
- Duration: ${durationStr}`;

  if (details?.outcome) {
    updatedEntry += `\n- Outcome: ${details.outcome}`;
  }
  if (details?.error) {
    updatedEntry += `\n- Error: ${details.error}`;
  }

  // Replace the entry in content
  content = content.slice(0, entryStart) + updatedEntry + content.slice(entryEnd);
  writeFileSync(logPath, content);
}

/**
 * Extract MCP servers mentioned in an agent definition
 * Looks for patterns like: mcp-server-name, chrome-devtools, firecrawl, etc.
 */
function extractMcpServersFromDefinition(definition: string): string[] {
  const servers: Set<string> = new Set();

  // Common MCP server patterns
  const knownServers = [
    'chrome-devtools',
    'firecrawl',
    'supabase',
    'grafana',
    'context7',
    'huggingface',
    'nano-banana'
  ];

  // Check for known servers in the definition
  for (const server of knownServers) {
    if (definition.toLowerCase().includes(server)) {
      servers.add(server);
    }
  }

  // Look for mcp: blocks in YAML
  const mcpMatch = definition.match(/mcp:\s*\n((?:\s*-\s*\S+\s*\n?)+)/i);
  if (mcpMatch) {
    const lines = mcpMatch[1].split('\n');
    for (const line of lines) {
      const serverMatch = line.match(/^\s*-\s*(\S+)/);
      if (serverMatch) {
        servers.add(serverMatch[1]);
      }
    }
  }

  return Array.from(servers);
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

  // Inherit effort from squad config if not provided via CLI
  if (!options.effort && squad.effort) {
    options.effort = squad.effort;
  }

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

  // LEAD MODE: Single orchestrator session using Task tool for parallelization
  if (options.lead) {
    await runLeadMode(squad, squadsDir, options);
    return;
  }

  // PARALLEL EXECUTION: --parallel --execute runs all agents simultaneously
  if (options.parallel) {
    const agentFiles = squad.agents
      .map(a => ({
        name: a.name,
        path: join(squadsDir, squad.name, `${a.name}.md`)
      }))
      .filter(a => existsSync(a.path));

    if (agentFiles.length === 0) {
      writeLine(`  ${icons.error} ${colors.red}No agent files found${RESET}`);
      return;
    }

    writeLine(`  ${bold}Parallel execution${RESET} ${colors.dim}${agentFiles.length} agents${RESET}`);
    writeLine();

    if (!options.execute) {
      // Preview mode
      for (const agent of agentFiles) {
        writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET}`);
      }
      writeLine();
      writeLine(`  ${colors.dim}Launch all agents in parallel:${RESET}`);
      writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --parallel --execute`);
      writeLine();
      return;
    }

    // Execute all in parallel
    writeLine(`  ${gradient('Launching')} ${agentFiles.length} agents in parallel...`);
    writeLine();

    const launches = agentFiles.map(agent =>
      runAgent(agent.name, agent.path, squad.name, options)
    );

    await Promise.all(launches);

    writeLine();
    writeLine(`  ${icons.success} All ${agentFiles.length} agents launched`);
    writeLine(`  ${colors.dim}Monitor: tmux ls | grep squads-${squad.name}${RESET}`);
    writeLine(`  ${colors.dim}Attach:  tmux attach -t <session>${RESET}`);
    writeLine();
    return;
  }

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
        writeLine();
        writeLine(`  ${colors.dim}Run all agents in parallel:${RESET}`);
        writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --parallel --execute`);
      }
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}After execution, record outcome:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads feedback add ${colors.cyan}${squad.name}${RESET} ${colors.cyan}<1-5>${RESET} ${colors.cyan}"<feedback>"${RESET}`);
  writeLine();
}

/**
 * Lead mode: Single orchestrator session that uses Task tool for parallel work.
 * Benefits over --parallel:
 * - Single session overhead vs N sessions
 * - Lead coordinates and routes work intelligently
 * - Task agents share context when needed
 * - Better parallelization (Claude's native Task tool)
 */
async function runLeadMode(
  squad: ReturnType<typeof loadSquad>,
  squadsDir: string,
  options: RunOptions
): Promise<void> {
  if (!squad) return;

  const agentFiles = squad.agents
    .map(a => ({
      name: a.name,
      path: join(squadsDir, squad.name, `${a.name}.md`),
      role: a.role || '',
    }))
    .filter(a => existsSync(a.path));

  if (agentFiles.length === 0) {
    writeLine(`  ${icons.error} ${colors.red}No agent files found${RESET}`);
    return;
  }

  writeLine(`  ${bold}Lead mode${RESET} ${colors.dim}orchestrating ${agentFiles.length} agents${RESET}`);
  writeLine();

  // List available agents
  for (const agent of agentFiles) {
    writeLine(`  ${icons.empty} ${colors.cyan}${agent.name}${RESET} ${colors.dim}${agent.role}${RESET}`);
  }
  writeLine();

  if (!options.execute) {
    writeLine(`  ${colors.dim}Launch lead session:${RESET}`);
    writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET} --lead --execute`);
    writeLine();
    return;
  }

  // Build the lead prompt
  const timeoutMins = options.timeout || 30;
  const agentList = agentFiles.map(a => `- ${a.name}: ${a.role}`).join('\n');
  const agentPaths = agentFiles.map(a => `- ${a.name}: ${a.path}`).join('\n');

  const prompt = `You are the Lead of the ${squad.name} squad.

## Mission
${squad.mission || 'Execute squad operations efficiently.'}

## Available Agents
${agentList}

## Agent Definition Files
${agentPaths}

## Your Role as Lead

1. **Assess the situation**: Check for pending work:
   - Run \`gh issue list --repo agents-squads/hq --label squad:${squad.name}\` for assigned issues
   - Check .agents/memory/${squad.name}/ for squad state and pending tasks
   - Review recent activity with \`git log --oneline -10\`

2. **Delegate work using Task tool**: For each piece of work:
   - Use the Task tool with subagent_type="general-purpose"
   - Include the agent definition file path in the prompt
   - Spawn multiple Task agents IN PARALLEL when work is independent
   - Example: "Read ${agentFiles[0]?.path || 'agent.md'} and execute its instructions for [specific task]"

3. **Coordinate parallel execution**:
   - Independent tasks → spawn Task agents in parallel (single message, multiple tool calls)
   - Dependent tasks → run sequentially
   - Monitor progress and handle failures

4. **Report and update memory**:
   - Update .agents/memory/${squad.name}/state.md with completed work
   - Log learnings to learnings.md
   - Create issues for follow-up work if needed

## Time Budget
You have ${timeoutMins} minutes. Prioritize high-impact work.

## Critical Instructions
- Use Task tool for delegation, NOT direct execution of agent work
- Spawn parallel Task agents when work is independent
- When done, type /exit to end the session
- Do NOT wait for user input - work autonomously

## Async Mode (CRITICAL)
This is ASYNC execution - Task agents must be fully autonomous:
- **Findings** → Create GitHub issues (gh issue create)
- **Code changes** → Create PRs (gh pr create)
- **Analysis results** → Write to .agents/outputs/ or memory files
- **NEVER wait for human review** - complete the work and move on
- **NEVER ask clarifying questions** - make reasonable decisions

Instruct each Task agent: "Work autonomously. Output findings to GitHub issues. Output code changes as PRs. Do not wait for review."

Begin by assessing pending work, then delegate to agents via Task tool.`;

  // Execute via Claude
  const claudeAvailable = await checkClaudeCliAvailable();
  if (!claudeAvailable) {
    writeLine(`  ${colors.yellow}Claude CLI not found${RESET}`);
    writeLine(`  ${colors.dim}Install: npm install -g @anthropic-ai/claude-code${RESET}`);
    return;
  }

  writeLine(`  ${gradient('Launching')} lead session${options.foreground ? ' (foreground)' : ''}...`);
  writeLine();

  try {
    const result = await executeWithClaude(prompt, options.verbose, timeoutMins, options.foreground, options.useApi, options.effort, options.skills, options.trigger || 'manual');

    if (options.foreground) {
      writeLine();
      writeLine(`  ${icons.success} Lead session completed`);
    } else {
      writeLine(`  ${icons.success} Lead session launched`);
      writeLine(`  ${colors.dim}${result}${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}The lead will:${RESET}`);
      writeLine(`  ${colors.dim}  1. Assess pending work (issues, memory)${RESET}`);
      writeLine(`  ${colors.dim}  2. Spawn Task agents for parallel execution${RESET}`);
      writeLine(`  ${colors.dim}  3. Coordinate and report results${RESET}`);
      writeLine();
      writeLine(`  ${colors.dim}Monitor: squads workers${RESET}`);
    }
  } catch (error) {
    writeLine(`  ${icons.error} ${colors.red}Failed to launch: ${error}${RESET}`);
  }
}

async function runAgent(
  agentName: string,
  agentPath: string,
  squadName: string,
  options: RunOptions & { execute?: boolean }
): Promise<void> {
  const spinner = ora(`Running agent: ${agentName}`).start();
  const startMs = Date.now();
  const startTime = new Date(startMs).toISOString();
  const executionId = generateExecutionId();
  const taskType = detectTaskType(agentName);

  const definition = loadAgentDefinition(agentPath);

  if (options.dryRun) {
    spinner.info(`[DRY RUN] Would run ${agentName}`);
    if (options.verbose) {
      writeLine(`  ${colors.dim}Agent definition:${RESET}`);
      writeLine(`  ${colors.dim}${definition.slice(0, 500)}...${RESET}`);
    }
    return;
  }

  // Pre-execution permission validation (Phase 3)
  const squadsDir = findSquadsDir();
  if (squadsDir) {
    const squadFilePath = join(squadsDir, squadName, 'SQUAD.md');
    if (existsSync(squadFilePath)) {
      const squadContent = readFileSync(squadFilePath, 'utf-8');
      const permContext = buildContextFromSquad(squadName, squadContent, agentName);

      // Build execution request from agent definition
      // For now, we validate MCP servers mentioned in the agent definition
      const mcpServers = extractMcpServersFromDefinition(definition);
      const execRequest: ExecutionRequest = {
        mcpServers
      };

      const permResult = validateExecution(permContext, execRequest);

      if (permResult.violations.length > 0) {
        spinner.stop();
        const violationLines = formatViolations(permResult);
        for (const line of violationLines) {
          writeLine(`  ${line}`);
        }
        writeLine();

        if (!permResult.allowed) {
          writeLine(`  ${colors.red}Execution blocked due to permission violations.${RESET}`);
          writeLine(`  ${colors.dim}Configure permissions in ${squadFilePath}${RESET}`);
          return;
        }
      }
    }
  }

  // Log execution start
  logExecution({
    squadName,
    agentName,
    executionId,
    startTime,
    status: 'running',
    trigger: options.trigger || 'manual',
    taskType,
  });

  // Generate the Claude Code prompt with timeout awareness
  const timeoutMins = options.timeout || 30;
  const prompt = `Execute the ${agentName} agent from squad ${squadName}.

Read the agent definition at ${agentPath} and follow its instructions exactly.

The agent definition contains:
- Purpose/role
- Tools it can use (MCP servers, skills)
- Step-by-step instructions
- Expected output format

TIME LIMIT: You have ${timeoutMins} minutes. Work efficiently:
- Focus on the most important tasks first
- If a task is taking too long, move on and note it for next run
- Aim to complete within ${Math.floor(timeoutMins * 0.7)} minutes

After completion:
1. Update the agent's memory in .agents/memory/${squadName}/${agentName}/state.md
2. Log any learnings to learnings.md
3. Summarize what was accomplished

CRITICAL: When you have completed your tasks OR reached the time limit:
- Type /exit immediately to end this session
- Do NOT wait for user input
- Do NOT ask follow-up questions
- Just /exit when done`;

  // Check if Claude CLI is available
  const claudeAvailable = await checkClaudeCliAvailable();

  if (options.execute && claudeAvailable) {
    spinner.text = options.foreground
      ? `Running ${agentName} in foreground...`
      : `Launching ${agentName} as background task...`;

    try {
      const result = await executeWithClaude(prompt, options.verbose, options.timeout || 30, options.foreground, options.useApi, options.effort, options.skills, options.trigger || 'manual');

      if (options.foreground) {
        spinner.succeed(`Agent ${agentName} completed`);
      } else {
        spinner.succeed(`Agent ${agentName} launched`);
        writeLine(`  ${colors.dim}${result}${RESET}`);
        writeLine();
        writeLine(`  ${colors.dim}Monitor:${RESET} squads workers`);
        writeLine(`  ${colors.dim}Memory:${RESET}  squads memory show ${squadName}`);
      }
    } catch (error) {
      spinner.fail(`Agent ${agentName} failed to launch`);
      updateExecutionStatus(squadName, agentName, executionId, 'failed', {
        error: String(error),
        durationMs: Date.now() - startMs,
      });
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

async function executeWithClaude(
  prompt: string,
  verbose?: boolean,
  _timeoutMinutes: number = 30,
  foreground?: boolean,
  useApi?: boolean,
  effort?: EffortLevel,
  skills?: string[],
  trigger: ExecutionContext['trigger'] = 'manual'
): Promise<string> {
  // Ensure the project is trusted (prevents workspace trust dialog)
  const projectRoot = getProjectRoot();
  ensureProjectTrusted(projectRoot);

  // Extract squad/agent from prompt for telemetry tagging
  const squadMatch = prompt.match(/squad (\w+)/);
  const agentMatch = prompt.match(/(\w+) agent/);
  const squadName = process.env.SQUADS_SQUAD || squadMatch?.[1] || 'unknown';
  const agentName = process.env.SQUADS_AGENT || agentMatch?.[1] || 'unknown';

  // Load squad for context-based MCP config resolution
  const squad = squadName !== 'unknown' ? loadSquad(squadName) : null;

  // Select MCP config based on squad context (dynamic) or legacy mapping (fallback)
  const mcpConfigPath = selectMcpConfig(squadName, squad);

  // Build execution context for telemetry
  const execContext: ExecutionContext = {
    squad: squadName,
    agent: agentName,
    taskType: detectTaskType(agentName),
    trigger,
    executionId: generateExecutionId(),
  };

  // Build env: remove ANTHROPIC_API_KEY unless --use-api is set
  // This ensures Claude uses OAuth subscription by default
  const { ANTHROPIC_API_KEY: _apiKey, ...envWithoutApiKey } = process.env;
  const spawnEnv = useApi ? process.env : envWithoutApiKey;

  // Escape prompt for shell
  const escapedPrompt = prompt.replace(/'/g, "'\\''");

  // Register context with bridge for telemetry (non-blocking)
  await registerContextWithBridge(execContext);

  // Foreground mode: run Claude directly in the terminal
  if (foreground) {
    if (verbose) {
      writeLine(`  ${colors.dim}Project: ${projectRoot}${RESET}`);
      writeLine(`  ${colors.dim}Mode: foreground${RESET}`);
      writeLine(`  ${colors.dim}Auth: ${useApi ? 'API credits' : 'subscription'}${RESET}`);
      writeLine(`  ${colors.dim}Execution: ${execContext.executionId}${RESET}`);
      writeLine(`  ${colors.dim}Task type: ${execContext.taskType}${RESET}`);
      writeLine(`  ${colors.dim}Trigger: ${execContext.trigger}${RESET}`);
      if (effort) {
        writeLine(`  ${colors.dim}Effort: ${effort}${RESET}`);
      }
      if (skills && skills.length > 0) {
        writeLine(`  ${colors.dim}Skills: ${skills.join(', ')}${RESET}`);
      }
    }

    return new Promise((resolve, reject) => {
      const claude = spawn('claude', [
        '--dangerously-skip-permissions',
        '--mcp-config', mcpConfigPath,
        '--',
        prompt
      ], {
        stdio: 'inherit',
        cwd: projectRoot,
        env: {
          ...spawnEnv,
          // Telemetry context for per-agent cost tracking
          SQUADS_SQUAD: execContext.squad,
          SQUADS_AGENT: execContext.agent,
          SQUADS_TASK_TYPE: execContext.taskType,
          SQUADS_TRIGGER: execContext.trigger,
          SQUADS_EXECUTION_ID: execContext.executionId,
          // OTel resource attributes for telemetry pipeline
          OTEL_RESOURCE_ATTRIBUTES: `squads.squad=${execContext.squad},squads.agent=${execContext.agent},squads.task_type=${execContext.taskType},squads.trigger=${execContext.trigger},squads.execution_id=${execContext.executionId}`,
          // Claude-specific options
          ...(effort && { CLAUDE_EFFORT: effort }),
          ...(skills && skills.length > 0 && { CLAUDE_SKILLS: skills.join(',') }),
        },
      });

      claude.on('close', (code) => {
        if (code === 0) {
          resolve('Session completed');
        } else {
          reject(new Error(`Claude exited with code ${code}`));
        }
      });

      claude.on('error', (err) => {
        reject(err);
      });
    });
  }

  // Background mode: run via tmux for session management
  const sessionName = process.env.SQUADS_TMUX_SESSION ||
    `squads-${squadName}-${agentName}-${Date.now()}`;

  if (verbose) {
    writeLine(`  ${colors.dim}Project: ${projectRoot}${RESET}`);
    writeLine(`  ${colors.dim}Session: ${sessionName}${RESET}`);
    writeLine(`  ${colors.dim}MCP config: ${mcpConfigPath}${RESET}`);
    writeLine(`  ${colors.dim}Auth: ${useApi ? 'API credits' : 'subscription'}${RESET}`);
    writeLine(`  ${colors.dim}Execution: ${execContext.executionId}${RESET}`);
    writeLine(`  ${colors.dim}Task type: ${execContext.taskType}${RESET}`);
    writeLine(`  ${colors.dim}Trigger: ${execContext.trigger}${RESET}`);
    if (effort) {
      writeLine(`  ${colors.dim}Effort: ${effort}${RESET}`);
    }
    if (skills && skills.length > 0) {
      writeLine(`  ${colors.dim}Skills: ${skills.join(', ')}${RESET}`);
    }
  }

  // Build Claude command with all permissions bypassed for autonomous execution
  // Auto-cleanup: kill tmux session when Claude exits (success or failure)
  const claudeCmd = `cd '${projectRoot}' && claude --dangerously-skip-permissions --mcp-config '${mcpConfigPath}' -- '${escapedPrompt}'; tmux kill-session -t ${sessionName} 2>/dev/null`;

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
      ...spawnEnv,
      // Telemetry context for per-agent cost tracking
      SQUADS_SQUAD: execContext.squad,
      SQUADS_AGENT: execContext.agent,
      SQUADS_TASK_TYPE: execContext.taskType,
      SQUADS_TRIGGER: execContext.trigger,
      SQUADS_EXECUTION_ID: execContext.executionId,
      // OTel resource attributes for telemetry pipeline
      OTEL_RESOURCE_ATTRIBUTES: `squads.squad=${execContext.squad},squads.agent=${execContext.agent},squads.task_type=${execContext.taskType},squads.trigger=${execContext.trigger},squads.execution_id=${execContext.executionId}`,
      // Claude-specific options
      ...(effort && { CLAUDE_EFFORT: effort }),
      ...(skills && skills.length > 0 && { CLAUDE_SKILLS: skills.join(',') }),
    },
  });

  tmux.unref();

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
