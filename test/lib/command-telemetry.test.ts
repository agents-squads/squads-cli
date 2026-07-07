import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { commandPath, presentFlagNames } from '../../src/lib/command-telemetry';

describe('command-telemetry (#1009)', () => {
  describe('commandPath', () => {
    it('returns the program name for the root action command', () => {
      const program = new Command('squads');
      expect(commandPath(program)).toBe('squads');
    });

    it('returns a single segment for a top-level command', () => {
      const program = new Command('squads');
      const run = program.command('run [target]');
      expect(commandPath(run)).toBe('run');
    });

    it('builds a spaced path for nested subcommands', () => {
      const program = new Command('squads');
      const goal = program.command('goal');
      const set = goal.command('set <squad> <description>');
      expect(commandPath(set)).toBe('goal set');
    });

    it('builds a spaced path regardless of nesting depth', () => {
      const program = new Command('squads');
      const credentials = program.command('credentials');
      const create = credentials.command('create <squad>');
      expect(commandPath(create)).toBe('credentials create');
    });
  });

  describe('presentFlagNames', () => {
    it('returns an empty list when no flags were passed', () => {
      const program = new Command('squads');
      program.exitOverride();
      const run = program
        .command('run [target]')
        .option('-v, --verbose', 'verbose')
        .option('--task <directive>', 'directive');
      program.parse(['node', 'squads', 'run'], { from: 'node' });
      expect(presentFlagNames(run)).toEqual([]);
    });

    it('returns only the long names of explicitly passed flags', () => {
      const program = new Command('squads');
      program.exitOverride();
      const run = program
        .command('run [target]')
        .option('-v, --verbose', 'verbose')
        .option('--task <directive>', 'directive')
        .option('--timeout <minutes>', 'timeout');
      program.parse(['node', 'squads', 'run', 'mysquad', '--verbose', '--task', 'super secret directive'], { from: 'node' });
      expect(presentFlagNames(run).sort()).toEqual(['task', 'verbose']);
    });

    it('never reflects the value of a value-taking flag, only its name', () => {
      const program = new Command('squads');
      program.exitOverride();
      const run = program
        .command('run [target]')
        .option('--task <directive>', 'directive');
      program.parse(['node', 'squads', 'run', '--task', 'do not leak this text'], { from: 'node' });
      const flags = presentFlagNames(run);
      expect(flags).toEqual(['task']);
      expect(JSON.stringify(flags)).not.toContain('do not leak this text');
    });

    it('excludes options left at their default value', () => {
      const program = new Command('squads');
      program.exitOverride();
      const run = program
        .command('run [target]')
        .option('--max-turns <n>', 'max turns', '20');
      program.parse(['node', 'squads', 'run'], { from: 'node' });
      expect(presentFlagNames(run)).toEqual([]);
    });

    it('includes an explicitly passed flag even when it matches the default value', () => {
      const program = new Command('squads');
      program.exitOverride();
      const run = program
        .command('run [target]')
        .option('--max-turns <n>', 'max turns', '20');
      program.parse(['node', 'squads', 'run', '--max-turns', '20'], { from: 'node' });
      expect(presentFlagNames(run)).toEqual(['max-turns']);
    });
  });
});
