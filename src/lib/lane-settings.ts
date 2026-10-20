/**
 * Lane settings — which guardrail content a spawned Claude lane may inherit.
 *
 * Hooks are executed by the host, outside the OS sandbox, so they come ONLY
 * from the bundled guardrail. A project `.claude/guardrail.json` sits inside
 * the lane's write root and is untrusted: it can contribute permission deny
 * rules (restricting only), never hooks and never allow rules.
 */

import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  buildSandboxSettings, readGuardrailHooks, readGuardrailPermissions,
  trustedLaneDir, writeSandboxSettingsFile, sandboxEnabled, sandboxStrict,
} from './sandbox-settings.js';
import { findMemoryDir } from './memory.js';
import { mergeHooks } from './worktree-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bundled guardrail.json (dist/lib → dist/templates, or src/lib → templates). */
export function resolveBundledGuardrailSettings(): string | undefined {
  for (const rel of [['..', '..', 'templates'], ['..', 'templates']]) {
    const p = join(__dirname, ...rel, 'guardrail.json');
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface LaneGuardrail {
  hooks: Record<string, unknown> | undefined;
  permissions: { deny: unknown[] } | undefined;
}

export function resolveLaneGuardrail(projectRoot: string): LaneGuardrail {
  const bundled = resolveBundledGuardrailSettings();
  const bundledPerms = readGuardrailPermissions(bundled) as { deny?: unknown[] } | undefined;
  const projectPerms = readGuardrailPermissions(
    join(projectRoot, '.claude', 'guardrail.json'), { denyOnly: true },
  ) as { deny?: unknown[] } | undefined;
  const deny = [...(bundledPerms?.deny ?? []), ...(projectPerms?.deny ?? [])];
  return {
    hooks: readGuardrailHooks(bundled) as Record<string, unknown> | undefined,
    permissions: deny.length > 0 ? { deny: [...new Set(deny)] } : undefined,
  };
}

/** Write the settings file for a lane and return its path (for --settings). */
export function writeLaneSettings(cwd: string, extraHooks?: Record<string, unknown>): string {
  const guardrail = resolveLaneGuardrail(cwd);
  const hooks = mergeHooks(guardrail.hooks, extraHooks);
  const dir = trustedLaneDir();
  if (sandboxEnabled()) {
    const memDir = findMemoryDir();
    return writeSandboxSettingsFile(buildSandboxSettings({
      cwd,
      writeScope: memDir ? [memDir] : [],
      guardrailHooks: hooks,
      guardrailPermissions: guardrail.permissions,
      strict: sandboxStrict(),
    }), dir);
  }
  const settings: Record<string, unknown> = { hooks };
  if (guardrail.permissions) settings.permissions = guardrail.permissions;
  return writeSandboxSettingsFile(settings, dir);
}
