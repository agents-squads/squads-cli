import {
  findSquadsDir,
  loadSquad,
  listSquads,
  SquadContext,
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

  if (options.json) {
    console.log(JSON.stringify({
      name: squad.name,
      mission: squad.mission,
      repo: squad.repo,
      stack: squad.stack,
      effort: squad.effort,
      context: squad.context,
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

  // MCP Servers
  if (ctx.mcp && ctx.mcp.length > 0) {
    writeLine(`  ${bold}MCP${RESET}       ${colors.cyan}${ctx.mcp.join(', ')}${RESET}`);
  } else {
    writeLine(`  ${bold}MCP${RESET}       ${colors.dim}none${RESET}`);
  }

  // Skills
  if (ctx.skills && ctx.skills.length > 0) {
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
