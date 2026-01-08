/**
 * Permission management commands
 *
 * Phase 3 of the Squads as Execution Contexts RFC (#110)
 *
 * Commands:
 * - squads permissions show <squad>   Show permission context for a squad
 * - squads permissions check <squad>  Validate permissions before execution
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  buildContextFromSquad,
  validateExecution,
  formatViolations,
  getDefaultContext,
  ExecutionRequest
} from '../lib/permissions.js';
import { findSquadsDir, loadSquad } from '../lib/squad-parser.js';
import {
  colors,
  bold,
  RESET,
  gradient,
  icons,
  writeLine
} from '../lib/terminal.js';

/**
 * Register permissions command with the CLI program
 */
export function registerPermissionsCommand(program: Command): void {
  const permissions = program
    .command('permissions')
    .alias('perms')
    .description('Manage and validate squad permissions');

  // Show permission context
  permissions
    .command('show <squad>')
    .description('Show permission context for a squad')
    .action(permissionsShowCommand);

  // Check permissions
  permissions
    .command('check <squad>')
    .description('Validate permissions before execution')
    .option('-a, --agent <agent>', 'Specify agent for context')
    .option('--mcp <servers...>', 'MCP servers to validate')
    .option('--bash <commands...>', 'Bash commands to validate')
    .option('--write <paths...>', 'Write paths to validate')
    .option('--read <paths...>', 'Read paths to validate')
    .action(permissionsCheckCommand);
}

/**
 * Show permission context for a squad
 */
async function permissionsShowCommand(squadName: string): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('Permissions')} ${colors.dim}show${RESET} ${colors.cyan}${squadName}${RESET}`);
  writeLine();

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`  ${icons.error} ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine();
    return;
  }

  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${icons.error} ${colors.red}Squad "${squadName}" not found${RESET}`);
    writeLine();
    return;
  }

  // Load permissions from SQUAD.md
  const squadFilePath = join(squadsDir, squadName, 'SQUAD.md');
  const squadContent = readFileSync(squadFilePath, 'utf-8');
  const context = buildContextFromSquad(squadName, squadContent);

  // Check if using defaults
  const defaults = getDefaultContext(squadName);
  const isDefault = JSON.stringify(context.permissions) === JSON.stringify(defaults.permissions);

  writeLine(`  ${bold}Squad:${RESET} ${squadName}`);
  if (squad.mission) {
    writeLine(`  ${colors.dim}${squad.mission}${RESET}`);
  }
  writeLine();

  if (isDefault) {
    writeLine(`  ${icons.warning} ${colors.yellow}Using default (permissive) permissions${RESET}`);
    writeLine(`  ${colors.dim}Add a permissions block to SQUAD.md to restrict access.${RESET}`);
    writeLine();
  }

  // Mode
  writeLine(`  ${bold}Mode:${RESET} ${formatMode(context.permissions.mode)}`);
  writeLine();

  // Bash commands
  writeLine(`  ${bold}Bash Commands:${RESET}`);
  if (context.permissions.bash.includes('*')) {
    writeLine(`    ${colors.dim}All commands allowed (*)${RESET}`);
  } else {
    for (const cmd of context.permissions.bash) {
      writeLine(`    ${icons.active} ${cmd}`);
    }
  }
  writeLine();

  // File access
  writeLine(`  ${bold}Write Paths:${RESET}`);
  if (context.permissions.write.includes('**') || context.permissions.write.includes('*')) {
    writeLine(`    ${colors.dim}All paths writable (**)${RESET}`);
  } else {
    for (const path of context.permissions.write) {
      writeLine(`    ${icons.active} ${path}`);
    }
  }
  writeLine();

  writeLine(`  ${bold}Read Paths:${RESET}`);
  if (context.permissions.read.includes('**') || context.permissions.read.includes('*')) {
    writeLine(`    ${colors.dim}All paths readable (**)${RESET}`);
  } else {
    for (const path of context.permissions.read) {
      writeLine(`    ${icons.active} ${path}`);
    }
  }
  writeLine();

  // MCP servers
  writeLine(`  ${bold}MCP Servers:${RESET}`);
  if (context.permissions.mcp.allow.includes('*')) {
    writeLine(`    ${colors.dim}All servers allowed (*)${RESET}`);
  } else {
    writeLine(`    ${colors.green}Allow:${RESET}`);
    for (const server of context.permissions.mcp.allow) {
      writeLine(`      ${icons.success} ${server}`);
    }
  }
  if (context.permissions.mcp.deny.length > 0) {
    writeLine(`    ${colors.red}Deny:${RESET}`);
    for (const server of context.permissions.mcp.deny) {
      writeLine(`      ${icons.error} ${server}`);
    }
  }
  writeLine();

  // Help for adding permissions
  if (isDefault) {
    writeLine(`  ${bold}Add permissions to SQUAD.md:${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}\`\`\`yaml${RESET}`);
    writeLine(`  ${colors.dim}permissions:${RESET}`);
    writeLine(`  ${colors.dim}  mode: warn  # or strict, audit${RESET}`);
    writeLine(`  ${colors.dim}  bash: [npm, git, gh]${RESET}`);
    writeLine(`  ${colors.dim}  write: [agents-squads-web/**]${RESET}`);
    writeLine(`  ${colors.dim}  read: [hq/.agents/**]${RESET}`);
    writeLine(`  ${colors.dim}  mcp:${RESET}`);
    writeLine(`  ${colors.dim}    allow: [chrome-devtools]${RESET}`);
    writeLine(`  ${colors.dim}    deny: [supabase]${RESET}`);
    writeLine(`  ${colors.dim}\`\`\`${RESET}`);
    writeLine();
  }
}

