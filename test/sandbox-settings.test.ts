import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildSandboxSettings, sandboxEnabled, readGuardrailHooks, readGuardrailPermissions, writeSandboxSettingsFile,
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

  it('carries guardrail permissions through (governance deny rules survive the sandbox path)', () => {
    const permissions = { deny: ['Edit(goals.md)', 'Write(directives.md)'] };
    expect(buildSandboxSettings({ cwd: '/w', guardrailPermissions: permissions }).permissions).toEqual(permissions);
    expect(buildSandboxSettings({ cwd: '/w' }).permissions).toBeUndefined();
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

describe('file I/O (the path the ESM-require bug broke at runtime)', () => {
  it('writeSandboxSettingsFile writes valid JSON and returns its path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-'));
    const settings = buildSandboxSettings({ cwd: '/w' });
    const path = writeSandboxSettingsFile(settings, dir);
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    expect((parsed.sandbox as { enabled: boolean }).enabled).toBe(true);
  });

  it('readGuardrailHooks pulls .hooks out of a settings file (and is safe on missing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gr-'));
    const p = join(dir, 'guardrail.json');
    writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash' }] } }));
    expect(readGuardrailHooks(p)).toEqual({ PreToolUse: [{ matcher: 'Bash' }] });
    expect(readGuardrailHooks(join(dir, 'nope.json'))).toBeUndefined();
    expect(readGuardrailHooks(undefined)).toBeUndefined();
  });

  it('readGuardrailPermissions pulls .permissions out of a settings file (and is safe on missing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gp-'));
    const p = join(dir, 'guardrail.json');
    writeFileSync(p, JSON.stringify({ permissions: { deny: ['Edit(goals.md)'] } }));
    expect(readGuardrailPermissions(p)).toEqual({ deny: ['Edit(goals.md)'] });
    expect(readGuardrailPermissions(join(dir, 'nope.json'))).toBeUndefined();
    expect(readGuardrailPermissions(undefined)).toBeUndefined();
  });
});

describe('sandboxEnabled', () => {
  const prev = process.env.SQUADS_SANDBOX;
  afterEach(() => { if (prev === undefined) delete process.env.SQUADS_SANDBOX; else process.env.SQUADS_SANDBOX = prev; });
  it('defaults ON; SQUADS_SANDBOX=0 is the explicit opt-out (#780 default-on)', () => {
    process.env.SQUADS_SANDBOX = '1'; expect(sandboxEnabled()).toBe(true);
    process.env.SQUADS_SANDBOX = '0'; expect(sandboxEnabled()).toBe(false);
    delete process.env.SQUADS_SANDBOX; expect(sandboxEnabled()).toBe(true);
  });
});
