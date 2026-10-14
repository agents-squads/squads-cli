/**
 * Worktree guard (cli#1166, cli#1153): lanes escaped their worktree twice —
 * one switched the LIVE checkout's branch out from under ~10 uncommitted
 * files of foreign work, another edited live-checkout paths alongside its
 * worktree. The isolation contract (one lane = one worktree) was prompt-level
 * only; this makes it mechanical.
 *
 * A PreToolUse hook script, generated per spawn, blocks MUTATIONS aimed at
 * the primary checkout: Edit/Write/NotebookEdit on paths under it, and Bash
 * commands that `cd` into it, run `git -C` mutations against it, or redirect
 * output into it. Reads stay allowed (capability-classified gate — extend,
 * don't block), `<primary>/.agents/**` stays writable (lane logs, memory,
 * observability spool live there), and the guard disarms itself when the
 * session's cwd IS the primary root (foreground fallback mode, operator
 * watching — blocking there would brick the run).
 */

import { writeFileSync } from 'fs';
import { join } from 'path';

/** The Node source of the hook script. Exported for tests. */
export function buildWorktreeGuardScript(primaryRoot: string): string {
  const root = primaryRoot.replace(/\/+$/, '');
  return `#!/usr/bin/env node
// worktree-guard (cli#1166) — generated per spawn; blocks primary-checkout mutations.
const PRIMARY = ${JSON.stringify(root)};
const fs = require('fs');
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch { process.exit(0); }
  // Foreground fallback mode runs IN the primary root (operator watching) —
  // the guard would brick it, so disarm. realpath both sides: macOS tmp and
  // symlinked checkouts otherwise never compare equal (/var vs /private/var).
  const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };
  if (real(process.cwd()) === real(PRIMARY)) process.exit(0);

  const t = data.tool_name;
  const i = data.tool_input || {};
  const under = (p) => typeof p === 'string' && (p === PRIMARY || p.startsWith(PRIMARY + '/'));
  const exempt = (p) => typeof p === 'string' && p.startsWith(PRIMARY + '/.agents/');
  const block = (msg) => { console.error(msg); process.exit(2); };

  if (t === 'Edit' || t === 'Write' || t === 'NotebookEdit') {
    const p = i.file_path || i.notebook_path || '';
    if (under(p) && !exempt(p)) {
      block('worktree-guard: ' + t + ' targets the PRIMARY checkout (' + p + '). ' +
        'Lanes work in their own worktree — use a path under your cwd (cli#1166).');
    }
    process.exit(0);
  }

  if (t === 'Bash') {
    const c = String(i.command || '');
    if (!c.includes(PRIMARY)) process.exit(0);
    const esc = PRIMARY.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    const agentsExempt = '(?!/\\\\.agents)';
    const patterns = [
      // cd into the primary checkout (not its .agents subtree)
      new RegExp('(^|[;&|]\\\\s*|\\\\s)cd\\\\s+[\\'"]?' + esc + agentsExempt + '([\\'"/\\\\s;&|]|$)'),
      // git -C <primary> <mutating verb> — reads (log/show/diff/status/branch/
      // ls-files/fetch/worktree list) stay allowed
      new RegExp('git\\\\s+[^;&|]*-C\\\\s+[\\'"]?' + esc +
        '[\\'"]?\\\\s+(?!(log|show|diff|status|branch|ls-files|fetch|rev-parse|describe|worktree\\\\s+list)\\\\b)\\\\S'),
      // output redirection into the primary checkout (not .agents)
      new RegExp('>>?\\\\s*[\\'"]?' + esc + agentsExempt + '/'),
    ];
    for (const re of patterns) {
      if (re.test(c)) {
        block('worktree-guard: this command mutates the PRIMARY checkout (' + PRIMARY + '). ' +
          'Lanes work in their own worktree (cli#1166). Reads are fine; mutations are not.');
      }
    }
    process.exit(0);
  }

  process.exit(0);
});
`;
}

/** Hook config fragment for Claude settings `hooks`. */
export function buildWorktreeGuardHooks(scriptPath: string): Record<string, unknown> {
  return {
    PreToolUse: [
      {
        matcher: 'Edit|Write|NotebookEdit|Bash',
        hooks: [{ type: 'command', command: `node '${scriptPath.replace(/'/g, '')}'` }],
      },
    ],
  };
}

/** Write the guard script next to the settings file; returns its path. */
export function writeWorktreeGuardScript(primaryRoot: string, dir: string): string {
  const path = join(dir, `worktree-guard-${Date.now()}.cjs`);
  writeFileSync(path, buildWorktreeGuardScript(primaryRoot), { mode: 0o755 });
  return path;
}

/** Merge two Claude `hooks` configs (event → matcher entries). */
export function mergeHooks(
  a: unknown,
  b: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, unknown[]> = {};
  for (const src of [a, b]) {
    if (!src || typeof src !== 'object') continue;
    for (const [event, entries] of Object.entries(src as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      (out[event] ??= []).push(...entries);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
