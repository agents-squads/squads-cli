/**
 * API-backed commands read the URL when they run, not when the module loads,
 * and stop with the variable to set when there is none — no request to a
 * relative "/path".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../src/lib/auth.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/auth.js')>()),
  loadSession: () => ({ email: 'a@b.c', status: 'active', accessToken: 't' }),
}));
vi.mock('../src/lib/telemetry.js', () => ({ track: vi.fn().mockResolvedValue(undefined), Events: {} }));

const URL_VARS = ['SQUADS_API_URL', 'SQUADS_PLATFORM_URL', 'SQUADS_SCHEDULER_URL', 'SQUADS_ENV'] as const;
const saved: Record<string, string | undefined> = {};
const savedHome = process.env.HOME;
let home: string;
let fetchMock: ReturnType<typeof vi.fn>;
let errors: string[];

beforeEach(() => {
  for (const v of URL_VARS) { saved[v] = process.env[v]; delete process.env[v]; }
  // Empty HOME: no ~/.squads/config.json, so the built-in local env (no URL) applies.
  home = mkdtempSync(join(tmpdir(), 'squads-apiurl-'));
  process.env.HOME = home;
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => '' }));
  vi.stubGlobal('fetch', fetchMock);
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  process.exitCode = undefined;
});

afterEach(() => {
  for (const v of URL_VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function run(register: (p: Command) => void, argv: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  register(program);
  await program.parseAsync(['node', 'squads', ...argv]);
}

describe('squads trigger', () => {
  it('uses SQUADS_API_URL set after the module was imported', async () => {
    const { registerTriggerCommand } = await import('../src/commands/trigger.js');
    process.env.SQUADS_API_URL = 'https://api.example.test';
    await run(registerTriggerCommand, ['trigger', 'list']);
    expect(fetchMock).toHaveBeenCalled();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.example\.test\//);
  });

  it('stops with the variable name when no API is configured', async () => {
    const { registerTriggerCommand } = await import('../src/commands/trigger.js');
    await run(registerTriggerCommand, ['trigger', 'status']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('SQUADS_API_URL');
    expect(process.exitCode).toBe(1);
  });
});

describe('squads approval', () => {
  it('uses SQUADS_API_URL set after the module was imported', async () => {
    const { registerApprovalCommand } = await import('../src/commands/approval.js');
    process.env.SQUADS_API_URL = 'https://api.example.test';
    await run(registerApprovalCommand, ['approval', 'list']);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.example\.test\/approvals/);
  });

  it('stops with the variable name when no API is configured', async () => {
    const { registerApprovalCommand } = await import('../src/commands/approval.js');
    await run(registerApprovalCommand, ['approval', 'check', 'a1']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('SQUADS_API_URL');
    expect(process.exitCode).toBe(1);
  });
});

describe('squads deploy', () => {
  it('status uses SQUADS_API_URL set after import', async () => {
    const { deployStatusCommand } = await import('../src/commands/deploy.js');
    process.env.SQUADS_API_URL = 'https://api.example.test';
    await deployStatusCommand();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/api\.example\.test\/triggers/);
  });

  it('status and pull stop with the variable name when no API is configured', async () => {
    const { deployStatusCommand, deployPullCommand } = await import('../src/commands/deploy.js');
    await deployStatusCommand();
    await deployPullCommand({});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errors.filter(e => e.includes('SQUADS_API_URL'))).toHaveLength(2);
    expect(process.exitCode).toBe(1);
  });
});
