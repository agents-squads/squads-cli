/**
 * command-surface.ts — the 0.9 deprecation pass (#1020).
 *
 * The audit (2026-07-07) found 61 top-level commands with real usage
 * concentrated in ~17 verbs and 19 commands with zero doc mentions. This
 * module shrinks the VISIBLE surface without breaking anyone: absorbed
 * command names keep working exactly as before, but are hidden from
 * --help and print a one-line deprecation notice (to stderr, so piped
 * stdout and --json consumers never see it). Removal happens no earlier
 * than one minor version after hiding.
 *
 * The canonical verb set is taught by the seed skill (templates/seed/
 * skills/squads-cli/SKILL.md) — this map is its enforcement half.
 */

import type { Command } from 'commander';

/** Absorbed command name → the canonical verb that owns the concern now. */
export const DEPRECATED_COMMANDS: Record<string, string> = {
  // execution — one verb runs work
  exec: 'run',
  orchestrate: 'run',
  autonomous: 'run',
  autopilot: 'run',
  autonomy: 'run',
  trigger: 'run',
  // the human gate
  approval: 'inbox',
  review: 'inbox',
  // observability — runs/status/usage/doctor cover it
  log: 'runs',
  obs: 'runs',
  results: 'runs',
  sessions: 'status',
  list: 'status',
  context: 'status',
  health: 'doctor',
  cost: 'usage',
  budget: 'usage',
  stats: 'usage',
  history: 'usage',
  // direction
  goals: 'goal',
  kpi: 'goal',
  progress: 'goal',
  // knowledge
  learn: 'memory',
  learnings: 'memory',
  cognition: 'memory',
  sync: 'memory',
  // evaluation
  eval: 'feedback',
  // platform/provider tail
  credentials: 'providers',
  tier: 'providers',
  services: 'providers',
  catalog: 'providers',
  deploy: 'providers',
  release: 'providers',
  // scaffolding
  add: 'init',
  'detect-squad': 'status',
};

/** Plumbing kept registered for hooks/automation but hidden from humans —
 *  no deprecation notice (SessionStart hooks call it on every session). */
export const HIDDEN_PLUMBING = new Set(['session']);

/**
 * Hide absorbed + plumbing commands from --help. Behavior is unchanged —
 * `hidden` only affects help listings; `squads commands --json --all`
 * still enumerates everything.
 */
export function applyCommandSurface(program: Command): void {
  for (const cmd of program.commands) {
    const name = cmd.name();
    if (name in DEPRECATED_COMMANDS || HIDDEN_PLUMBING.has(name)) {
      // Commander's help renderer reads the internal `_hidden` field — the
      // same one `.command(name, { hidden: true })` sets at creation (stable
      // since v7). The public `hidden` typing is read-surface only; assigning
      // it creates a dead property the renderer never consults.
      (cmd as Command & { _hidden: boolean })._hidden = true;
    }
  }
}

/**
 * One dim notice per invocation of a deprecated name, on stderr so stdout
 * (including --json) stays clean for parsers.
 */
export function installDeprecationNotices(program: Command): void {
  program.hook('preAction', (_root, actionCommand) => {
    // Walk to the top-level command under the program.
    let top: Command = actionCommand;
    while (top.parent && top.parent.parent) top = top.parent;
    const name = top.name();
    const canonical = DEPRECATED_COMMANDS[name];
    if (canonical) {
      process.stderr.write(
        `  squads ${name} is deprecated — the canonical verb is: squads ${canonical}\n`
      );
    }
  });
}
