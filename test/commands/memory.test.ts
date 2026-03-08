import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(),
  searchMemory: vi.fn(),
  getSquadState: vi.fn(),
  appendToMemory: vi.fn(),
  listMemoryEntries: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '',
    red: '',
    green: '',
    yellow: '',
    purple: '',
    cyan: '',
    white: '',
  },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  box: {
    topLeft: '┌',
    topRight: '┐',
    bottomLeft: '└',
    bottomRight: '┘',
    vertical: '│',
    horizontal: '─',
    teeRight: '├',
    teeLeft: '┤',
  },
  icons: {
    success: '✓',
    error: '✗',
    warning: '!',
    progress: '›',
    empty: '○',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
  truncate: vi.fn((s: string, n: number) => s.slice(0, n)),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
  Events: {
    CLI_MEMORY_QUERY: 'cli.memory.query',
    CLI_MEMORY_SHOW: 'cli.memory.show',
    CLI_MEMORY_UPDATE: 'cli.memory.update',
    CLI_MEMORY_LIST: 'cli.memory.list',
  },
}));

vi.mock('../../src/lib/services.js', () => ({
  checkServiceAvailable: vi.fn().mockResolvedValue(false),
  showServiceSetupGuide: vi.fn(),
}));

import {
  memoryQueryCommand,
  memoryShowCommand,
  memoryUpdateCommand,
  memoryListCommand,
  memorySearchCommand,
  memoryExtractCommand,
} from '../../src/commands/memory.js';
import { findMemoryDir, searchMemory, getSquadState, appendToMemory, listMemoryEntries } from '../../src/lib/memory.js';

const mockFindMemoryDir = vi.mocked(findMemoryDir);
const mockSearchMemory = vi.mocked(searchMemory);
const mockGetSquadState = vi.mocked(getSquadState);
const mockAppendToMemory = vi.mocked(appendToMemory);
const mockListMemoryEntries = vi.mocked(listMemoryEntries);

describe('memoryQueryCommand', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits with 1 when no memory directory found', async () => {
    mockFindMemoryDir.mockReturnValue(null);
    await expect(memoryQueryCommand('test query', {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('resolves when memory dir found but no results', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockSearchMemory.mockReturnValue([]);
    await expect(memoryQueryCommand('test query', {})).resolves.toBeUndefined();
  });

  it('resolves with results and displays them', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockSearchMemory.mockReturnValue([
      {
        entry: { squad: 'cli', agent: 'issue-solver', type: 'state', content: 'test content' },
        score: 7.5,
        matches: ['test content'],
      },
    ]);
    await expect(memoryQueryCommand('test', {})).resolves.toBeUndefined();
  });

  it('filters results by squad option', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockSearchMemory.mockReturnValue([
      {
        entry: { squad: 'cli', agent: 'agent-1', type: 'state', content: 'cli content' },
        score: 5,
        matches: ['cli content'],
      },
      {
        entry: { squad: 'engineering', agent: 'agent-2', type: 'state', content: 'eng content' },
        score: 4,
        matches: ['eng content'],
      },
    ]);
    await expect(memoryQueryCommand('content', { squad: 'cli' })).resolves.toBeUndefined();
    expect(mockSearchMemory).toHaveBeenCalled();
  });

  it('filters results by agent option', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockSearchMemory.mockReturnValue([
      {
        entry: { squad: 'cli', agent: 'issue-solver', type: 'state', content: 'content' },
        score: 5,
        matches: ['content'],
      },
    ]);
    await expect(memoryQueryCommand('content', { agent: 'issue-solver' })).resolves.toBeUndefined();
  });
});