/**
 * Check permissions before execution
 */
async function permissionsCheckCommand(
  squadName: string,
  options: {
    agent?: string;
    mcp?: string[];
    bash?: string[];
    write?: string[];
    read?: string[];
  }
): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('Permissions')} ${colors.dim}check${RESET} ${colors.cyan}${squadName}${RESET}`);
  if (options.agent) {
    writeLine(`  ${colors.dim}Agent: ${options.agent}${RESET}`);
  }
  writeLine();

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    writeLine(`  ${icons.error} ${colors.red}No .agents/squads directory found${RESET}`);
    writeLine();
    return;
  }

  const squad = loadSquad(squadName);
  if (!squad) {
    writeLine(`  ${icons.error} ${colors.red}Squad "${squadName}" not found${RESET}`);
    writeLine();
    return;
  }

  // Load permissions from SQUAD.md
  const squadFilePath = join(squadsDir, squadName, 'SQUAD.md');
  const squadContent = readFileSync(squadFilePath, 'utf-8');
  const context = buildContextFromSquad(squadName, squadContent, options.agent);

  // Build execution request from CLI options
  const request: ExecutionRequest = {
    mcpServers: options.mcp,
    bashCommands: options.bash,
    writePaths: options.write,
    readPaths: options.read
  };

  // Check if request is empty
  if (!options.mcp && !options.bash && !options.write && !options.read) {
    writeLine(`  ${colors.yellow}No resources specified to check.${RESET}`);
    writeLine();
    writeLine(`  ${colors.dim}Examples:${RESET}`);
    writeLine(`    ${colors.cyan}squads perms check ${squadName} --mcp chrome-devtools firecrawl${RESET}`);
    writeLine(`    ${colors.cyan}squads perms check ${squadName} --bash npm git docker${RESET}`);
    writeLine(`    ${colors.cyan}squads perms check ${squadName} --write src/** --read config/**${RESET}`);
    writeLine();
    return;
  }

  // Validate
  const result = validateExecution(context, request);

  if (result.violations.length === 0) {
    writeLine(`  ${icons.success} ${colors.green}All permissions valid${RESET}`);
    writeLine();

    // Show what was checked
    if (options.mcp) {
      writeLine(`  ${colors.dim}MCP:${RESET} ${options.mcp.join(', ')}`);
    }
    if (options.bash) {
      writeLine(`  ${colors.dim}Bash:${RESET} ${options.bash.join(', ')}`);
    }
    if (options.write) {
      writeLine(`  ${colors.dim}Write:${RESET} ${options.write.join(', ')}`);
    }
    if (options.read) {
      writeLine(`  ${colors.dim}Read:${RESET} ${options.read.join(', ')}`);
    }
    writeLine();
  } else {
    const violationLines = formatViolations(result);
    for (const line of violationLines) {
      writeLine(`  ${line}`);
    }
    writeLine();

    // Exit with error code if strict mode blocks
    if (!result.allowed) {
      process.exit(1);
    }
  }
}

/**
 * Format enforcement mode for display
 */
function formatMode(mode: string): string {
  switch (mode) {
    case 'strict':
      return `${colors.red}strict${RESET} ${colors.dim}(blocks on violation)${RESET}`;
    case 'warn':
      return `${colors.yellow}warn${RESET} ${colors.dim}(logs and continues)${RESET}`;
    case 'audit':
      return `${colors.cyan}audit${RESET} ${colors.dim}(logs to trail)${RESET}`;
    default:
      return mode;
  }
}
