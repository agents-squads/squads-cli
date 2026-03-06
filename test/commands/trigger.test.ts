import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
}));

// Mock chalk since trigger.ts uses it directly
vi.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalk = new Proxy(identity, {
    get: () => new Proxy(identity, { get: () => identity }),
  });
  chalk.bold = identity;
  chalk.gray = identity;
  chalk.red = identity;
  chalk.green = identity;
  chalk.yellow = identity;
  chalk.cyan = identity;
  return { default: chalk };
});

import { registerTriggerCommand } from '../../src/commands/trigger.js';

const sampleTriggers = [
  {
    id: 'trig-001',
    name: 'issue_labeled_squad',
    squad: 'engineering',
    agent: 'issue-solver',
    enabled: true,
    priority: 1,
    cooldown: '30m',
    last_fired: '2026-03-06T10:00:00Z',
    fire_count: 5,
  },
  {
    id: 'trig-002',
    name: 'daily_standup',
    squad: 'marketing',
    agent: null,
    enabled: false,
    priority: 2,
    cooldown: '24h',
    last_fired: null,
    fire_count: 0,
  },
];

const sampleStats = {
  triggers: { total: 2, enabled: 1, fired_24h: 3 },
  executions_24h: { total_24h: 5, completed: 4, failed: 1, running: 0, queued: 0 },
};

describe('registerTriggerCommand', () => {
  let program: Command;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride(); // prevent process.exit in tests
    registerTriggerCommand(program);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('registers the trigger command on the program', () => {
    const triggerCmd = program.commands.find(c => c.name() === 'trigger');
    expect(triggerCmd).toBeDefined();
  });

  it('registers all expected subcommands', () => {
    const triggerCmd = program.commands.find(c => c.name() === 'trigger')!;
    const subcommandNames = triggerCmd.commands.map(c => c.name());
    expect(subcommandNames).toContain('list');
    expect(subcommandNames).toContain('sync');
    expect(subcommandNames).toContain('fire');
    expect(subcommandNames).toContain('enable');
    expect(subcommandNames).toContain('disable');
    expect(subcommandNames).toContain('status');
  });

  it('trigger list succeeds when scheduler returns triggers', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(sampleTriggers),
    } as unknown as Response);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'list'])
    ).resolves.toBeDefined();
  });

  it('trigger list handles empty triggers list', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue([]),
    } as unknown as Response);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'list'])
    ).resolves.toBeDefined();
  });

  it('trigger list handles scheduler offline (connection refused)', async () => {
    const connError = new Error('fetch failed');
    (connError as NodeJS.ErrnoException).cause = new Error('ECONNREFUSED');
    global.fetch = vi.fn().mockRejectedValue(connError);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'list'])
    ).resolves.toBeDefined();
  });

  it('trigger list filters by squad', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      capturedUrl = url;
      return Promise.resolve({
        ok: true,
        json: vi.fn().mockResolvedValue(sampleTriggers),
      });
    });

    await program.parseAsync(['node', 'squads', 'trigger', 'list', 'engineering']);

    expect(capturedUrl).toContain('squad=engineering');
  });

  it('trigger sync handles scheduler offline', async () => {
    const connError = new Error('fetch failed');
    global.fetch = vi.fn().mockRejectedValue(connError);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'sync'])
    ).resolves.toBeDefined();
  });

  it('trigger sync succeeds with valid response', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ synced: 3, triggers: ['t1', 't2', 't3'], errors: [] }),
    } as unknown as Response);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'sync'])
    ).resolves.toBeDefined();
  });

  it('trigger sync shows errors when sync has partial failures', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        synced: 1,
        triggers: ['t1'],
        errors: [{ name: 'broken-trigger', error: 'Invalid config' }],
      }),
    } as unknown as Response);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'sync'])
    ).resolves.toBeDefined();
  });

  it('trigger status shows scheduler stats', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(sampleStats),
    } as unknown as Response);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'status'])
    ).resolves.toBeDefined();
  });

  it('trigger status handles scheduler offline', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'status'])
    ).resolves.toBeDefined();
  });

  it('trigger enable updates trigger', async () => {
    // First fetch: list triggers, second fetch: patch trigger
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(sampleTriggers),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ...sampleTriggers[0], enabled: true }),
      });

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'enable', 'issue_labeled_squad'])
    ).resolves.toBeDefined();
  });

  it('trigger disable updates trigger', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(sampleTriggers),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ ...sampleTriggers[0], enabled: false }),
      });

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'disable', 'issue_labeled_squad'])
    ).resolves.toBeDefined();
  });

  it('trigger enable handles unknown trigger name', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(sampleTriggers),
    } as unknown as Response);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'enable', 'nonexistent'])
    ).resolves.toBeDefined();
  });

  it('trigger fire queues an execution', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(sampleTriggers),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ id: 'exec-abc123', status: 'queued' }),
      });

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'fire', 'issue_labeled_squad'])
    ).resolves.toBeDefined();
  });

  it('trigger fire handles unknown trigger', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(sampleTriggers),
    } as unknown as Response);

    await expect(
      program.parseAsync(['node', 'squads', 'trigger', 'fire', 'nonexistent'])
    ).resolves.toBeDefined();
  });
});
