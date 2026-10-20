/**
 * Governance for the Kimi Code CLI harness (cli#1309), same fail-closed
 * contract as the opencode harness (#1306 / PR #1308).
 *
 * The difference that shapes this module: `kimi -p` has NO permission surface.
 * Prompt mode cannot be combined with `--auto` and runs every tool (Bash,
 * Read, Write) without asking, so kimi's own permission modes can never carry a
 * grant. Governance therefore comes entirely from our side:
 *
 *  - `assessKimiGrants()` refuses a contract kimi cannot honour. An EXPLICIT
 *    contract (`tool_grants` in the agent file) that scopes Bash, omits
 *    Read/Write/Edit/Bash, or names an MCP tool would be silently widened to
 *    "everything" — so the run is refused. The unscoped DEFAULT surface is the
 *    one case accepted, with a loud warning that shell scope is the sandbox.
 *  - `compileKimiWriteDenies()` turns the guardrail's `Edit|Write(**\/name)`
 *    deny rules into OS-sandbox write denies (Seatbelt regex). Any other rule
 *    shape, or a platform that cannot express them (bwrap has no globs), refuses.
 *  - `resolveKimiSandbox()` wraps the spawn in macOS `sandbox-exec` / Linux
 *    `bwrap`: writes confined to the worktree + git common dir + memory + kimi's
 *    own session/log state; credential dirs unreadable. NOT writable: the kimi
 *    binary (`~/.kimi-code/bin`), `config.toml` and the credentials — a lane that
 *    could write them would plant code that later runs OUTSIDE the sandbox.
 *
 * The sandbox helpers mirror opencode-governance.ts (PR #1308) on purpose and
 * stay a separate module so the two PRs compose in either order; unifying them
 * into one shared sandbox module is a follow-up.
 */

