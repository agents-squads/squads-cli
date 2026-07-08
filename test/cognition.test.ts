import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(() => '/fake/.squads/memory'),
}));

vi.mock('../src/lib/squad-loop.js', () => ({
  slackNotify: vi.fn(() => Promise.resolve()),
}));

vi.mock('../src/lib/terminal.js', () => ({
  colors: { dim: '' },
  RESET: '',
  writeLine: vi.fn(),
}));

vi.mock('../src/lib/config.js', () => ({
  loadProjectConfig: vi.fn(() => ({})),
}));

import { existsSync, readFileSync, readdirSync } from 'fs';
import { loadCognitionState, addSignal, ingestMemoryFiles } from '../src/lib/cognition.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockReaddirSync = vi.mocked(readdirSync);

// addSignal/ingestMemoryFiles are local-first: the cognition engine no longer
// pushes to squads-api (dropped in migration 038, agents-squads/squads-cli#1039).
// Asserting on global.fetch (rather than a mocked api-client module) proves
// there is no network call at all, not just that a mock absorbed one.
describe('cognition — local-first signal handling (no network calls)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReturnValue('{}' as unknown as Buffer);
    mockReaddirSync.mockReturnValue([] as unknown as ReturnType<typeof readdirSync>);
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('addSignal appends to local state and returns the created signal', () => {
    const state = loadCognitionState();

    const signal = addSignal(state, {
      source: 'execution',
      signal_type: 'agent_completed',
      value: 1,
      unit: 'completion',
      data: { note: 'test' },
      entity_type: 'agent',
      entity_id: 'cli/issue-solver',
      confidence: 0.9,
    });

    expect(signal.id).toBe(1);
    expect(state.signals).toHaveLength(1);
    expect(state.signals[0]).toBe(signal);
    expect(state.next_signal_id).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ingestMemoryFiles reads memory files into local signals with no network call', () => {
    const state = loadCognitionState();

    mockReaddirSync.mockImplementation((dirPath) => {
      if (String(dirPath).endsWith('/cli')) {
        return [{ name: 'issue-solver', isDirectory: () => true }] as unknown as ReturnType<typeof readdirSync>;
      }
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.endsWith('/cli') || path.endsWith('state.md');
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('state.md')) {
        return '- Shipped PR #1039 cleanup\n- Fixed dead cognition-signal calls\n';
      }
      return '{}';
    });

    const created = ingestMemoryFiles(state, ['cli']);

    expect(created).toBe(2);
    expect(state.signals).toHaveLength(2);
    expect(state.signals.every(s => s.source === 'memory')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ingestMemoryFiles skips unchanged content on repeat runs (dedup by hash, local-only)', () => {
    const state = loadCognitionState();

    mockReaddirSync.mockImplementation((dirPath) => {
      if (String(dirPath).endsWith('/cli')) {
        return [{ name: 'issue-solver', isDirectory: () => true }] as unknown as ReturnType<typeof readdirSync>;
      }
      return [] as unknown as ReturnType<typeof readdirSync>;
    });
    mockExistsSync.mockImplementation((p) => {
      const path = String(p);
      return path.endsWith('/cli') || path.endsWith('state.md');
    });
    mockReadFileSync.mockImplementation((p) => {
      const path = String(p);
      if (path.endsWith('state.md')) {
        return '- Same content every time\n';
      }
      return '{}';
    });

    const firstRun = ingestMemoryFiles(state, ['cli']);
    const secondRun = ingestMemoryFiles(state, ['cli']);

    expect(firstRun).toBe(1);
    expect(secondRun).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
