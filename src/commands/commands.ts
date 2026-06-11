/**
 * `squads commands` — machine-readable introspection of the live command tree.
 *
 * Walks the Commander registry at runtime, so the output can never drift from
 * the actual CLI. Consumers: the docs site's generated CLI reference, the
 * squads-cli Claude skill drift-guard, and any agent that wants to discover
 * the command surface programmatically.
 *
 * Hidden commands (tombstoned/removed) are excluded by default; --all includes
 * them so migration tooling can see the full registry.
 */
import type { Command, Option } from 'commander';
import { writeLine } from '../lib/terminal.js';

// Commander keeps `hidden` private on Command (public on Option). Narrow cast
// instead of `any` to honor strict mode.
interface CommandInternals {
  _hidden?: boolean;
}

export interface CommandOptionInfo {
  flags: string;
  description: string;
  defaultValue?: string | number | boolean | string[];
  required: boolean;
}

export interface CommandInfo {
  name: string;
  usage: string;
  aliases: string[];
  description: string;
  hidden: boolean;
  options: CommandOptionInfo[];
  subcommands: CommandInfo[];
}

function isHidden(cmd: Command): boolean {
  return (cmd as unknown as CommandInternals)._hidden === true;
}

function describeOption(opt: Option): CommandOptionInfo {
  const info: CommandOptionInfo = {
    flags: opt.flags,
    description: opt.description || '',
    required: opt.required === true,
  };
  if (opt.defaultValue !== undefined) {
    info.defaultValue = opt.defaultValue as CommandOptionInfo['defaultValue'];
  }
  return info;
}

function usageOf(cmd: Command): string {
  const args = cmd.registeredArguments
    .map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`))
    .join(' ');
  return args ? `${cmd.name()} ${args}` : cmd.name();
}

export function describeCommand(cmd: Command, includeHidden: boolean): CommandInfo {
  return {
    name: cmd.name(),
    usage: usageOf(cmd),
    aliases: cmd.aliases(),
    description: cmd.description() || '',
    hidden: isHidden(cmd),
    options: cmd.options.filter((o) => includeHidden || !o.hidden).map(describeOption),
    subcommands: cmd.commands
      .filter((sub) => includeHidden || !isHidden(sub))
      .map((sub) => describeCommand(sub, includeHidden)),
  };
}

export interface CommandsTree {
  cli: string;
  version: string;
  generatedBy: string;
  commands: CommandInfo[];
}

export function buildCommandsTree(program: Command, includeHidden: boolean): CommandsTree {
  return {
    cli: program.name(),
    version: program.version() || 'unknown',
    generatedBy: 'squads commands --json',
    commands: program.commands
      .filter((cmd) => includeHidden || !isHidden(cmd))
      .map((cmd) => describeCommand(cmd, includeHidden)),
  };
}

export async function commandsCommand(
  program: Command,
  options: { json?: boolean; all?: boolean }
): Promise<void> {
  const tree = buildCommandsTree(program, options.all === true);

  if (options.json) {
    writeLine(JSON.stringify(tree, null, 2));
    return;
  }

  const { colors, RESET, bold } = await import('../lib/terminal.js');
  writeLine();
  writeLine(`  ${bold}${tree.cli}${RESET} ${colors.dim}v${tree.version} — ${tree.commands.length} commands${RESET}`);
  writeLine();
  for (const cmd of tree.commands) {
    const aliases = cmd.aliases.length > 0 ? ` ${colors.dim}(${cmd.aliases.join(', ')})${RESET}` : '';
    const subs = cmd.subcommands.length > 0
      ? ` ${colors.dim}[${cmd.subcommands.map((s) => s.name).join('|')}]${RESET}`
      : '';
    writeLine(`  ${colors.cyan}${cmd.usage}${RESET}${aliases}${subs}`);
    if (cmd.description) writeLine(`    ${colors.dim}${cmd.description}${RESET}`);
  }
  writeLine();
  writeLine(`  ${colors.dim}Machine-readable: squads commands --json${RESET}`);
}
