import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', cyan: '' },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  icons: { success: '✓', error: '✗' },
}));

vi.mock('chalk', () => ({
  default: new Proxy(
    (s: string) => s,
    {
      get(_, _prop) {
        const fn = (s: string) => s;
        return new Proxy(fn, {
          get(_, _p2) { return (s: string) => s; },
          apply(_, __, [s]) { return s; },
        });
      },
    }
  ),
}));

import { registerApprovalCommand } from '../../src/commands/approval.js';

const mockApproval = {
  approval_id: 'appr_test_123',
  type: 'pr' as const,
  squad: 'cli',
  agent: 'issue-solver',
  title: 'Merge PR #42',
  description: 'Merge feature PR',
  payload: {},
  status: 'pending' as const,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 86400000).toISOString(),
};

function makeProgram() {
  const program = new Command();
  program.exitOverride();
  registerApprovalCommand(program);
  return program;
}

describe('registerApprovalCommand', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    delete process.env.SQUADS_AGENT;
    delete process.env.SQUADS_SQUAD;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the approval command', () => {
    const program = makeProgram();
    const cmd = program.commands.find((c) => c.name() === 'approval');
    expect(cmd).toBeDefined();
  });

  it('registers send, list, check, cancel subcommands', () => {
    const program = makeProgram();
    const approval = program.commands.find((c) => c.name() === 'approval')!;
    const subNames = approval.commands.map((c) => c.name());
    expect(subNames).toContain('send');
    expect(subNames).toContain('list');
    expect(subNames).toContain('check');
    expect(subNames).toContain('cancel');
  });

  // ── approval list ──────────────────────────────────────────────────────────

  it('approval list shows pending approvals', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [mockApproval],
    });
    const program = makeProgram();
    await program.parseAsync(['node', 'cli', 'approval', 'list']);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/approvals')
    );
  });

  it('approval list shows empty message when none pending', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [],
    });
    const program = makeProgram();
    await program.parseAsync(['node', 'cli', 'approval', 'list']);
    const { writeLine } = await import('../../src/lib/terminal.js');
    expect(writeLine).toHaveBeenCalled();
  });

  it('approval list --json outputs raw JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [mockApproval],
    });
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = makeProgram();
    await program.parseAsync(['node', 'cli', 'approval', 'list', '--json']);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('approval list filters by squad', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [mockApproval],
    });
    const program = makeProgram();
    await program.parseAsync(['node', 'cli', 'approval', 'list', '-s', 'cli']);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('squad=cli')
    );
  });

  it('approval list with multiple approval types', async () => {
    const approvals = [
      { ...mockApproval, type: 'issue' as const, approval_id: 'appr_1' },
      { ...mockApproval, type: 'content' as const, approval_id: 'appr_2' },
      { ...mockApproval, type: 'run' as const, approval_id: 'appr_3' },
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => approvals,
    });
    const program = makeProgram();
    await program.parseAsync(['node', 'cli', 'approval', 'list']);
    expect(fetchMock).toHaveBeenCalled();
  });

  // ── approval check ─────────────────────────────────────────────────────────

  it('approval check calls process.exit(0) for approved status', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockApproval, status: 'approved' }),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'cli', 'approval', 'check', 'appr_test_123'])
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('approval check calls process.exit(1) for rejected status', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockApproval, status: 'rejected' }),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'cli', 'approval', 'check', 'appr_test_123'])
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('approval check calls process.exit(2) for pending (no --wait)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...mockApproval, status: 'pending' }),
    });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'cli', 'approval', 'check', 'appr_test_123'])
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(2);
    exitSpy.mockRestore();
  });

  it('approval check calls process.exit(1) when approval not found (404)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => null, text: async () => 'Not found' });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'cli', 'approval', 'check', 'missing_id'])
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  // ── approval send ──────────────────────────────────────────────────────────

  it('approval send creates approval with defaults', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, approval_id: 'appr_new_123' }),
    });
    const program = makeProgram();
    await program.parseAsync(['node', 'cli', 'approval', 'send', 'pr', '--title', 'Merge PR #1']);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/approvals'),
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.type).toBe('pr');
    expect(body.title).toBe('Merge PR #1');
  });

  it('approval send with json payload', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, approval_id: 'appr_new_456' }),
    });
    const program = makeProgram();
    await program.parseAsync([
      'node', 'cli', 'approval', 'send', 'issue',
      '--json', '{"repo":"squads-cli","number":42}',
    ]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.payload).toEqual({ repo: 'squads-cli', number: 42 });
  });

  it('approval send uses SQUADS_SQUAD env for squad field', async () => {
    process.env.SQUADS_SQUAD = 'cli';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, approval_id: 'appr_new_789' }),
    });
    const program = makeProgram();
    await program.parseAsync(['node', 'cli', 'approval', 'send', 'pr', '--title', 'Test']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.squad).toBe('cli');
    delete process.env.SQUADS_SQUAD;
  });

  it('approval send with invalid json exits with error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram();
    await expect(
      program.parseAsync(['node', 'cli', 'approval', 'send', 'pr', '--json', 'not-json'])
    ).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  // ── approval cancel ────────────────────────────────────────────────────────

  it('approval cancel shows not-implemented message', async () => {
    const { writeLine } = await import('../../src/lib/terminal.js');
    const program = makeProgram();
    await program.parseAsync(['node', 'cli', 'approval', 'cancel', 'appr_test_123']);
    expect(writeLine).toHaveBeenCalled();
  });
});
