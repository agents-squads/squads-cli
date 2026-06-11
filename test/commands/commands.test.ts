import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { buildCommandsTree, describeCommand } from '../../src/commands/commands.js';

function makeProgram(): Command {
  const program = new Command();
  program.name('squads').version('9.9.9');
  program
    .command('run [target]')
    .alias('r')
    .description('Run a squad or agent')
    .option('-t, --timeout <minutes>', 'Per-agent timeout', '15')
    .option('--json', 'JSON output');
  const goal = program.command('goal').description('Manage goals');
  goal.command('set <squad> <text>').description('Set a goal');
  goal.command('list').description('List goals');
  program.command('old-cmd', { hidden: true }).description('[removed]');
  return program;
}

describe('buildCommandsTree', () => {
  it('captures name, version, and visible commands', () => {
    const tree = buildCommandsTree(makeProgram(), false);
    expect(tree.cli).toBe('squads');
    expect(tree.version).toBe('9.9.9');
    expect(tree.commands.map((c) => c.name)).toEqual(['run', 'goal']);
  });

  it('excludes hidden commands by default', () => {
    const tree = buildCommandsTree(makeProgram(), false);
    expect(tree.commands.find((c) => c.name === 'old-cmd')).toBeUndefined();
  });

  it('includes hidden commands with includeHidden, flagged as hidden', () => {
    const tree = buildCommandsTree(makeProgram(), true);
    const old = tree.commands.find((c) => c.name === 'old-cmd');
    expect(old).toBeDefined();
    expect(old!.hidden).toBe(true);
  });

  it('captures aliases, usage with optional args, and option defaults', () => {
    const tree = buildCommandsTree(makeProgram(), false);
    const run = tree.commands.find((c) => c.name === 'run')!;
    expect(run.aliases).toEqual(['r']);
    expect(run.usage).toBe('run [target]');
    const timeout = run.options.find((o) => o.flags.includes('--timeout'))!;
    expect(timeout.defaultValue).toBe('15');
  });

  it('walks subcommands recursively with required args', () => {
    const tree = buildCommandsTree(makeProgram(), false);
    const goal = tree.commands.find((c) => c.name === 'goal')!;
    expect(goal.subcommands.map((s) => s.name).sort()).toEqual(['list', 'set']);
    expect(goal.subcommands.find((s) => s.name === 'set')!.usage).toBe('set <squad> <text>');
  });

  it('output is JSON-serializable (no cycles)', () => {
    const tree = buildCommandsTree(makeProgram(), true);
    expect(() => JSON.stringify(tree)).not.toThrow();
  });
});

describe('describeCommand', () => {
  it('handles a command with no options or args', () => {
    const cmd = new Command().command('plain').description('nothing fancy');
    const info = describeCommand(cmd, false);
    expect(info).toMatchObject({ name: 'plain', usage: 'plain', options: [], subcommands: [] });
  });
});
