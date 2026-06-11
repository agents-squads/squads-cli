#!/usr/bin/env node
/**
 * Generate the seed skill's command reference from the live Commander
 * registry (hq#441) — the same introspection that feeds the docs site.
 *
 * The seed skill is planted into every user's project by `squads init`
 * (src/commands/init.ts → loadSeedTemplate), so a stale reference gives every
 * new user a stale capability map. Generation kills the drift class; the CI
 * job `skill-reference (drift guard)` enforces it.
 *
 * NOTE: .gitignore blankets `scripts/` as local-only — this file is tracked
 * via `git add -f` (it shipped MISSING in #848 because a plain `git add -A`
 * silently skipped it and the drift-guard job wasn't a required check).
 *
 * Usage (build first — reads the built CLI, never imports cli.ts directly):
 *   npm run build && npm run gen:skill
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const tree = JSON.parse(
  execFileSync('node', [join(root, 'dist', 'cli.js'), 'commands', '--json'], { encoding: 'utf8' })
);

function row(usage, description) {
  return `| \`squads ${usage}\` | ${description.replace(/\|/g, '\\|')} |`;
}

const lines = [
  '# Squads CLI — Full Command Reference',
  '',
  `> GENERATED from \`squads commands --json\` (squads-cli v${tree.version}) — do not edit.`,
  '> Regenerate: `npm run build && npm run gen:skill`. For the live tree on any',
  '> installed version, run `squads commands --json` directly.',
  '',
  '## All Commands',
  '',
  '| Command | Description |',
  '|---------|-------------|',
];

for (const cmd of tree.commands) {
  if (cmd.subcommands.length === 0) {
    lines.push(row(cmd.usage, cmd.description));
  } else {
    for (const sub of cmd.subcommands) {
      lines.push(row(`${cmd.name} ${sub.usage}`, sub.description));
    }
  }
}

lines.push('');
lines.push('## Options Discovery');
lines.push('');
lines.push('Every command supports `--help`; most support `--json` for machine output.');
lines.push('The authoritative, always-current surface is `squads commands --json`.');
lines.push('');

writeFileSync(join(root, 'templates', 'seed', 'skills', 'squads-cli', 'references', 'commands.md'), lines.join('\n'));
console.log(`seed skill reference generated — v${tree.version}, ${tree.commands.length} top-level commands`);
