/**
 * Sandbox settings — configure Claude Code's BUILT-IN OS sandbox for spawned
 * agents (P2 of chief-cli-runtime, hq#418 / squads-cli#780).
 *
 * Decision (2026-05-30, after research): do NOT hand-roll Seatbelt/bubblewrap
 * profiles or a proxy. Claude Code (which our agents already run on) ships an OS
 * sandbox — Seatbelt(macOS)/bubblewrap(Linux) filesystem isolation + a default-
 * deny network proxy with a domain allowlist — and Anthropic OSS'd it as
 * `@anthropic-ai/sandbox-runtime`. We just feed it settings (merged with the
 * existing guardrail PreToolUse hooks) via the spawn's `--settings` flag.
 *
 * DEFAULT ON since P2 default-on (#780): agents run sandboxed unless
 * `SQUADS_SANDBOX=0` (explicit opt-out — CI images without Seatbelt/bubblewrap,
 * debugging). `SQUADS_SANDBOX_STRICT=1` additionally hard-fails when the
 * sandbox is unavailable and removes the unsandboxed-retry escape hatch.
 *
 * Gotchas baked in (from Anthropic's docs): `gh`/`gcloud`/`terraform` (Go TLS)
 * and `docker` are incompatible with Seatbelt → `excludedCommands` (run outside
 * the sandbox); default read still exposes `~/.ssh`/`~/.aws` → `denyRead` them.
 * Network egress allowlisting that BLOCKS (vs prompts) headless agents needs
 * managed settings — tracked for the real-run smoke.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { tmpdir } from 'os';

export interface SandboxSettingsOptions {
  /** Worktree/project root — the agent's write root. */
  cwd: string;
  /** Extra writable paths (the contract's write_scope, e.g. memory dir). */
  writeScope?: string[];
  /** Network allowlist (defaults to our known hosts). */
  allowedDomains?: string[];
  /** Commands that must run OUTSIDE the sandbox (Seatbelt-incompatible). */
  excludedCommands?: string[];
  /** Paths whose READ is denied even though default read is broad. */
  denyRead?: string[];
  /** Existing guardrail PreToolUse hooks to merge in (the denylist). */
  guardrailHooks?: unknown;
  /** Existing guardrail permissions (governance deny rules) to carry through. */
  guardrailPermissions?: unknown;
  /** Strict = hard-fail if sandbox unavailable + no unsandboxed escape hatch. */
  strict?: boolean;
}

export const DEFAULT_ALLOWED_DOMAINS = [
  'api.anthropic.com', 'api.openai.com',
  'github.com', '*.github.com', 'codeload.github.com', 'objects.githubusercontent.com',
  'registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org',
  '*.googleapis.com',
];

// Go-TLS tools fail under Seatbelt; docker is incompatible. Run them unsandboxed.
// Matching (Claude Code sandboxing docs): entries use Bash(...) rule syntax, so
// `gh *` matches `gh api rate_limit`; but EVERY command in a call must match —
// `gh pr view 1 | jq .`, `cd x && gh ...`, `gh ... > f`, `$(...)` stay sandboxed.
// Lanes must issue gh as a standalone call.
export const DEFAULT_EXCLUDED_COMMANDS = ['gh *', 'gcloud *', 'terraform *', 'docker *'];

// Default read is the whole machine minus these — credential dirs must be denied.
export const DEFAULT_DENY_READ = ['~/.ssh', '~/.aws', '~/.config/gcloud'];

