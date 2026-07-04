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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

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
    // Non-strict keeps Claude Code's escape hatch (retry unsandboxed → permission
    // flow) so a sandbox-incompatible command degrades gracefully instead of
    // failing the agent. Strict mode (no escape) is the eventual posture.
    allowUnsandboxedCommands: opts.strict ? false : true,
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

/** Write the merged settings to a temp file and return its path (for --settings). */
export function writeSandboxSettingsFile(settings: Record<string, unknown>, dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'squads-sandbox-settings.json');
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
