import { Command } from 'commander';
import {
  findSquadsDir,
  loadSquad,
  listSquads,
  SquadContext,
  resolveExecutionContext,
} from '../lib/squad-parser.js';
import { track, Events } from '../lib/telemetry.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  box,
  padEnd,
  writeLine,
  icons,
} from '../lib/terminal.js';

interface ContextOptions {
  json?: boolean;
}

export async function contextShowCommand(
  squadName: string,
  options: ContextOptions = {}
): Promise<void> {
  await track(Events.CLI_CONTEXT, { squad: squadName });
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    writeLine(`${colors.dim}Run \`squads init\` to create one.${RESET}`);
    process.exit(1);
  }

  const squad = loadSquad(squadName);

  if (!squad) {
    writeLine(`${colors.red}Squad "${squadName}" not found.${RESET}`);
    process.exit(1);
  }

  // Resolve execution context to get full skill and MCP info
  const execContext = resolveExecutionContext(squad);

  if (options.json) {
    console.log(JSON.stringify({
      name: squad.name,
      mission: squad.mission,
      repo: squad.repo,
      stack: squad.stack,
      effort: squad.effort,
      context: squad.context,
      resolved: execContext.resolved,
    }, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}context${RESET} ${colors.cyan}${squad.name}${RESET}`);

  const ctx = squad.context;

  if (!ctx) {
    writeLine();
    writeLine(`  ${colors.yellow}No context defined in SQUAD.md frontmatter${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Add a frontmatter block to ${squad.name}/SQUAD.md:${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}---${RESET}`);
    writeLine(`  ${colors.dim}name: ${squad.name}${RESET}`);
    writeLine(`  ${colors.dim}context:${RESET}`);
    writeLine(`  ${colors.dim}  mcp: [chrome-devtools]${RESET}`);
    writeLine(`  ${colors.dim}  model: { default: sonnet }${RESET}`);
    writeLine(`  ${colors.dim}  budget: { daily: 10 }${RESET}`);
    writeLine(`  ${colors.dim}---${RESET}`);
    writeLine();
    return;
  }

  const tableWidth = 54;
  writeLine();
  writeLine(`  ${colors.purple}${box.horizontal.repeat(tableWidth)}${RESET}`);

  // MCP Config (show resolved source)
  const mcpSource = execContext.resolved.mcpSource;
  const mcpSourceLabel = mcpSource === 'squad-local' ? `${colors.green}squad-local${RESET}` :
                         mcpSource === 'generated' ? `${colors.cyan}generated${RESET}` :
                         mcpSource === 'user-override' ? `${colors.yellow}user-override${RESET}` :
                         `${colors.dim}fallback${RESET}`;

  if (execContext.resolved.mcpServers.length > 0) {
    writeLine(`  ${bold}MCP${RESET}       ${colors.cyan}${execContext.resolved.mcpServers.join(', ')}${RESET} ${colors.dim}(${mcpSourceLabel})${RESET}`);
  } else if (ctx?.mcp && ctx.mcp.length > 0) {
    writeLine(`  ${bold}MCP${RESET}       ${colors.cyan}${ctx.mcp.join(', ')}${RESET}`);
  } else {
    writeLine(`  ${bold}MCP${RESET}       ${colors.dim}none${RESET}`);
  }

  // Skills (show resolved with sources)
  const resolvedSkills = execContext.resolved.skills || [];
  if (resolvedSkills.length > 0) {
    const skillLabels = resolvedSkills.map(s => {
      const sourceColor = s.source === 'squad-local' ? colors.green :
                          s.source === 'project' ? colors.cyan :
                          colors.dim;
      return `${colors.cyan}${s.name}${RESET} ${sourceColor}(${s.source})${RESET}`;
    });
    writeLine(`  ${bold}Skills${RESET}    ${skillLabels.join(', ')}`);
  } else if (ctx?.skills && ctx.skills.length > 0) {
    writeLine(`  ${bold}Skills${RESET}    ${colors.cyan}${ctx.skills.join(', ')}${RESET}`);
  }

  // Memory
  if (ctx.memory?.load && ctx.memory.load.length > 0) {
    writeLine(`  ${bold}Memory${RESET}    ${colors.cyan}${ctx.memory.load.join(', ')}${RESET}`);
  }

  // Model
  if (ctx.model) {
    const modelParts: string[] = [];
    if (ctx.model.default) modelParts.push(`${colors.white}${ctx.model.default}${RESET} ${colors.dim}(default)${RESET}`);
    if (ctx.model.expensive) modelParts.push(`${colors.yellow}${ctx.model.expensive}${RESET} ${colors.dim}(expensive)${RESET}`);
    if (ctx.model.cheap) modelParts.push(`${colors.green}${ctx.model.cheap}${RESET} ${colors.dim}(cheap)${RESET}`);
    writeLine(`  ${bold}Model${RESET}     ${modelParts.join(', ')}`);
  }

  // Budget
  if (ctx.budget) {
    const budgetParts: string[] = [];
    if (ctx.budget.daily) budgetParts.push(`$${ctx.budget.daily}/day`);
    if (ctx.budget.weekly) budgetParts.push(`$${ctx.budget.weekly}/week`);
    if (ctx.budget.perExecution) budgetParts.push(`$${ctx.budget.perExecution}/run`);
    writeLine(`  ${bold}Budget${RESET}    ${colors.green}${budgetParts.join(', ')}${RESET}`);
  }

  // Effort
  if (squad.effort) {
    const effortColor = squad.effort === 'high' ? colors.red :
                        squad.effort === 'medium' ? colors.yellow : colors.green;
    writeLine(`  ${bold}Effort${RESET}    ${effortColor}${squad.effort}${RESET}`);
  }

  // Stack/Repo info
  if (squad.repo) {
    writeLine(`  ${bold}Repo${RESET}      ${colors.dim}${squad.repo}${RESET}`);
  }
  if (squad.stack) {
    writeLine(`  ${bold}Stack${RESET}     ${colors.dim}${squad.stack}${RESET}`);
  }

  writeLine(`  ${colors.purple}${box.horizontal.repeat(tableWidth)}${RESET}`);
  writeLine();

  // Commands
  writeLine(`  ${colors.dim}$${RESET} squads context show ${colors.cyan}${squad.name}${RESET} --json  ${colors.dim}JSON output${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squad.name}${RESET}                  ${colors.dim}Run with this context${RESET}`);
  writeLine();
}

export async function contextListCommand(
  options: ContextOptions = {}
): Promise<void> {
  await track(Events.CLI_CONTEXT, { action: 'list' });
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    process.exit(1);
  }

  const squads = listSquads(squadsDir);

  if (options.json) {
    const contexts: Record<string, SquadContext | undefined> = {};
    for (const name of squads) {
      const squad = loadSquad(name);
      if (squad) {
        contexts[name] = squad.context;
      }
    }
    console.log(JSON.stringify(contexts, null, 2));
    return;
  }

  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}context list${RESET}`);
  writeLine();

  const w = { name: 14, mcp: 24, model: 12, budget: 12 };
  const tableWidth = w.name + w.mcp + w.model + w.budget + 6;

  writeLine(`  ${colors.purple}${box.topLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.topRight}${RESET}`);

  const header = `  ${colors.purple}${box.vertical}${RESET} ` +
    `${bold}${padEnd('SQUAD', w.name)}${RESET}` +
    `${bold}${padEnd('MCP', w.mcp)}${RESET}` +
    `${bold}${padEnd('MODEL', w.model)}${RESET}` +
    `${bold}BUDGET${RESET}` +
    ` ${colors.purple}${box.vertical}${RESET}`;
  writeLine(header);

  writeLine(`  ${colors.purple}${box.teeRight}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.teeLeft}${RESET}`);

  for (const name of squads) {
    const squad = loadSquad(name);
    const ctx = squad?.context;

    const mcpStr = ctx?.mcp?.slice(0, 2).join(', ') || `${colors.dim}—${RESET}`;
    const modelStr = ctx?.model?.default || `${colors.dim}—${RESET}`;
    const budgetStr = ctx?.budget?.daily ? `$${ctx.budget.daily}/d` : `${colors.dim}—${RESET}`;

    const row = `  ${colors.purple}${box.vertical}${RESET} ` +
      `${colors.cyan}${padEnd(name, w.name)}${RESET}` +
      `${padEnd(mcpStr, w.mcp)}` +
      `${padEnd(modelStr, w.model)}` +
      `${padEnd(budgetStr, w.budget)}` +
      `${colors.purple}${box.vertical}${RESET}`;

    writeLine(row);
  }

  writeLine(`  ${colors.purple}${box.bottomLeft}${colors.dim}${box.horizontal.repeat(tableWidth)}${colors.purple}${box.bottomRight}${RESET}`);
  writeLine();
}

interface ActivateOptions {
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
}

/**
 * Activate execution context for a squad.
 * Resolves MCP config, skills, and memory paths.
 * Generates squad-scoped .mcp.json if needed.
 */
export async function contextActivateCommand(
  squadName: string,
  options: ActivateOptions = {}
): Promise<void> {
  await track(Events.CLI_CONTEXT, { squad: squadName, action: 'activate' });

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`${colors.red}No .agents/squads directory found${RESET}`);
    process.exit(1);
  }

  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`${colors.red}Squad "${squadName}" not found.${RESET}`);
    process.exit(1);
  }

  // Resolve execution context
  const execContext = resolveExecutionContext(squad, options.force);

  if (options.json) {
    console.log(JSON.stringify(execContext, null, 2));
    return;
  }

  if (options.dryRun) {
    writeLine();
    writeLine(`  ${gradient('squads')} ${colors.dim}context activate${RESET} ${colors.cyan}${squadName}${RESET} ${colors.yellow}(dry run)${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Would resolve:${RESET}`);
    writeLine();
    writeLine(`  ${bold}MCP Config${RESET}`);
    writeLine(`    Path:    ${execContext.resolved.mcpConfigPath}`);
    writeLine(`    Source:  ${execContext.resolved.mcpSource}`);
    if (execContext.resolved.mcpServers.length > 0) {
      writeLine(`    Servers: ${execContext.resolved.mcpServers.join(', ')}`);
    }

    if (execContext.resolved.skills && execContext.resolved.skills.length > 0) {
      writeLine();
      writeLine(`  ${bold}Skills${RESET}`);
      for (const skill of execContext.resolved.skills) {
        const sourceColor = skill.source === 'squad-local' ? colors.green :
                           skill.source === 'project' ? colors.cyan :
                           colors.dim;
        writeLine(`    ${colors.cyan}${skill.name}${RESET} ${sourceColor}(${skill.source})${RESET}`);
        writeLine(`      ${colors.dim}${skill.path}${RESET}`);
      }
    }

    if (execContext.resolved.memoryPaths.length > 0) {
      writeLine();
      writeLine(`  ${bold}Memory${RESET}`);
      for (const path of execContext.resolved.memoryPaths) {
        writeLine(`    ${colors.dim}${path}${RESET}`);
      }
    }

    writeLine();
    writeLine(`  ${colors.dim}Run without --dry-run to generate config${RESET}`);
    writeLine();
    return;
  }

  // Actually activate (generate config if needed)
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}context activate${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();

  // Show what was resolved/generated
  const mcpSourceLabel = execContext.resolved.mcpSource === 'squad-local'
    ? `${colors.green}squad-local${RESET}`
    : execContext.resolved.mcpSource === 'generated'
    ? `${colors.cyan}generated${RESET}`
    : execContext.resolved.mcpSource === 'user-override'
    ? `${colors.yellow}user override${RESET}`
    : `${colors.dim}fallback${RESET}`;

  const sourceLabel = mcpSourceLabel;

  writeLine(`  ${icons.success} MCP config: ${sourceLabel}`);
  writeLine(`    ${colors.dim}${execContext.resolved.mcpConfigPath}${RESET}`);

  if (execContext.resolved.mcpServers.length > 0) {
    writeLine(`    ${colors.dim}Servers: ${execContext.resolved.mcpServers.join(', ')}${RESET}`);
  }

  if (execContext.resolved.skills && execContext.resolved.skills.length > 0) {
    // Group skills by source
    const bySource = execContext.resolved.skills.reduce((acc, s) => {
      acc[s.source] = (acc[s.source] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const sourceSummary = Object.entries(bySource)
      .map(([source, count]) => `${count} ${source}`)
      .join(', ');

    writeLine(`  ${icons.success} Skills: ${execContext.resolved.skills.length} resolved (${sourceSummary})`);
  }

  if (execContext.resolved.memoryPaths.length > 0) {
    writeLine(`  ${icons.success} Memory: ${execContext.resolved.memoryPaths.length} files`);
  }

  writeLine();
  writeLine(`  ${colors.dim}To use this context manually:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} claude --mcp-config '${execContext.resolved.mcpConfigPath}'`);
  writeLine();
  writeLine(`  ${colors.dim}Or run with squads:${RESET}`);
  writeLine(`  ${colors.dim}$${RESET} squads run ${colors.cyan}${squadName}${RESET}`);
  writeLine();
}

/**
 * Output a ready-to-use prompt for Claude Code execution.
 * Usage: squads context prompt <squad> -a <agent>
 * Pipe to claude: squads context prompt company -a event-dispatcher | claude --print
 */
interface PromptOptions {
  agent?: string;
  json?: boolean;
}

export async function contextPromptCommand(
  squadName: string,
  options: PromptOptions = {}
): Promise<void> {
  await track(Events.CLI_CONTEXT, { squad: squadName, action: 'prompt' });
  const squadsDir = findSquadsDir();

  if (!squadsDir) {
    console.error('No .agents/squads directory found');
    process.exit(1);
  }

  const squad = loadSquad(squadName);
  if (!squad) {
    console.error(`Squad "${squadName}" not found.`);
    process.exit(1);
  }

  if (!options.agent) {
    console.error('Agent required. Use -a <agent>');
    process.exit(1);
  }

  const agentPath = `.agents/squads/${squadName}/${options.agent}.md`;

  // Build the prompt for Claude
  const prompt = `Execute the ${options.agent} agent from squad ${squadName}.

Read the agent definition at ${agentPath} and follow its instructions exactly.

CRITICAL INSTRUCTIONS:
- Work autonomously - do NOT ask clarifying questions
- Use Task tool to spawn sub-agents when needed
- Output findings to GitHub issues (gh issue create)
- Output code changes as PRs (gh pr create)
- Update memory files in .agents/memory/${squadName}/${options.agent}/
- Type /exit when done

Begin now.`;

  if (options.json) {
    console.log(JSON.stringify({
      squad: squadName,
      agent: options.agent,
      agentPath,
      prompt,
    }, null, 2));
  } else {
    // Output raw prompt for piping to claude
    console.log(prompt);
  }
}

export function registerEnvCommand(program: Command): void {
  const env = program
    .command('env')
    .description('View squad execution environment (MCP, skills, model, budget)');

  env
    .command('show <squad>')
    .description('Show execution environment for a squad')
    .option('--json', 'Output as JSON')
    .action(contextShowCommand);

  env
    .command('list')
    .description('List execution environment for all squads')
    .option('--json', 'Output as JSON')
    .action(contextListCommand);

  env
    .command('activate <squad>')
    .description('Activate execution context for a squad (generates scoped MCP config)')
    .option('-d, --dry-run', 'Show what would be generated without writing files')
    .option('-f, --force', 'Force regeneration even if config exists')
    .option('--json', 'Output as JSON')
    .action(contextActivateCommand);

  env
    .command('prompt <squad>')
    .description('Output ready-to-use prompt for Claude Code execution')
    .option('-a, --agent <agent>', 'Agent to execute (required)')
    .option('--json', 'Output as JSON')
    .action(contextPromptCommand);
}