import { existsSync, realpathSync, readdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { CREDENTIAL_DENY_PATHS, bwrapDenyReadArgs } from './sandbox-settings.js';

export class KimiGovernanceError extends Error {
  constructor(message: string) {
    super(`kimi-code governance: ${message} — refusing the run (kimi -p auto-approves every tool, so nothing narrower than the sandbox can be enforced; cli#1309)`);
    this.name = 'KimiGovernanceError';
  }
}

/** Credential dirs denied for read — same shared list as Claude and opencode (cli#1337). */
export const KIMI_DENY_READ = CREDENTIAL_DENY_PATHS;

const expandHome = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

function realOrSame(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// ── Grants ───────────────────────────────────────────────────────────────────

/** Capabilities `kimi -p` always exposes; an explicit contract must grant all of them. */
const KIMI_FIXED_SURFACE = ['Bash', 'Read', 'Write', 'Edit'];

/** Tool names that need no scoping to be honoured (kimi has them or ignores them). */
const OTHER_PLAIN_GRANTS = new Set(['Glob', 'Grep', 'WebFetch', 'WebSearch', 'Agent', 'Task', 'TodoWrite', 'NotebookEdit']);

export interface KimiGrantAssessment {
  /** Non-fatal notes the caller prints (default surface widened to the sandbox boundary). */
  warnings: string[];
}

/**
 * Decide whether kimi can honour a contract. Throws KimiGovernanceError when it
 * cannot. `source` is compileAllowedTools's: 'contract' = the agent declared
 * explicit grants, 'default' = the conventional surface.
 */
export function assessKimiGrants(tools: string[], source: 'contract' | 'default'): KimiGrantAssessment {
  const warnings: string[] = [];
  const granted = new Set(tools.map((t) => t.trim()));
  const scoped = [...granted].filter((t) => /^Bash\(.+\)$/.test(t));
  const mcp = [...granted].filter((t) => t.startsWith('mcp__'));
  const unknown = [...granted].filter((t) => !t.startsWith('mcp__') && !/^Bash\(.+\)$/.test(t)
    && !KIMI_FIXED_SURFACE.includes(t) && !OTHER_PLAIN_GRANTS.has(t));

  if (mcp.length > 0) {
    throw new KimiGovernanceError(`MCP grant ${mcp.join(', ')} has no kimi equivalent (squads passes kimi no MCP config)`);
  }
  if (unknown.length > 0) {
    throw new KimiGovernanceError(`tool grant ${unknown.join(', ')} has no kimi equivalent`);
  }

  if (source === 'contract') {
    if (scoped.length > 0 && !granted.has('Bash')) {
      throw new KimiGovernanceError(`contract scopes Bash to ${scoped.join(', ')} but kimi runs unrestricted shell commands`);
    }
    const missing = KIMI_FIXED_SURFACE.filter((t) => !granted.has(t));
    if (missing.length > 0) {
      throw new KimiGovernanceError(`contract does not grant ${missing.join(', ')} but kimi cannot withhold it (grant ${KIMI_FIXED_SURFACE.join('+')} or run another harness)`);
    }
  } else if (scoped.length > 0 || !granted.has('Bash')) {
    warnings.push('default tool surface scopes Bash by command prefix; kimi cannot — shell scope here is the OS sandbox, not the allowlist');
  }
  return { warnings };
}

// ── Guardrail deny rules ─────────────────────────────────────────────────────

/** `Edit|Write(**\/<basename>)` → the basename. Anything else cannot be expressed. */
const NAME_DENY_RE = /^(?:Edit|Write)\(\*\*\/([A-Za-z0-9._-]+)\)$/;

/** Basenames the guardrail forbids writing (deduplicated). Throws on rules it cannot express. */
export function compileKimiWriteDenies(guardrailPermissions: unknown): string[] {
  if (!guardrailPermissions || typeof guardrailPermissions !== 'object') return [];
  const deny = (guardrailPermissions as { deny?: unknown }).deny;
  if (deny === undefined) return [];
  if (!Array.isArray(deny) || deny.some((d) => typeof d !== 'string')) {
    throw new KimiGovernanceError('guardrail permissions.deny is not a list of strings');
  }
  const names = new Set<string>();
  for (const entry of deny as string[]) {
    const m = entry.match(NAME_DENY_RE);
    if (!m) throw new KimiGovernanceError(`guardrail deny rule "${entry}" cannot be expressed in the OS sandbox`);
    names.add(m[1]);
  }
  return [...names];
}

// ── Spawn env ────────────────────────────────────────────────────────────────

/**
 * Env overrides for the kimi spawn (undefined = REMOVE from the child env).
 * The subscription login is the only credential kimi may use: a metered
 * KIMI_API_KEY (or Moonshot key) in the operator's env would silently bill the
 * wrong account, and ANTHROPIC_* belongs to the claude harness.
 */
export function kimiSpawnEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { KIMI_API_KEY: undefined, MOONSHOT_API_KEY: undefined };
  for (const key of Object.keys(source)) {
    if (key.startsWith('ANTHROPIC_')) env[key] = undefined;
  }
  return env;
}

// ── OS sandbox ───────────────────────────────────────────────────────────────

export interface KimiSandboxOptions {
  workDir: string;
  /** Extra writable dirs: git common dir (commits), memory dir. */
  writeDirs: string[];
  /** Basenames whose WRITE is denied anywhere (guardrail goals.md & co.). */
  denyWriteNames?: string[];
  /** Paths kept read-only even when under a writable root (host-trusted files). */
  denyWritePaths?: string[];
  denyRead?: string[];
  platform?: NodeJS.Platform;
  /** Injectable for tests. */
  hasCommand?: (cmd: string) => boolean;
  /** kimi's state root. Injectable for tests. */
  kimiHome?: string;
}

export interface KimiSandbox {
  command: string;
  args: string[];
  /** Seatbelt profile text to write to the file referenced by args (macOS). */
  profile?: string;
}

const sbplStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * What kimi itself writes — measured on kimi-code 2.2.0 under Seatbelt
 * (2026-10-19): per-session state, logs, caches, telemetry, file history, the
 * OAuth refresh (`credentials/`, `oauth/` — rewritten on every run; the lane
 * can already READ the token kimi needs, so write adds no exfiltration), and
 * two root files written atomically (temp file + rename in ~/.kimi-code).
 * NOT writable: `bin/` (the binary), `config.toml` (it declares hooks — an
 * escape), `tui.toml`, `server.token`, `updates/` (self-update staging; kimi
 * runs fine without it). If a live run shows kimi needs another path, add it
 * HERE — the failure is visible (kimi errors), never silent.
 */
function kimiStatePaths(home: string): { dirs: string[]; files: string[] } {
  return {
    dirs: ['sessions', 'logs', 'cache', 'telemetry', 'file-history', 'credentials', 'oauth'].map((d) => join(home, d)),
    files: ['session_index.jsonl', 'workspaces.json'].map((f) => join(home, f)),
  };
}

/**
 * SBPL regex for `<path>` plus an atomic-write temp suffix in the same dir
 * (`<path>.tmp-123`, …). Backslashes are not escapes in SBPL `#"..."`
 * literals, so every non-[A-Za-z0-9/_-] char becomes a bracket class.
 */
function atomicFileRegex(path: string): string {
  const body = [...path].map((c) => (/[A-Za-z0-9/_-]/.test(c) ? c : `[${c}]`)).join('');
  return `#"^${body}[^/]*$"`;
}

function writableRoots(opts: KimiSandboxOptions): string[] {
  const state = kimiStatePaths(opts.kimiHome ?? join(homedir(), '.kimi-code'));
  const roots = [opts.workDir, ...opts.writeDirs, ...state.dirs, tmpdir(), '/tmp', '/private/tmp', '/private/var/folders'];
  return [...new Set(roots.flatMap((r) => [r, realOrSame(r)]))];
}

/** Git control files inside writable git dirs stay read-only (hooks/config run outside the sandbox). */
function gitControlPaths(opts: KimiSandboxOptions): { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const d of opts.writeDirs) {
    if (!existsSync(join(d, 'HEAD')) || !existsSync(join(d, 'objects'))) continue;
    for (const r of new Set([d, realOrSame(d)])) {
      dirs.push(join(r, 'hooks'));
      files.push(join(r, 'config'), join(r, 'config.worktree'));
      // Worktree admin dirs: `commondir` / `gitdir` / `config.worktree` would
      // redirect harness git to a decoy common dir or inject config (#1311).
      // HEAD, index, logs stay writable — commits need them.
      let admins: string[] = [];
      try { admins = readdirSync(join(r, 'worktrees')); } catch { /* no linked worktrees */ }
      for (const a of admins) {
        for (const f of ['commondir', 'gitdir', 'config.worktree']) files.push(join(r, 'worktrees', a, f));
      }
    }
  }
  return { dirs, files };
}

