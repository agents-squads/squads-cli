import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(),
  searchMemory: vi.fn(),
  getSquadMemory: vi.fn(),
  appendToMemory: vi.fn(),
  listMemoryEntries: vi.fn(),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  loadSquad: vi.fn(),
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
import { findMemoryDir, searchMemory, getSquadMemory, appendToMemory, listMemoryEntries } from '../../src/lib/memory.js';
import { loadSquad } from '../../src/lib/squad-parser.js';

const mockFindMemoryDir = vi.mocked(findMemoryDir);
const mockSearchMemory = vi.mocked(searchMemory);
const mockGetSquadMemory = vi.mocked(getSquadMemory);
const mockAppendToMemory = vi.mocked(appendToMemory);
const mockListMemoryEntries = vi.mocked(listMemoryEntries);
const mockLoadSquad = vi.mocked(loadSquad);

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

  it('exits with 1 when no squad memory found', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockGetSquadMemory.mockReturnValue([]);
    mockListMemoryEntries.mockReturnValue([]);
    await expect(memoryShowCommand('cli', {})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('resolves and displays squad states', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockGetSquadMemory.mockReturnValue([
      { agent: 'issue-solver', type: 'state', content: 'line1\nline2\nline3', squad: 'cli' },
    ]);
    await expect(memoryShowCommand('cli', {})).resolves.toBeUndefined();
  });

  it('truncates long content beyond 12 lines', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    const longContent = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    mockGetSquadMemory.mockReturnValue([
      { agent: 'issue-solver', type: 'state', content: longContent, squad: 'cli' },
    ]);
    await expect(memoryShowCommand('cli', {})).resolves.toBeUndefined();
  });

  it('renders learnings alongside state so a recent write is visible (#914)', async () => {
    mockFindMemoryDir.mockReturnValue('/path/to/memory');
    mockGetSquadMemory.mockReturnValue([
      { agent: 'lead', type: 'state', content: 'Status: active', squad: 'research' },
      { agent: 'lead', type: 'learnings', content: '## 2026-07-10: insight\n\nFound: MCP adoption at 15%', squad: 'research' },
    ]);
    await expect(memoryShowCommand('research', {})).resolves.toBeUndefined();
    // Both entries were fetched via the combined-memory read path, not state-only.
    expect(mockGetSquadMemory).toHaveBeenCalledWith('research');
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

  it('falls back to `${squad}-lead` when no roster can be loaded', async () => {
    mockLoadSquad.mockReturnValue(null);
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
    mockLoadSquad.mockReturnValue(null);
    mockAppendToMemory.mockResolvedValue(undefined);
    await expect(memoryUpdateCommand('cli', 'content', { type: 'state' })).resolves.toBeUndefined();
    expect(mockAppendToMemory).toHaveBeenCalledWith('cli', 'cli-lead', 'state', 'content');
  });

  it('writes to the roster agent id "lead" when the squad roster has one (#914)', async () => {
    mockLoadSquad.mockReturnValue({
      name: 'research',
      dir: 'research',
      mission: '',
      agents: [{ name: 'lead', role: 'Research lead', trigger: 'manual' }],
      pipelines: [],
      triggers: { scheduled: [], event: [], manual: [] },
      routines: [],
      dependencies: [],
      outputPath: '',
      goals: [],
    });
    mockAppendToMemory.mockResolvedValue(undefined);
    await expect(memoryUpdateCommand('research', 'Found: MCP adoption at 15%', {})).resolves.toBeUndefined();
    expect(mockAppendToMemory).toHaveBeenCalledWith('research', 'lead', 'learnings', 'Found: MCP adoption at 15%');
  });

  it('writes to a `-lead`-suffixed roster agent id when there is no exact "lead"', async () => {
    mockLoadSquad.mockReturnValue({
      name: 'growth',
      dir: 'growth',
      mission: '',
      agents: [
        { name: 'growth-lead', role: 'Growth lead', trigger: 'manual' },
        { name: 'funnel-analyst', role: 'Analyst', trigger: 'manual' },
      ],
      pipelines: [],
      triggers: { scheduled: [], event: [], manual: [] },
      routines: [],
      dependencies: [],
      outputPath: '',
      goals: [],
    });
    mockAppendToMemory.mockResolvedValue(undefined);
    await expect(memoryUpdateCommand('growth', 'content', {})).resolves.toBeUndefined();
    expect(mockAppendToMemory).toHaveBeenCalledWith('growth', 'growth-lead', 'learnings', 'content');
  });

  it('explicit --agent always wins over roster resolution', async () => {
    mockLoadSquad.mockReturnValue({
      name: 'research',
      dir: 'research',
      mission: '',
      agents: [{ name: 'lead', role: 'Research lead', trigger: 'manual' }],
      pipelines: [],
      triggers: { scheduled: [], event: [], manual: [] },
      routines: [],
      dependencies: [],
      outputPath: '',
      goals: [],
    });
    mockAppendToMemory.mockResolvedValue(undefined);
    await expect(memoryUpdateCommand('research', 'content', { agent: 'custom-agent' })).resolves.toBeUndefined();
    expect(mockAppendToMemory).toHaveBeenCalledWith('research', 'custom-agent', 'learnings', 'content');
  });

  it('exits with 1 when appendToMemory throws', async () => {
    mockLoadSquad.mockReturnValue(null);
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
    process.env.SQUADS_BRIDGE_URL = 'http://test:8088';
  });

  afterEach(() => {
    delete process.env.SQUADS_BRIDGE_URL;
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
    process.env.SQUADS_BRIDGE_URL = 'http://test:8088';
  });

  afterEach(() => {
    delete process.env.SQUADS_BRIDGE_URL;
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
    process.env.MEM0_API_URL = 'http://localhost:3000';
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
    delete process.env.MEM0_API_URL;
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