describe('memoryShowCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits with 1 when no memory directory found', async () => {
    mockFindMemoryDir.mockReturnValue(null);
    await expect(memoryShowCommand('cli', {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with 1 when no squad state found', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockGetSquadState.mockReturnValue([]);
    mockListMemoryEntries.mockReturnValue([]);
    await expect(memoryShowCommand('cli', {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('resolves and displays squad states', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockGetSquadState.mockReturnValue([
      { agent: 'issue-solver', type: 'state', content: 'line1\nline2\nline3', squad: 'cli' },
    ]);
    await expect(memoryShowCommand('cli', {})).resolves.toBeUndefined();
  });

  it('truncates long content beyond 12 lines', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    const longContent = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    mockGetSquadState.mockReturnValue([
      { agent: 'issue-solver', type: 'state', content: longContent, squad: 'cli' },
    ]);
    await expect(memoryShowCommand('cli', {})).resolves.toBeUndefined();
  });
});

describe('memoryUpdateCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('resolves on successful update', async () => {
    mockAppendToMemory.mockResolvedValue(undefined);
    await expect(memoryUpdateCommand('cli', 'test content', {})).resolves.toBeUndefined();
    expect(mockAppendToMemory).toHaveBeenCalledWith('cli', 'cli-lead', 'learnings', 'test content');
  });

  it('uses provided agent name', async () => {
    mockAppendToMemory.mockResolvedValue(undefined);
    await expect(memoryUpdateCommand('cli', 'content', { agent: 'issue-solver' })).resolves.toBeUndefined();
    expect(mockAppendToMemory).toHaveBeenCalledWith('cli', 'issue-solver', 'learnings', 'content');
  });

  it('uses provided type option', async () => {
    mockAppendToMemory.mockResolvedValue(undefined);
    await expect(memoryUpdateCommand('cli', 'content', { type: 'state' })).resolves.toBeUndefined();
    expect(mockAppendToMemory).toHaveBeenCalledWith('cli', 'cli-lead', 'state', 'content');
  });

  it('exits with 1 when appendToMemory throws', async () => {
    mockAppendToMemory.mockRejectedValue(new Error('Write failed'));
    await expect(memoryUpdateCommand('cli', 'content', {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('memoryListCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits with 1 when no memory directory found', async () => {
    mockFindMemoryDir.mockReturnValue(null);
    await expect(memoryListCommand()).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('resolves with empty entries', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockListMemoryEntries.mockReturnValue([]);
    await expect(memoryListCommand()).resolves.toBeUndefined();
  });

  it('groups entries by squad and displays table', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockListMemoryEntries.mockReturnValue([
      { squad: 'cli', agent: 'issue-solver', type: 'state' },
      { squad: 'cli', agent: 'lead', type: 'learnings' },
      { squad: 'engineering', agent: 'builder', type: 'output' },
    ]);
    await expect(memoryListCommand()).resolves.toBeUndefined();
  });
});

describe('memorySearchCommand', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it('resolves when bridge returns 503', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    await expect(memorySearchCommand('test query')).resolves.toBeUndefined();
  });

  it('resolves with empty results', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], count: 0 }),
    });
    await expect(memorySearchCommand('test query')).resolves.toBeUndefined();
  });

  it('resolves with search results and renders table', async () => {
    const results = [
      {
        id: 1,
        session_id: 'sess-abc123',
        role: 'user',
        content: 'test message content',
        type: 'message',
        importance: 'high',
        created_at: new Date().toISOString(),
        rank: 1,
      },
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results, count: 1 }),
    });
    await expect(memorySearchCommand('test')).resolves.toBeUndefined();
  });

  it('resolves with role and importance filters', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [], count: 0 }),
    });
    await expect(memorySearchCommand('test', { role: 'user', importance: 'high' })).resolves.toBeUndefined();
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('role=user');
    expect(url).toContain('importance=high');
  });

  it('resolves gracefully on connection refused', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(memorySearchCommand('test query')).resolves.toBeUndefined();
  });

  it('resolves gracefully on fetch failed', async () => {
    fetchMock.mockRejectedValue(new Error('fetch failed'));
    await expect(memorySearchCommand('test query')).resolves.toBeUndefined();
  });
});

describe('memoryExtractCommand', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  it('resolves when bridge returns no conversations', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ conversations: [], count: 0 }),
    });
    await expect(memoryExtractCommand()).resolves.toBeUndefined();
  });

  it('resolves with dry run option (no mem0 calls)', async () => {
    const conversations = [
      { id: 1, session_id: 'sess-1', role: 'user', content: 'hello', squad: 'cli', agent: 'agent', created_at: new Date().toISOString() },
    ];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ conversations, count: 1 }),
    });
    await expect(memoryExtractCommand({ dryRun: true })).resolves.toBeUndefined();
    // Only one fetch call (bridge), not two (bridge + mem0)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends sessions to mem0 and reports success', async () => {
    const conversations = [
      { id: 1, session_id: 'sess-abc', role: 'user', content: 'hello', squad: 'cli', agent: 'agent', created_at: new Date().toISOString() },
    ];
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ conversations, count: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ id: 1 }] }),
      });
    await expect(memoryExtractCommand()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('handles mem0 failure gracefully', async () => {
    const conversations = [
      { id: 1, session_id: 'sess-xyz', role: 'assistant', content: 'response', squad: 'cli', agent: 'agent', created_at: new Date().toISOString() },
    ];
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ conversations, count: 1 }),
      })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(memoryExtractCommand()).resolves.toBeUndefined();
  });

  it('resolves gracefully when bridge is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(memoryExtractCommand()).resolves.toBeUndefined();
  });
});