/** Build the Claude Code settings object (sandbox + merged guardrail hooks). */
export function buildSandboxSettings(opts: SandboxSettingsOptions): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (opts.guardrailHooks) settings.hooks = opts.guardrailHooks;
  // Carry the governance deny rules through the sandbox path too — otherwise
  // enabling SQUADS_SANDBOX would silently drop them (the file is rebuilt here,
  // not passed verbatim like the non-sandbox --settings path).
  if (opts.guardrailPermissions) settings.permissions = opts.guardrailPermissions;
  settings.sandbox = {
    enabled: true,
    failIfUnavailable: opts.strict ?? false,
    // Never let a lane retry a command with `dangerouslyDisableSandbox` (#1337).
    // With the hatch open, a lane whose `gh ... | jq` call stayed sandboxed
    // (every command in a call must match excludedCommands) retried unsandboxed,
    // and a matching allow rule such as Bash(gh:*) approved it with no prompt —
    // the sandbox stopped containing exactly the lanes that touch the network.
    // excludedCommands is unaffected: it is the sanctioned, narrow way out. A
    // sandbox-incompatible command now fails loudly in the lane instead.
    // `strict` governs only failIfUnavailable (CI images without Seatbelt).
    allowUnsandboxedCommands: false,
    filesystem: {
      allowWrite: [opts.cwd, ...(opts.writeScope ?? [])],
      denyRead: opts.denyRead ?? DEFAULT_DENY_READ,
    },
    network: { allowedDomains: opts.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS },
    // Block (not prompt) non-allowed domains for headless agents. NOTE: only
    // honored in *managed* settings — verify/parameterize in the real-run smoke.
    allowManagedDomainsOnly: true,
    excludedCommands: opts.excludedCommands ?? DEFAULT_EXCLUDED_COMMANDS,
  };
  return settings;
}

/** Read the PreToolUse hooks out of a guardrail settings file, if any. */
export function readGuardrailHooks(guardrailPath: string | undefined): unknown {
  if (!guardrailPath) return undefined;
  try {
    if (!existsSync(guardrailPath)) return undefined;
    const json = JSON.parse(readFileSync(guardrailPath, 'utf-8')) as { hooks?: unknown };
    return json.hooks;
  } catch {
    return undefined;
  }
}

/** Read the permissions (governance deny rules) out of a guardrail settings file, if any. */
export function readGuardrailPermissions(guardrailPath: string | undefined): unknown {
  if (!guardrailPath) return undefined;
  try {
    if (!existsSync(guardrailPath)) return undefined;
    const json = JSON.parse(readFileSync(guardrailPath, 'utf-8')) as { permissions?: unknown };
    return json.permissions;
  } catch {
    return undefined;
  }
}

/**
 * Write the merged settings to a temp file and return its path (for --settings).
 *
 * Callers pass `<repoRoot>/.git` so the file never dirties the working tree.
 * In a LINKED WORKTREE `.git` is a file (a `gitdir:` pointer), not a directory —
 * mkdir on it throws EEXIST and killed every conversation-mode run (#931).
 * Follow the pointer to the real per-worktree git dir; on any failure fall
 * back to a tmpdir rather than take the spawn down.
 */
export function resolveSettingsDir(dir: string): string {
  try {
    let target = dir;
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      const pointer = readFileSync(dir, 'utf-8').match(/^gitdir:\s*(.+)\s*$/m);
      if (!pointer) throw new Error(`${dir} exists but is not a directory or gitdir pointer`);
      const gitDir = pointer[1].trim();
      target = isAbsolute(gitDir) ? gitDir : join(dirname(dir), gitDir);
    }
    mkdirSync(target, { recursive: true });
    return target;
  } catch {
    return mkdtempSync(join(tmpdir(), 'squads-sandbox-'));
  }
}

export function writeSandboxSettingsFile(settings: Record<string, unknown>, dir: string): string {
  const target = resolveSettingsDir(dir);
  const path = join(target, 'squads-sandbox-settings.json');
  writeFileSync(path, JSON.stringify(settings, null, 2));
  return path;
}

/**
 * Whether spawns run inside the OS sandbox. DEFAULT ON (#780 — P2 default-on);
 * `SQUADS_SANDBOX=0` is the explicit opt-out for environments without
 * Seatbelt/bubblewrap or when debugging agent behavior.
 */
export function sandboxEnabled(): boolean {
  return process.env.SQUADS_SANDBOX !== '0';
}

/** Strict posture: hard-fail if the sandbox is unavailable, no unsandboxed retry. */
export function sandboxStrict(): boolean {
  return process.env.SQUADS_SANDBOX_STRICT === '1';
}
