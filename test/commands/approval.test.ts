import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
}));

// Mock chalk - approval.ts uses chalk.green, chalk.bold.dim, etc.
vi.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalk = new Proxy(identity, {
    get: () => new Proxy(identity, { get: () => identity }),
  });
  (chalk as Record<string, unknown>).bold = identity;
  (chalk as Record<string, unknown>).green = identity;
  (chalk as Record<string, unknown>).red = identity;
  (chalk as Record<string, unknown>).yellow = identity;
  (chalk as Record<string, unknown>).cyan = identity;
  (chalk as Record<string, unknown>).magenta = identity;
  (chalk as Record<string, unknown>).blue = identity;
  (chalk as Record<string, unknown>).gray = identity;
  (chalk as Record<string, unknown>).dim = identity;
  (chalk as Record<string, unknown>).white = identity;
  return { default: chalk };
});

import { registerApprovalCommand } from '../../src/commands/approval.js';

const sampleApproval = {
  approval_id: 'appr_abc123_xyz',
  type: 'pr' as const,
  squad: 'engineering',
  agent: 'issue-solver',
  title: 'Merge feature X',
  description: 'Merges PR #42',
  payload: {},
  status: 'pending' as const,
  decided_by: undefined,
  decided_at: undefined,
  created_at: '2026-03-06T10:00:00Z',
  expires_at: '2026-03-07T10:00:00Z',
};

describe('registerApprovalCommand', () => {
  let program: Command;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerApprovalCommand(program);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('registers the approval command', () => {
    const cmd = program.commands.find(c => c.name() === 'approval');
    expect(cmd).toBeDefined();
  });

  it('registers all expected subcommands', () => {
    const cmd = program.commands.find(c => c.name() === 'approval')!;
    const names = cmd.commands.map(c => c.name());
    expect(names).toContain('send');
    expect(names).toContain('list');
    expect(names).toContain('check');
    expect(names).toContain('cancel');
  });

  describe('approval send', () => {
    it('sends an approval request successfully', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, approval_id: 'appr_test' }),
        text: async () => '',
      } as Response);

      await program.parseAsync([
        'node', 'cli', 'approval', 'send', 'pr',
        '--title', 'Merge PR #42',
        '--squad', 'engineering',
      ]);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/approvals'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('includes correct type in request body', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, approval_id: 'appr_test' }),
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'send', 'issue', '--title', 'File issue']);

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.type).toBe('issue');
    });

    it('generates a unique approval_id with appr_ prefix', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, approval_id: 'appr_test' }),
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'send', 'run']);

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.approval_id).toMatch(/^appr_/);
    });

    it('uses SQUADS_SQUAD env var when --squad not provided', async () => {
      process.env.SQUADS_SQUAD = 'cli';
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, approval_id: 'appr_test' }),
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'send', 'brief']);

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.squad).toBe('cli');
      delete process.env.SQUADS_SQUAD;
    });

    it('uses JSON payload when --json is provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, approval_id: 'appr_test' }),
        text: async () => '',
      } as Response);

      await program.parseAsync([
        'node', 'cli', 'approval', 'send', 'content',
        '--json', '{"title":"My Title","description":"My Desc"}',
      ]);

      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.title).toBe('My Title');
    });

    it('exits on API error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'Internal Server Error',
      } as Response);

      await expect(
        program.parseAsync(['node', 'cli', 'approval', 'send', 'pr', '--title', 'Test'])
      ).rejects.toThrow();
    });
  });

  describe('approval list', () => {
    it('lists pending approvals', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [sampleApproval],
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'list']);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/approvals')
      );
    });

    it('shows empty state when no approvals', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'list']);
      expect(global.fetch).toHaveBeenCalled();
    });

    it('filters by squad when --squad is provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [],
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'list', '--squad', 'cli']);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('squad=cli')
      );
    });

    it('outputs JSON when --json flag is set', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [sampleApproval],
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'list', '--json']);
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('approval_id'));
      consoleSpy.mockRestore();
    });

    it('exits on API error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        text: async () => 'Server error',
        json: async () => ({}),
      } as Response);

      await expect(
        program.parseAsync(['node', 'cli', 'approval', 'list'])
      ).rejects.toThrow();
    });

    it('renders all approval types with different colors', async () => {
      const types = ['issue', 'pr', 'content', 'run', 'brief'] as const;
      const approvals = types.map(t => ({ ...sampleApproval, type: t, approval_id: `appr_${t}` }));
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => approvals,
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'list']);
      expect(global.fetch).toHaveBeenCalled();
    });
  });

  describe('approval check', () => {
    it('checks approval status without wait', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...sampleApproval, status: 'pending' }),
        text: async () => '',
      } as Response);

      await expect(
        program.parseAsync(['node', 'cli', 'approval', 'check', 'appr_abc123'])
      ).rejects.toThrow(); // exits with code 2 for pending
    });

    it('exits 0 when approval is approved', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...sampleApproval, status: 'approved', decided_by: 'jorge', decided_at: '2026-03-06T11:00:00Z' }),
        text: async () => '',
      } as Response);

      await expect(
        program.parseAsync(['node', 'cli', 'approval', 'check', 'appr_abc123'])
      ).rejects.toThrow(); // process.exit(0) throws in exitOverride
    });

    it('exits 1 when approval is rejected', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ...sampleApproval, status: 'rejected' }),
        text: async () => '',
      } as Response);

      await expect(
        program.parseAsync(['node', 'cli', 'approval', 'check', 'appr_abc123'])
      ).rejects.toThrow(); // process.exit(1) throws
    });

    it('exits when approval not found (404)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => '',
      } as Response);

      await expect(
        program.parseAsync(['node', 'cli', 'approval', 'check', 'appr_notfound'])
      ).rejects.toThrow();
    });
  });

  describe('approval cancel', () => {
    it('outputs not-yet-implemented message', async () => {
      const { writeLine } = await import('../../src/lib/terminal.js');

      await program.parseAsync(['node', 'cli', 'approval', 'cancel', 'appr_abc123']);

      expect(writeLine).toHaveBeenCalledWith(
        expect.stringContaining('appr_abc123')
      );
    });
  });

  describe('parseExpiresIn (via send)', () => {
    it('handles hours format (e.g. 2h)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, approval_id: 'appr_test' }),
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'send', 'pr', '--expires-in', '2h']);
      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.expires_at).toBeDefined();
    });

    it('handles minutes format (e.g. 30m)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, approval_id: 'appr_test' }),
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'send', 'pr', '--expires-in', '30m']);
      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.expires_at).toBeDefined();
    });

    it('handles days format (e.g. 1d)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, approval_id: 'appr_test' }),
        text: async () => '',
      } as Response);

      await program.parseAsync(['node', 'cli', 'approval', 'send', 'pr', '--expires-in', '1d']);
      const body = JSON.parse((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(body.expires_at).toBeDefined();
    });
  });
});
