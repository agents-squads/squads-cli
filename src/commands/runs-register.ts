/**
 * `squads runs` + `squads runs annotate` — command registration only.
 *
 * Kept separate from the handlers in `runs.ts` so that module (and its heavy
 * transitive imports — execution-engine, api-client, …) stays lazy-loaded on
 * first use, matching the cold-start budget in cli.ts. Tests build a Commander
 * program around this to exercise the real option parsing; the `--json` merge
 * below depends on Commander's parent/child option resolution, which a direct
 * `annotateRunCommand` call never sees.
 */
import type { Command } from 'commander';

export function registerRunsCommand(program: Command): void {
  const runs = program
    .command('runs')
    .description('List live background agent runs (pid-file inventory)')
    .option('--json', 'Output as JSON')
    .option('--clean', 'Remove stale pid files; salvage crashed runs (harvest + record)')
    .option('--replay <execId>', 'Re-render a finished run\'s activity feed from its recorded events')
    .option('--report <execId>', 'Context-economy report for a finished run (per-agent cost, cache hits, per-layer)')
    .option('--outcome <execId>', 'Did the run\'s output land? Resolve its PRs/issues live: merged/open/closed')
    .option('--wait [runId]', 'Block until a background run ends, then print a summary (default: newest live run)')
    .action(async (options) => {
      const { runsCommand } = await import('./runs.js');
      return runsCommand(options);
    });

  runs
    .command('annotate')
    .description('Attach gate result or review verdict to the run that produced a commit')
    .requiredOption('--commit <sha>', 'Commit SHA to find the run for')
    .option('--gate <result>', 'Gate result: pass or fail')
    .option('--tests <count>', 'Test count as passed/total (e.g. 3104/3109)')
    .option('--new-failures <list>', 'Comma-separated list of new failure names')
    .option('--pr <url>', 'PR URL (for gate result)')
    .option('--verdict <result>', 'Review verdict: PASS or FAIL')
    .option('--findings <n>', 'Number of findings (for review verdict)')
    .option('--severity <level>', 'Severity level (for review verdict)')
    .option('--reviewer-run-id <id>', 'Reviewer run ID (for review verdict)')
    .option('-j, --json', 'Output as JSON')
    .addHelpText('after', `
Examples:
  $ squads runs annotate --commit abc123 --gate pass --tests 3104/3109
  $ squads runs annotate --commit abc123 --gate fail --tests 3104/3109 --new-failures "test1,test2" --pr https://github.com/owner/repo/pull/42
  $ squads runs annotate --commit abc123 --verdict PASS --findings 3 --severity HIGH
  $ squads runs annotate --commit abc123 --verdict FAIL --findings 5 --reviewer-run-id run_abc123
`)
    .action(async (options) => {
      // `--json` is also declared on the parent `runs` command, and Commander
      // resolves the long flag against the parent before the subcommand, so
      // `squads runs annotate --json` lands in runs.opts() and only `-j`
      // reaches `options` here. Merge the parent's value so both spellings work.
      const { annotateRunCommand } = await import('./runs.js');
      return annotateRunCommand({ ...options, json: options.json ?? runs.opts<{ json?: boolean }>().json });
    });
}
