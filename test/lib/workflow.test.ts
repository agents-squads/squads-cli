/**
 * Tests for src/lib/workflow.ts — squad conversation orchestration.
 *
 * Covers:
 * - runConversation: no squads dir, no lead agent, single lead, max cycle safety
 * - saveTranscript: creates file, returns path, handles no squads dir
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs before import
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

// Mock child_process before import
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    exec: vi.fn(),
    spawn: vi.fn(),
  };
});

// Mock squad-parser
vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
}));

// Mock run-context to avoid file system reads in unit tests
vi.mock('../../src/lib/run-context.js', () => ({
  gatherSquadContext: vi.fn().mockReturnValue(''),
}));

// Mock conversation to keep tests fast
vi.mock('../../src/lib/conversation.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/conversation.js')>('../../src/lib/conversation.js');
  return {
    ...actual,
    // Override expensive parts if needed; keep pure logic real
  };
});

import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { findSquadsDir } from '../../src/lib/squad-parser.js';
import { runConversation, saveTranscript } from '../../src/lib/workflow.js';
import { createTranscript, addTurn } from '../../src/lib/conversation.js';
import type { Squad } from '../../src/lib/squad-parser.js';

const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockExecSync = vi.mocked(execSync);
const mockSpawn = vi.mocked(spawn);
const mockFindSquadsDir = vi.mocked(findSquadsDir);

/**
 * Create a fake child_process spawn result that emits stdout then closes.
 * Returns a plain object — cast to ReturnType<typeof spawn> at call site.
 */
function makeFakeChild(stdout: string) {
  const stdoutCbs: ((chunk: Buffer) => void)[] = [];
  const closeCbs: ((code: number) => void)[] = [];
  return {
    stdin: { write: vi.fn(), end: vi.fn() },
    stdout: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === 'data') stdoutCbs.push(cb);
      }),
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'close') {
        closeCbs.push(cb as (code: number) => void);
        setImmediate(() => {
          stdoutCbs.forEach(fn => fn(Buffer.from(stdout)));
          closeCbs.forEach(fn => fn(0));
        });
      }
    }),
    kill: vi.fn(),
  };
}

// Minimal squad fixture
function makeSquad(overrides: Partial<Squad> = {}): Squad {
  return {
    name: 'test-squad',
    mission: 'Test squad',
    dir: 'test-squad',
    agents: [],
    model: { default: 'sonnet' },
    repo: undefined,
    stack: undefined,
    context: undefined,
    ...overrides,
  };
}

// ─── runConversation ──────────────────────────────────────────────────────────

describe('runConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with converged=true when no squads directory found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const squad = makeSquad();
    const result = await runConversation(squad);

    expect(result.converged).toBe(true);
    expect(result.reason).toContain('No squads directory');
    expect(result.turnCount).toBe(0);
    expect(result.totalCost).toBe(0);
  });

  it('returns early with converged=true when squad has no lead agent', async () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(false); // no agent files exist
    const squad = makeSquad({
      agents: [
        { name: 'worker-agent', role: 'does the work', model: undefined },
      ],
    });
    const result = await runConversation(squad);

    expect(result.converged).toBe(true);
    expect(result.reason).toContain('No lead agent');
  });

  it('returns converged=true when lead signals completion immediately', async () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true); // agent file exists

    // Lead outputs a convergence phrase immediately
    mockSpawn.mockReturnValue(makeFakeChild('Session complete. All PRs merged.') as unknown as ReturnType<typeof spawn>);

    const squad = makeSquad({
      agents: [{ name: 'squad-lead', role: 'orchestrates the team', model: undefined }],
    });
    const result = await runConversation(squad, { verbose: false });

    expect(result.converged).toBe(true);
    expect(result.turnCount).toBeGreaterThan(0);
  });

  it('stops at cost ceiling', async () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);

    // Each lead turn produces non-convergent output but we set very low cost ceiling
    mockSpawn.mockReturnValue(makeFakeChild('Still working on it.') as unknown as ReturnType<typeof spawn>);

    const squad = makeSquad({
      agents: [{ name: 'squad-lead', role: 'orchestrates the team', model: undefined }],
    });

    // Very low cost ceiling — first expensive turn should trigger stop
    const result = await runConversation(squad, {
      costCeiling: 0.001, // essentially 0 — any turn exceeds this
      verbose: false,
    });

    expect(result.converged).toBe(true);
    expect(result.reason).toContain('Cost ceiling');
  });

  it('stops at max turns', async () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);

    // Each turn produces non-convergent output with no cost (free)
    mockSpawn.mockReturnValue(makeFakeChild('Still working on it.') as unknown as ReturnType<typeof spawn>);

    const squad = makeSquad({
      agents: [{ name: 'squad-lead', role: 'orchestrates the team', model: undefined }],
    });

    const result = await runConversation(squad, {
      maxTurns: 1,
      costCeiling: 999,
      verbose: false,
    });

    expect(result.converged).toBe(true);
    expect(result.reason).toContain('Max turns');
  });

  it('uses task option as founder directive on first turn', async () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);

    const capturedPrompts: string[] = [];
    mockSpawn.mockImplementation(() => {
      const child = makeFakeChild('Session complete.');
      child.stdin.write.mockImplementation((data: unknown) => {
        capturedPrompts.push(typeof data === 'string' ? data : String(data));
        return true;
      });
      return child as unknown as ReturnType<typeof spawn>;
    });

    const squad = makeSquad({
      agents: [{ name: 'squad-lead', role: 'orchestrates the team', model: undefined }],
    });

    await runConversation(squad, {
      task: 'Fix the critical bug immediately',
      verbose: false,
    });

    expect(capturedPrompts.length).toBeGreaterThan(0);
    expect(capturedPrompts[0]).toContain('Fix the critical bug immediately');
  });

  it('resolves squad cwd from repo field when path exists', async () => {
    mockFindSquadsDir.mockReturnValue('/some/hq/.agents/squads');
    mockExistsSync.mockImplementation((p: string) => {
      // Return true for agent file path and the repo directory
      if (String(p).includes('squad-lead.md')) return true;
      if (String(p).includes('squads-cli')) return true;
      return false;
    });

    mockSpawn.mockReturnValue(makeFakeChild('Session complete.') as unknown as ReturnType<typeof spawn>);

    const squad = makeSquad({
      repo: 'agents-squads/squads-cli',
      agents: [{ name: 'squad-lead', role: 'orchestrates the team', model: undefined }],
    });

    const result = await runConversation(squad, { verbose: false });
    // Should not crash — just verifies the repo resolution doesn't throw
    expect(result).toBeDefined();
  });

  it('excludes agents that cannot be classified', async () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);

    mockSpawn.mockReturnValue(makeFakeChild('Session complete.') as unknown as ReturnType<typeof spawn>);

    const squad = makeSquad({
      agents: [
        { name: 'squad-lead', role: 'orchestrates the team', model: undefined },
        { name: 'unknown-agent', role: undefined, model: undefined }, // unclassifiable
      ],
    });

    const result = await runConversation(squad, { verbose: false });
    // Should converge without crashing on the unclassifiable agent
    expect(result.converged).toBe(true);
  });
});

