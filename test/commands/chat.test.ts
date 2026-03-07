import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/env-config.js', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8000'),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  colors: { dim: '', cyan: '', red: '', yellow: '', green: '', white: '', purple: '' },
  bold: '',
  RESET: '',
  gradient: (s: string) => s,
  icons: { success: '+', error: 'x', warning: '!', active: '*', running: '>' },
  writeLine: vi.fn(),
}));

import { Command } from 'commander';
import { registerChatCommand } from '../../src/commands/chat.js';

describe('chat command', () => {
  let program: Command;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    program = new Command();
    program.exitOverride();
    registerChatCommand(program);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    fetchSpy.mockRestore();
  });

  it('registers chat command with subcommands', () => {
    const chatCmd = program.commands.find(c => c.name() === 'chat');
    expect(chatCmd).toBeDefined();
    const subcommands = chatCmd!.commands.map(c => c.name());
    expect(subcommands).toContain('read');
    expect(subcommands).toContain('post');
    expect(subcommands).toContain('search');
    expect(subcommands).toContain('reply');
  });

  it('chat read fetches messages from API', async () => {
    const mockMessages = [
      {
        id: 1,
        squad: 'cli',
        author: 'test-agent',
        author_type: 'agent',
        channel: 'general',
        content: 'Hello from tests',
        thread_id: null,
        reactions: [],
        pinned: false,
        created_at: '2026-03-07T10:00:00Z',
      },
    ];

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: mockMessages }),
    } as Response);

    await program.parseAsync(['node', 'cli', 'chat', 'read', 'cli']);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/squads/cli/chat?limit=20&channel=general'),
      expect.any(Object),
    );
  });

  it('chat read shows empty state when no messages', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    } as Response);

    const { writeLine } = await import('../../src/lib/terminal.js');
    await program.parseAsync(['node', 'cli', 'chat', 'read', 'cli']);

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('No messages yet');
  });

  it('chat read handles connection errors gracefully', async () => {
    const connError = new Error('fetch failed');
    fetchSpy.mockRejectedValueOnce(connError);

    const { writeLine } = await import('../../src/lib/terminal.js');
    await program.parseAsync(['node', 'cli', 'chat', 'read', 'cli']);

    const calls = vi.mocked(writeLine).mock.calls.map(c => c[0]).join('');
    expect(calls).toContain('API not reachable');
  });

  it('chat post sends message to API', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 42, squad: 'cli' }),
    } as Response);

    await program.parseAsync(['node', 'cli', 'chat', 'post', 'cli', 'Hello world']);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/squads/cli/chat'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Hello world'),
      }),
    );
  });

  it('chat post uses custom author when provided', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 43, squad: 'cli' }),
    } as Response);

    await program.parseAsync(['node', 'cli', 'chat', 'post', 'cli', 'Test', '--author', 'my-bot']);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.author).toBe('my-bot');
    expect(body.author_type).toBe('agent');
  });

  it('chat search queries API with encoded query', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    } as Response);

    await program.parseAsync(['node', 'cli', 'chat', 'search', 'cli', 'test query']);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/squads/cli/chat/search?query=test%20query'),
      expect.any(Object),
    );
  });

  it('chat reply sends threaded message', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ id: 44 }),
    } as Response);

    await program.parseAsync(['node', 'cli', 'chat', 'reply', 'cli', '10', 'Reply text']);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.thread_id).toBe(10);
    expect(body.content).toBe('Reply text');
  });

  it('chat read respects --limit option', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    } as Response);

    await program.parseAsync(['node', 'cli', 'chat', 'read', 'cli', '--limit', '5']);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('limit=5'),
      expect.any(Object),
    );
  });

  it('chat read respects --channel option', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: [] }),
    } as Response);

    await program.parseAsync(['node', 'cli', 'chat', 'read', 'cli', '--channel', 'ops']);

    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('channel=ops'),
      expect.any(Object),
    );
  });
});
