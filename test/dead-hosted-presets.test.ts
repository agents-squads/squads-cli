/**
 * Integrations must be configurable, optional and free of one company's hosts:
 * no hosted presets, no dead "coming soon" copy, no email capture that goes nowhere.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const mockSwitchEnv = vi.fn();
vi.mock('../src/lib/env-config.js', async (orig) => {
  const actual = await orig<typeof import('../src/lib/env-config.js')>();
  return { ...actual, switchEnv: (...a: unknown[]) => mockSwitchEnv(...a) };
});

vi.mock('../src/lib/auth.js', async (orig) => {
  const actual = await orig<typeof import('../src/lib/auth.js')>();
  return { ...actual, loadSession: () => null };
});

const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8');

describe('config use — removed presets', () => {
  afterEach(() => { process.exitCode = undefined; vi.restoreAllMocks(); });

  it('prints the error and sets a non-zero exit code instead of throwing', async () => {
    mockSwitchEnv.mockImplementation(() => { throw new Error('The "prod" environment preset was removed. Set SQUADS_API_URL'); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { configUseCommand } = await import('../src/commands/config.js');
    await expect(configUseCommand('prod')).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('SQUADS_API_URL'));
    expect(process.exitCode).toBe(1);
  });
});

describe('login — unreachable auth endpoint', () => {
  const saved = process.env.SQUADS_AUTH_URL;
  beforeEach(() => { process.exitCode = undefined; });
  afterEach(() => {
    process.exitCode = undefined;
    if (saved === undefined) delete process.env.SQUADS_AUTH_URL; else process.env.SQUADS_AUTH_URL = saved;
    vi.restoreAllMocks();
  });

  it('names the configured URL, exits non-zero, and has no waitlist/email copy', async () => {
    process.env.SQUADS_AUTH_URL = 'http://127.0.0.1:1/auth';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out.push(String(s)); return true; });
    const { loginCommand } = await import('../src/commands/login.js');
    await loginCommand();
    const text = out.join('\n');
    expect(text).toContain('Auth endpoint unreachable: http://127.0.0.1:1/auth');
    expect(text).not.toMatch(/waitlist|Coming Soon|agents-squads\.com/i);
    expect(process.exitCode).toBe(1);
    vi.unstubAllGlobals();
  });
});

describe('source hygiene — no hosted hosts or dead copy', () => {
  it('env-config ships no hosted presets and no email storage', () => {
    const s = read('src/lib/env-config.ts');
    expect(s).not.toMatch(/console-staging|execution: 'cloud'/);
    expect(s).not.toMatch(/saveEmail|getEmail/);
  });
  it('init no longer captures an email nobody reads', () => {
    const s = read('src/commands/init.ts');
    expect(s).not.toMatch(/saveEmail|will reach out/);
  });
  it('login/deploy/cloud-dispatch carry no company email, waitlist or staging hint', () => {
    for (const f of ['src/commands/login.ts', 'src/commands/deploy.ts', 'src/lib/cloud-dispatch.ts']) {
      expect(read(f), f).not.toMatch(/hello@agents-squads\.com|waitlist|config use staging/);
    }
  });
  it('docs do not advertise staging/prod presets', () => {
    for (const f of ['docs/commands.md', 'templates/seed/skills/squads-cli/references/commands.md']) {
      expect(read(f), f).not.toMatch(/local, staging, prod/);
    }
  });
});