/**
 * Case-insensitive end-anchored regex for a basename (macOS volumes are
 * case-insensitive). Emitted as an SBPL `#"..."` literal, where backslashes are
 * NOT string escapes (`\\.` matches a literal backslash — verified against real
 * Seatbelt), so `.` is a bracket class. Names are [A-Za-z0-9._-] only
 * (NAME_DENY_RE), so nothing else needs escaping.
 */
function nameRegex(name: string): string {
  const body = [...name].map((c) => (/[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c === '.' ? '[.]' : c)).join('');
  return `#"/${body}$"`;
}

/** Seatbelt profile: default-allow, writes confined to the lane, credential dirs unreadable. */
export function buildKimiSeatbeltProfile(opts: KimiSandboxOptions): string {
  const deny = (opts.denyRead ?? KIMI_DENY_READ).map(expandHome);
  const state = kimiStatePaths(opts.kimiHome ?? join(homedir(), '.kimi-code'));
  const git = gitControlPaths(opts);
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writableRoots(opts).map((r) => `(subpath ${sbplStr(r)})`).join(' ')})`,
    `(allow file-write* ${state.files.flatMap((f) => [...new Set([f, realOrSame(f)])]).map((f) => `(regex ${atomicFileRegex(f)})`).join(' ')})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/(tty|ttys|fd)[0-9]*$"))',
  ];
  // Last match wins in SBPL: denies come after the allows they carve out of.
  if (git.dirs.length > 0) {
    lines.push(`(deny file-write* ${[
      ...git.dirs.map((d) => `(subpath ${sbplStr(d)})`),
      ...git.files.map((f) => `(literal ${sbplStr(f)})`),
    ].join(' ')})`);
  }
  for (const p of opts.denyWritePaths ?? []) {
    for (const r of new Set([p, realOrSame(p)])) lines.push(`(deny file-write* (subpath ${sbplStr(r)}))`);
  }
  for (const name of opts.denyWriteNames ?? []) {
    lines.push(`(deny file-write* (regex ${nameRegex(name)}))`);
  }
  for (const d of deny) {
    for (const r of new Set([d, realOrSame(d)])) lines.push(`(deny file-read* (subpath ${sbplStr(r)}))`);
  }
  return lines.join('\n') + '\n';
}

/** bubblewrap argv prefix: read-only root, writable lane, credential dirs masked. */
export function buildKimiBwrapArgs(opts: KimiSandboxOptions): string[] {
  const args = ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc'];
  for (const r of writableRoots(opts)) {
    if (existsSync(r)) args.push('--bind', r, r);
  }
  // The session index is a single file: bind just it (its parent stays read-only).
  for (const f of kimiStatePaths(opts.kimiHome ?? join(homedir(), '.kimi-code')).files) {
    if (existsSync(f)) args.push('--bind', f, f);
  }
  const git = gitControlPaths(opts);
  for (const r of [...git.dirs, ...git.files]) {
    if (existsSync(r)) args.push('--ro-bind', r, r);
  }
  for (const p of opts.denyWritePaths ?? []) {
    if (existsSync(p)) args.push('--ro-bind', p, p);
  }
  args.push(...bwrapDenyReadArgs((opts.denyRead ?? KIMI_DENY_READ).map(expandHome)));
  args.push('--chdir', opts.workDir, '--');
  return args;
}

/**
 * The OS sandbox wrapper for this platform, or null when none is available
 * (caller decides: strict → refuse, otherwise warn loudly). Throws
 * KimiGovernanceError when write denies are required but the platform's
 * sandbox cannot express them (bwrap has no glob/regex rules).
 * `profilePath` is where the Seatbelt profile will be written.
 */
export function resolveKimiSandbox(opts: KimiSandboxOptions, profilePath: string): KimiSandbox | null {
  const platform = opts.platform ?? process.platform;
  const has = opts.hasCommand ?? defaultHasCommand;
  if (platform === 'darwin' && has('sandbox-exec')) {
    return { command: 'sandbox-exec', args: ['-f', profilePath], profile: buildKimiSeatbeltProfile(opts) };
  }
  if (platform === 'linux' && has('bwrap')) {
    if ((opts.denyWriteNames ?? []).length > 0) {
      throw new KimiGovernanceError(
        `guardrail denies writes to ${(opts.denyWriteNames ?? []).join(', ')} but bwrap cannot express path-name rules (macOS Seatbelt can)`,
      );
    }
    return { command: 'bwrap', args: buildKimiBwrapArgs(opts) };
  }
  return null;
}

function defaultHasCommand(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'pipe' }); return true; } catch { return false; }
}
