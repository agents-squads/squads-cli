import type { Command } from 'commander';

/**
 * Full command path from actionCommand.name() + parent chain, e.g. 'run',
 * 'memory sync', 'goal set'. Used as the root telemetry hook's event name
 * (#1009) — never includes positional argument values.
 */
export function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let node: Command | null = cmd;
  while (node && node.parent) {
    parts.unshift(node.name());
    node = node.parent;
  }
  return parts.join(' ') || cmd.name();
}

/**
 * Long flag names the user explicitly passed on this command — boolean
 * presence only, never the value. Excludes options left at their default
 * (or implied) value, and never reads positional arguments.
 */
export function presentFlagNames(cmd: Command): string[] {
  const flags: string[] = [];
  for (const opt of cmd.options) {
    const key = opt.attributeName();
    const source = cmd.getOptionValueSource(key);
    if (source === undefined || source === 'default' || source === 'implied') continue;
    flags.push(opt.long ? opt.long.replace(/^--/, '') : opt.name());
  }
  return flags;
}
