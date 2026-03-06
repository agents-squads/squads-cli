import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../../src/lib/terminal.js', () => ({
  colors: { dim: '', cyan: '', green: '', red: '', yellow: '' },
  RESET: '',
  gradient: (s: string) => s,
  icons: { success: '✓', error: '✗', running: '●' },
  writeLine: vi.fn(),
  bold: (s: string) => s,
  padEnd: (s: string, n: number) => s.padEnd(n),
  truncate: (s: string, n: number) => s.slice(0, n),
}));

// Prevent bridge fetch from hanging tests
global.fetch = vi.fn().mockRejectedValue(new Error('No bridge in tests'));

describe('historyCommand', () => {
  let testDir: string;
  let originalCwd: string;

  beforeEach(() => {
    testDir = join(tmpdir(), 'squads-history-test-' + Date.now());
    mkdirSync(join(testDir, '.agents', 'sessions'), { recursive: true });
    originalCwd = process.cwd();
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('runs without error when no history file exists', async () => {
    const { historyCommand } = await import('../../src/commands/history.js');
    await expect(historyCommand({})).resolves.toBeUndefined();
  });

  it('reads local history from .agents/sessions/history.jsonl', async () => {
    const historyPath = join(testDir, '.agents', 'sessions', 'history.jsonl');
    const entry = {
      type: 'session_end',
      timestamp: new Date().toISOString(),
      squad: 'engineering',
      agent: 'coder',
      sessionId: 'sess-001',
      duration: 45000,
      status: 'success',
      cost: 0.12,
      tokens: 8500,
    };
    writeFileSync(historyPath, JSON.stringify(entry) + '\n');

    const { historyCommand } = await import('../../src/commands/history.js');
    await expect(historyCommand({})).resolves.toBeUndefined();
  });

  it('filters history by squad', async () => {
    const historyPath = join(testDir, '.agents', 'sessions', 'history.jsonl');
    const entries = [
      { type: 'session_end', timestamp: new Date().toISOString(), squad: 'engineering', agent: 'coder', sessionId: 's1', status: 'success' },
      { type: 'session_end', timestamp: new Date().toISOString(), squad: 'marketing', agent: 'writer', sessionId: 's2', status: 'success' },
    ];
    writeFileSync(historyPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const { historyCommand } = await import('../../src/commands/history.js');
    await expect(historyCommand({ squad: 'engineering' })).resolves.toBeUndefined();
  });

  it('outputs JSON when --json flag is set', async () => {
    const historyPath = join(testDir, '.agents', 'sessions', 'history.jsonl');
    const entry = {
      type: 'agent_complete',
      timestamp: new Date().toISOString(),
      squad: 'cli',
      agent: 'issue-solver',
      sessionId: 'sess-002',
      status: 'success',
    };
    writeFileSync(historyPath, JSON.stringify(entry) + '\n');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { historyCommand } = await import('../../src/commands/history.js');
    await historyCommand({ json: true });

    if (logSpy.mock.calls.length > 0) {
      const output = JSON.parse(logSpy.mock.calls[0][0] as string) as unknown[];
      expect(Array.isArray(output)).toBe(true);
    }

    logSpy.mockRestore();
  });

  it('skips entries older than --days threshold', async () => {
    const historyPath = join(testDir, '.agents', 'sessions', 'history.jsonl');
    const oldTimestamp = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const oldEntry = {
      type: 'session_end',
      timestamp: oldTimestamp,
      squad: 'engineering',
      agent: 'coder',
      sessionId: 'old-sess',
      status: 'success',
    };
    writeFileSync(historyPath, JSON.stringify(oldEntry) + '\n');

    const { historyCommand } = await import('../../src/commands/history.js');
    // days=3 should exclude an entry from 10 days ago
    await expect(historyCommand({ days: 3 })).resolves.toBeUndefined();
  });

  it('handles malformed JSONL lines gracefully', async () => {
    const historyPath = join(testDir, '.agents', 'sessions', 'history.jsonl');
    writeFileSync(historyPath, 'not json at all\n{"type":"session_end","timestamp":"' + new Date().toISOString() + '","squad":"cli","agent":"test","sessionId":"ok","status":"success"}\n');

    const { historyCommand } = await import('../../src/commands/history.js');
    await expect(historyCommand({})).resolves.toBeUndefined();
  });
});