// ─── saveTranscript ───────────────────────────────────────────────────────────

describe('saveTranscript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when no squads directory found', () => {
    mockFindSquadsDir.mockReturnValue(null);
    const transcript = createTranscript('test-squad');
    const result = saveTranscript(transcript);
    expect(result).toBeNull();
  });

  it('creates conversations directory if not exists', () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(false);
    mockWriteFileSync.mockImplementation(() => undefined);
    mockMkdirSync.mockImplementation(() => '' as never);

    const transcript = createTranscript('my-squad');
    saveTranscript(transcript);

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('my-squad'),
      { recursive: true }
    );
  });

  it('does not recreate directory when it already exists', () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);
    mockWriteFileSync.mockImplementation(() => undefined);

    const transcript = createTranscript('my-squad');
    saveTranscript(transcript);

    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('returns a file path ending in .md', () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);
    mockWriteFileSync.mockImplementation(() => undefined);

    const transcript = createTranscript('my-squad');
    const result = saveTranscript(transcript);

    expect(result).toBeTruthy();
    expect(result).toMatch(/\.md$/);
  });

  it('writes transcript content including squad name and turns', () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);

    let writtenContent = '';
    mockWriteFileSync.mockImplementation((_path, content) => {
      writtenContent = content as string;
    });

    const transcript = createTranscript('engineering');
    addTurn(transcript, 'eng-lead', 'lead', 'Brief: ship the feature today.', 0.5);

    saveTranscript(transcript);

    expect(writtenContent).toContain('engineering');
    expect(writtenContent).toContain('eng-lead');
    expect(writtenContent).toContain('Brief: ship the feature today.');
  });

  it('includes cost estimate in written file', () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);

    let writtenContent = '';
    mockWriteFileSync.mockImplementation((_path, content) => {
      writtenContent = content as string;
    });

    const transcript = createTranscript('cli');
    addTurn(transcript, 'lead', 'lead', 'Done.', 1.25);

    saveTranscript(transcript);

    expect(writtenContent).toContain('1.25');
  });

  it('handles empty transcript gracefully', () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);
    mockWriteFileSync.mockImplementation(() => undefined);

    const transcript = createTranscript('empty-squad');
    const result = saveTranscript(transcript);

    // Should write successfully even with 0 turns
    expect(result).toBeTruthy();
    expect(mockWriteFileSync).toHaveBeenCalledOnce();
  });

  it('path contains squad name for namespacing', () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);
    mockWriteFileSync.mockImplementation(() => undefined);

    const transcript = createTranscript('special-squad');
    const result = saveTranscript(transcript);

    expect(result).toContain('special-squad');
  });
});
