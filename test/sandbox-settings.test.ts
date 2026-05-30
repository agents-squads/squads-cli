import { describe, it, expect, afterEach } from 'vitest';
import {
  buildSandboxSettings, sandboxEnabled,
  DEFAULT_DENY_READ, DEFAULT_EXCLUDED_COMMANDS, DEFAULT_ALLOWED_DOMAINS,
} from '../src/lib/sandbox-settings.js';

interface SB {
  enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean;
  filesystem: { allowWrite: string[]; denyRead: string[] };
  network: { allowedDomains: string[] };
  allowManagedDomainsOnly: boolean; excludedCommands: string[];
}

describe('buildSandboxSettings', () => {
  it('enables the sandbox with FS + network isolation and our gotchas baked in', () => {
    const s = buildSandboxSettings({ cwd: '/work/proj' });
    const sb = s.sandbox as unknown as SB;
    expect(sb.enabled).toBe(true);
    expect(sb.filesystem.allowWrite).toContain('/work/proj');
    expect(sb.filesystem.denyRead).toEqual(DEFAULT_DENY_READ);
    expect(sb.filesystem.denyRead).toContain('~/.ssh');
    expect(sb.network.allowedDomains).toEqual(DEFAULT_ALLOWED_DOMAINS);
    expect(sb.allowManagedDomainsOnly).toBe(true);
    // gh/gcloud/docker fail under Seatbelt → excluded
    expect(sb.excludedCommands).toEqual(DEFAULT_EXCLUDED_COMMANDS);
    expect(sb.excludedCommands).toContain('gh *');
  });

  it('adds the contract write_scope to allowWrite', () => {
    const sb = buildSandboxSettings({ cwd: '/w', writeScope: ['/w/.agents/memory'] }).sandbox as unknown as SB;
    expect(sb.filesystem.allowWrite).toEqual(['/w', '/w/.agents/memory']);
  });

  it('non-strict keeps the escape hatch; strict removes it', () => {
    const lax = buildSandboxSettings({ cwd: '/w' }).sandbox as unknown as SB;
    expect(lax.failIfUnavailable).toBe(false);
    expect(lax.allowUnsandboxedCommands).toBe(true);
    const strict = buildSandboxSettings({ cwd: '/w', strict: true }).sandbox as unknown as SB;
    expect(strict.failIfUnavailable).toBe(true);
    expect(strict.allowUnsandboxedCommands).toBe(false);
  });

  it('merges guardrail hooks under "hooks"', () => {
    const hooks = { PreToolUse: [{ matcher: 'Bash' }] };
    expect(buildSandboxSettings({ cwd: '/w', guardrailHooks: hooks }).hooks).toEqual(hooks);
    expect(buildSandboxSettings({ cwd: '/w' }).hooks).toBeUndefined();
  });

  it('overrides: custom allowedDomains/excludedCommands/denyRead win', () => {
    const sb = buildSandboxSettings({
      cwd: '/w', allowedDomains: ['x.com'], excludedCommands: ['foo *'], denyRead: ['~/secret'],
    }).sandbox as unknown as SB;
    expect(sb.network.allowedDomains).toEqual(['x.com']);
    expect(sb.excludedCommands).toEqual(['foo *']);
    expect(sb.filesystem.denyRead).toEqual(['~/secret']);
  });
});

describe('sandboxEnabled', () => {
  const prev = process.env.SQUADS_SANDBOX;
  afterEach(() => { if (prev === undefined) delete process.env.SQUADS_SANDBOX; else process.env.SQUADS_SANDBOX = prev; });
  it('reads SQUADS_SANDBOX=1', () => {
    process.env.SQUADS_SANDBOX = '1'; expect(sandboxEnabled()).toBe(true);
    process.env.SQUADS_SANDBOX = '0'; expect(sandboxEnabled()).toBe(false);
    delete process.env.SQUADS_SANDBOX; expect(sandboxEnabled()).toBe(false);
  });
});
