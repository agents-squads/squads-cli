/**
 * Governance parity for the opencode harness (cli#1306).
 *
 * The Claude path gives every run a governed surface: `--allowedTools` compiled
 * from the agent contract (#920), guardrail PreToolUse hooks, the worktree guard
 * (#1166/#1153) and the OS sandbox (#780). The opencode path used to spawn
 * `opencode run --auto`, which approves every permission and applied none of
 * them. This module is the equivalent surface for opencode:
 *
 *  - `compileOpencodePermission()` maps the contract's tool grants, the
 *    guardrail deny rules and the worktree guard to an opencode `permission`
 *    config. Default is deny; opencode evaluates rules last-match-wins, so
 *    every allow is emitted BEFORE the denies that carve out of it.
 *  - `resolveOpencodeSandbox()` wraps the spawn in the OS sandbox: macOS
 *    `sandbox-exec` (Seatbelt) or Linux `bwrap`.
 *
 * FAIL CLOSED: a grant or deny rule that cannot be expressed throws
 * `OpencodeGovernanceError`; the caller refuses the run. Nothing here, or in
 * the caller, ever falls back to `--auto`.
 */

import { existsSync, realpathSync, writeFileSync, readdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

export class OpencodeGovernanceError extends Error {
  constructor(message: string) {
    super(`opencode governance: ${message} — refusing the run rather than falling back to --auto (cli#1306)`);
    this.name = 'OpencodeGovernanceError';
  }
}

type Rule = 'allow' | 'deny';
type Rules = Rule | Record<string, Rule>;

export interface OpencodePermissionConfig {
  $schema: string;
  permission: Record<string, Rules>;
}

export interface OpencodePermissionInput {
  /** Compiled tool allowlist (compileAllowedTools output). */
  tools: string[];
  /** `permissions` object of the guardrail settings file (governance deny rules). */
  guardrailPermissions?: unknown;
  /** The primary checkout the worktree guard protects. */
  primaryRoot: string;
  /** The lane's cwd. When it IS the primary root the worktree guard disarms (as on Claude). */
  workDir: string;
  /** Memory dir — writable from the lane. */
  memoryDir?: string;
  /** Credential dirs whose READ is denied. */
  denyRead?: string[];
}

/** Credential dirs denied for read. Superset of the Claude sandbox's DEFAULT_DENY_READ. */
export const OPENCODE_DENY_READ = [
  '~/.ssh', '~/.aws', '~/.config/gcloud', '~/.gnupg', '~/.config/gh', '~/.squads/secrets',
];

/**
 * Destructive-command denies — the opencode form of the guardrail PreToolUse
 * hook (templates/guardrail.json). Glob approximation of a shlex parser: see
 * the PR for the documented gap; the OS sandbox is the backstop for filesystem
 * damage (nothing outside the worktree is writable).
 */
export const OPENCODE_BASH_DENY = [
  'git push --force*', 'git push -f*', 'git push *--force*', 'git push * -f*',
  'git reset --hard*', 'git reset *--hard*',
  'git clean -f*', 'git clean *-f*', 'git clean *--force*',
  'npm publish*', 'yarn publish*', 'pnpm publish*',
  'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf ~/*', 'rm -rf $HOME*',
  'rm -fr /', 'rm -fr /*', 'rm -fr ~', 'rm -fr ~/*', 'rm -fr $HOME*',
  'sudo *',
];

const GIT_READ_VERBS = ['log', 'show', 'diff', 'status', 'branch', 'ls-files', 'fetch', 'rev-parse', 'describe', 'worktree list'];

const WRITE_GRANTS = new Set(['Write', 'Edit', 'NotebookEdit']);
const SIMPLE_GRANTS: Record<string, string[]> = {
  Read: ['read'],
  Grep: ['grep'],
  Glob: ['glob', 'list'],
  WebFetch: ['webfetch'],
  WebSearch: ['websearch'],
  Agent: ['task'],
  Task: ['task'],
  TodoWrite: ['todowrite'],
};

const expandHome = (p: string): string => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/** `Bash(git status:*)` → `git status`; null when the grant isn't a scoped bash grant. */
function bashPrefix(tool: string): { cmd: string; prefix: boolean } | null {
  const m = tool.match(/^Bash\((.+?)(:\*)?\)$/);
  return m ? { cmd: m[1], prefix: Boolean(m[2]) } : null;
}

/**
 * Contract grants + guardrail + worktree guard → opencode permission config.
 * Throws OpencodeGovernanceError for anything that cannot be expressed.
 */
export function compileOpencodePermission(input: OpencodePermissionInput): OpencodePermissionConfig {
  const perm: Record<string, Rules> = { '*': 'deny' };
  const bashAllow: Record<string, Rule> = {};
  let bashAll = false;
  const grantedWrite = new Set<string>();

  for (const raw of input.tools) {
    const tool = raw.trim();
    if (WRITE_GRANTS.has(tool)) { grantedWrite.add(tool); continue; }
    if (SIMPLE_GRANTS[tool]) {
      for (const k of SIMPLE_GRANTS[tool]) perm[k] = 'allow';
      continue;
    }
    if (tool === 'Bash') { bashAll = true; continue; }
    const scoped = bashPrefix(tool);
    if (scoped) {
      bashAllow[scoped.cmd] = 'allow';
      if (scoped.prefix) bashAllow[`${scoped.cmd} *`] = 'allow';
      continue;
    }
    // MCP grants (mcp__server__tool): opencode names MCP tools differently and
    // squads passes it no MCP config, so the grant could never be honoured.
    throw new OpencodeGovernanceError(`tool grant "${tool}" has no opencode equivalent`);
  }

  // opencode has ONE `edit` permission covering edit/write/patch. A contract
  // granting only half of that pair would be silently widened — refuse.
  if (grantedWrite.size > 0) {
    if (!(grantedWrite.has('Write') && grantedWrite.has('Edit'))) {
      throw new OpencodeGovernanceError(
        `contract grants ${[...grantedWrite].join('+')} but opencode's single "edit" permission covers both Write and Edit (grant both or neither)`,
      );
    }
  }

  // ── edit: guardrail denies + worktree guard ──
  const guardArmed = realOrSame(input.workDir) !== realOrSame(input.primaryRoot);
  const editRules: Record<string, Rule> = {};
  const readRules: Record<string, Rule> = {};
  const bashDeny: string[] = [];
  const denyEntries = guardrailDenyList(input.guardrailPermissions);
  for (const entry of denyEntries) {
    const m = entry.match(/^(Edit|Write|Read|Bash)\((.+)\)$/);
    if (!m) throw new OpencodeGovernanceError(`guardrail deny rule "${entry}" cannot be expressed`);
    const [, kind, arg] = m;
    if (kind === 'Edit' || kind === 'Write') editRules[expandHome(arg)] = 'deny';
    else if (kind === 'Read') readRules[expandHome(arg)] = 'deny';
    else if (arg.endsWith(':*')) bashDeny.push(arg.slice(0, -2), `${arg.slice(0, -2)} *`);
    else bashDeny.push(arg);
  }

  const primary = input.primaryRoot.replace(/\/+$/, '');
  if (guardArmed) {
    // Worktree guard (#1166): mutations aimed at the primary checkout are blocked;
    // <primary>/.agents/** stays writable (lane logs, memory, observability).
    editRules[`${primary}/**`] = 'deny';
    editRules[`${primary}/.agents/**`] = 'allow';
    bashDeny.push(`cd ${primary}*`, `*> ${primary}/*`, `*>> ${primary}/*`, `git -C ${primary} *`);
  }

  if (grantedWrite.size > 0) perm.edit = { '*': 'allow', ...editRules };
  const denyRead = (input.denyRead ?? OPENCODE_DENY_READ).map(expandHome);
  if (perm.read === 'allow') {
    const rules: Record<string, Rule> = { '*': 'allow', ...readRules };
    for (const d of denyRead) { rules[d] = 'deny'; rules[`${d}/**`] = 'deny'; }
    perm.read = rules;
  }

  // ── bash: allows first, then denies (last match wins) ──
  if (bashAll || Object.keys(bashAllow).length > 0) {
    const rules: Record<string, Rule> = bashAll ? { '*': 'allow' } : { '*': 'deny' };
    Object.assign(rules, bashAllow);
    for (const d of OPENCODE_BASH_DENY) rules[d] = 'deny';
    for (const d of bashDeny) rules[d] = 'deny';
    if (guardArmed) {
      // Reads against the primary checkout and its .agents subtree stay allowed (guard parity).
      for (const v of GIT_READ_VERBS) rules[`git -C ${primary} ${v}*`] = 'allow';
      for (const p of [`cd ${primary}/.agents*`, `*> ${primary}/.agents/*`, `*>> ${primary}/.agents/*`]) rules[p] = 'allow';
    }
    perm.bash = rules;
  }

  // Paths outside the lane's cwd: denied except memory and the primary .agents.
  const external: Record<string, Rule> = { '*': 'deny' };
  if (input.memoryDir) external[`${input.memoryDir}/**`] = 'allow';
  external[`${primary}/.agents/**`] = 'allow';
  perm.external_directory = external;

  return { $schema: 'https://opencode.ai/config.json', permission: perm };
}

function guardrailDenyList(permissions: unknown): string[] {
  if (!permissions || typeof permissions !== 'object') return [];
  const deny = (permissions as { deny?: unknown }).deny;
  if (deny === undefined) return [];
  if (!Array.isArray(deny) || deny.some((d) => typeof d !== 'string')) {
    throw new OpencodeGovernanceError('guardrail permissions.deny is not a list of strings');
  }
  return deny as string[];
}

function realOrSame(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

/** Write the per-spawn config next to the other per-spawn settings; returns its path. */
export function writeOpencodeConfig(config: OpencodePermissionConfig, dir: string): string {
  const path = join(dir, `opencode-governance-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

/**
 * Env that makes the config win. OPENCODE_CONFIG_CONTENT sits above global and
 * project config (a worktree-local opencode.json cannot weaken it).
 */
export function opencodeConfigEnv(config: OpencodePermissionConfig): Record<string, string> {
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: '1' };
}

// ── OS sandbox ───────────────────────────────────────────────────────────────

export interface OpencodeSandboxOptions {
  workDir: string;
  /** Extra writable dirs: git common dir (commits), memory dir. */
  writeDirs: string[];
  denyRead?: string[];
  platform?: NodeJS.Platform;
  /** Injectable for tests. */
  hasCommand?: (cmd: string) => boolean;
}

export interface OpencodeSandbox {
  /** Prefix: spawn `command` with `[...args, <opencode argv>]`. */
  command: string;
  args: string[];
  /** Seatbelt profile text to write to a file referenced by args (macOS). */
  profile?: string;
}

const sbplStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Dirs opencode itself must write (session db, logs, cache). NOT writable:
 * `~/.opencode` (the binary) and `~/.config/opencode` (global config +
 * plugins) — a lane able to write either could plant code that later runs
 * OUTSIDE the sandbox, in the user's interactive opencode. Self-update is
 * disabled per spawn (opencodeConfigEnv) so nothing needs to write the binary.
 */
function opencodeStateDirs(): string[] {
  const h = homedir();
  return [
    join(h, '.local', 'share', 'opencode'), join(h, '.local', 'state', 'opencode'),
    join(h, '.cache', 'opencode'),
  ];
}

function writableRoots(opts: OpencodeSandboxOptions): string[] {
  const roots = [opts.workDir, ...opts.writeDirs, ...opencodeStateDirs(), tmpdir(), '/tmp', '/private/tmp', '/private/var/folders'];
  return [...new Set(roots.flatMap((r) => [r, realOrSame(r)]))];
}

/**
 * Git control files inside writable git dirs that must stay read-only: a lane
 * writing `hooks/` or `config` (core.hooksPath, core.fsmonitor, filters) gets
 * code executed OUTSIDE the sandbox the next time anyone runs git there —
 * harvest, the user. Commits only need objects/refs/logs/worktrees.
 */
function gitControlPaths(opts: OpencodeSandboxOptions): { dirs: string[]; files: string[] } {
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

/** Seatbelt profile: default-allow, writes confined to the lane, credential dirs unreadable. */
export function buildSeatbeltProfile(opts: OpencodeSandboxOptions): string {
  const deny = (opts.denyRead ?? OPENCODE_DENY_READ).map(expandHome);
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writableRoots(opts).map((r) => `(subpath ${sbplStr(r)})`).join(' ')})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/(tty|ttys|fd)[0-9]*$"))',
    ...gitControlDenies(opts),
    ...deny.flatMap((d) => [...new Set([d, realOrSame(d)])].map((r) => `(deny file-read* (subpath ${sbplStr(r)}))`)),
  ];
  return lines.join('\n') + '\n';
}

/** Last match wins in SBPL: these come after the writable-roots allow. */
function gitControlDenies(opts: OpencodeSandboxOptions): string[] {
  const { dirs, files } = gitControlPaths(opts);
  if (dirs.length === 0) return [];
  return [`(deny file-write* ${[
    ...dirs.map((d) => `(subpath ${sbplStr(d)})`),
    ...files.map((f) => `(literal ${sbplStr(f)})`),
  ].join(' ')})`];
}

/** bubblewrap argv prefix: read-only root, writable lane, credential dirs masked. */
export function buildBwrapArgs(opts: OpencodeSandboxOptions): string[] {
  const args = ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc'];
  for (const r of writableRoots(opts)) {
    if (existsSync(r)) args.push('--bind', r, r);
  }
  // Later mounts win: re-bind git control files read-only over the writable git dir.
  const git = gitControlPaths(opts);
  for (const r of [...git.dirs, ...git.files]) {
    if (existsSync(r)) args.push('--ro-bind', r, r);
  }
  for (const d of (opts.denyRead ?? OPENCODE_DENY_READ).map(expandHome)) {
    if (existsSync(d)) args.push('--tmpfs', d);
  }
  args.push('--chdir', opts.workDir, '--');
  return args;
}

/**
 * The OS sandbox wrapper for this platform, or null when none is available
 * (caller decides: strict → refuse, otherwise warn loudly).
 * `profilePath` is where the Seatbelt profile will be written.
 */
export function resolveOpencodeSandbox(opts: OpencodeSandboxOptions, profilePath: string): OpencodeSandbox | null {
  const platform = opts.platform ?? process.platform;
  const has = opts.hasCommand ?? defaultHasCommand;
  if (platform === 'darwin' && has('sandbox-exec')) {
    return { command: 'sandbox-exec', args: ['-f', profilePath], profile: buildSeatbeltProfile(opts) };
  }
  if (platform === 'linux' && has('bwrap')) {
    return { command: 'bwrap', args: buildBwrapArgs(opts) };
  }
  return null;
}

function defaultHasCommand(cmd: string): boolean {
  try { execSync(`command -v ${cmd}`, { stdio: 'pipe' }); return true; } catch { return false; }
}
