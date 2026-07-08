import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
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

vi.mock('../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(() => '/fake/.agents/squads'),
  listSquads: vi.fn(() => []),
}));

vi.mock('../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(() => '/fake/.squads/memory'),
}));

vi.mock('../src/lib/outcomes.js', () => ({
  getOutcomeScoreModifier: vi.fn(() => 0),
}));

vi.mock('../src/lib/terminal.js', () => ({
  colors: { green: '', red: '', yellow: '', blue: '', cyan: '', white: '', gray: '' },
  RESET: '',
  writeLine: vi.fn(),
}));

import {
  hasUnresolvedEscalation,
  classifyRunOutcome,
  checkCooldown,
  defaultState,
  scoreSquads,
  PHANTOM_THRESHOLD_MS,
} from '../src/lib/squad-loop.js';
import { execSync } from 'child_process';
import { listSquads, findSquadsDir } from '../src/lib/squad-parser.js';
import { existsSync, readFileSync } from 'fs';

const mockExecSync = vi.mocked(execSync);
const mockListSquads = vi.mocked(listSquads);
const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReturnValue('{}' as unknown as Buffer);
  mockListSquads.mockReturnValue([]);
  mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── hasUnresolvedEscalation ───────────────────────────────────────────

describe('hasUnresolvedEscalation', () => {
  it('returns blocked: false when no blocked issues exist', () => {
    mockExecSync.mockReturnValue('[]' as unknown as Buffer);
    const result = hasUnresolvedEscalation('org/repo');
    expect(result.blocked).toBe(false);
    expect(result.issue).toBeUndefined();
  });

  it('returns blocked: true when "blocked" label issue exists', () => {
    // First call: blocked label → has issue
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([{ number: 42, title: 'Finance missing Stripe credentials' }]) as unknown as Buffer,
    );

    const result = hasUnresolvedEscalation('org/repo');
    expect(result.blocked).toBe(true);
    expect(result.issue?.number).toBe(42);
    expect(result.issue?.title).toContain('Stripe');
  });

  it('returns blocked: true when "needs-human" label issue exists', () => {
    // First call: blocked → empty
    mockExecSync.mockReturnValueOnce('[]' as unknown as Buffer);
    // Second call: needs-human → has issue
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([{ number: 99, title: 'Needs human review for prod deploy' }]) as unknown as Buffer,
    );

    const result = hasUnresolvedEscalation('org/repo');
    expect(result.blocked).toBe(true);
    expect(result.issue?.number).toBe(99);
  });

  it('returns blocked: false when gh CLI fails (fail-open)', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('gh: command not found');
    });

    const result = hasUnresolvedEscalation('org/repo');
    expect(result.blocked).toBe(false);
  });

  it('passes ghEnv to execSync for bot auth', () => {
    mockExecSync.mockReturnValue('[]' as unknown as Buffer);
    const ghEnv = { GH_TOKEN: 'test-token' };

    hasUnresolvedEscalation('org/repo', ghEnv);

    const callArgs = mockExecSync.mock.calls[0];
    const options = callArgs[1] as { env?: Record<string, string> };
    expect(options.env).toMatchObject(ghEnv);
  });

  it('checks both blocked and needs-human labels', () => {
    mockExecSync.mockReturnValue('[]' as unknown as Buffer);

    hasUnresolvedEscalation('org/repo');

    // Should have made 2 gh issue list calls (blocked + needs-human)
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    const calls = mockExecSync.mock.calls.map(c => c[0] as string);
    expect(calls.some(c => c.includes('blocked'))).toBe(true);
    expect(calls.some(c => c.includes('needs-human'))).toBe(true);
  });
});

// ── classifyRunOutcome ────────────────────────────────────────────────

describe('classifyRunOutcome', () => {
  it('classifies failed when exitCode is non-zero', () => {
    const result = classifyRunOutcome(1, 30000);
    expect(result).toBe('failed');
  });

  it('classifies skipped when duration is below MIN_PHANTOM_DURATION_MS', () => {
    const result = classifyRunOutcome(0, 1000); // 1s < 30s threshold
    expect(result).toBe('skipped');
  });

  it('classifies completed when run is normal', () => {
    const result = classifyRunOutcome(0, 60000); // 60s, success
    expect(result).toBe('completed');
  });
});

// ── checkCooldown ─────────────────────────────────────────────────────

describe('checkCooldown', () => {
  it('allows run when no previous cooldown entry', () => {
    const state = defaultState();
    const result = checkCooldown(state, 'cli', 'issue-solver', 60 * 60 * 1000);
    expect(result).toBe(true);
  });

  it('blocks run when within cooldown window (returns false)', () => {
    const state = defaultState();
    state.cooldowns['cli:issue-solver'] = Date.now() - 5 * 60 * 1000; // 5 min ago

    const result = checkCooldown(state, 'cli', 'issue-solver', 60 * 60 * 1000); // 1h cooldown
    expect(result).toBe(false);
  });

  it('allows run after cooldown expires (returns true)', () => {
    const state = defaultState();
    state.cooldowns['cli:issue-solver'] = Date.now() - 5 * 60 * 60 * 1000; // 5h ago

    const result = checkCooldown(state, 'cli', 'issue-solver', 60 * 60 * 1000); // 1h cooldown
    expect(result).toBe(true);
  });
});

// ── scoreSquads — escalation pause integration ────────────────────────

describe('scoreSquads — escalation pause', () => {
  it('skips squad with score 0 when blocked escalation exists', () => {
    mockListSquads.mockReturnValue(['finance']);
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      'repo: agents-squads/finance\n' as unknown as Buffer,
    );

    // hasUnresolvedEscalation: blocked label returns an open issue
    mockExecSync.mockReturnValueOnce(
      JSON.stringify([{ number: 12, title: 'Missing Stripe credentials' }]) as unknown as Buffer,
    );

    const state = defaultState();
    const squadRepos = { finance: 'agents-squads/finance' };
    const signals = scoreSquads(state, squadRepos);

    // Finance should be in signals with score 0 and PAUSED reason
    const financeSignal = signals.find(s => s.squad === 'finance');
    expect(financeSignal).toBeDefined();
    expect(financeSignal!.score).toBe(0);
    expect(financeSignal!.reason).toContain('PAUSED');
    expect(financeSignal!.reason).toContain('#12');
  });

  it('includes squad normally when no escalation exists', () => {
    mockListSquads.mockReturnValue(['cli']);

    // hasUnresolvedEscalation: both blocked and needs-human return empty
    mockExecSync
      .mockReturnValueOnce('[]' as unknown as Buffer) // blocked check
      .mockReturnValueOnce('[]' as unknown as Buffer) // needs-human check
      .mockReturnValueOnce( // getOpenIssues
        JSON.stringify([{
          number: 527,
          title: 'ReferenceError: provider is not defined',
          labels: [{ name: 'priority:P0' }, { name: 'bug' }],
        }]) as unknown as Buffer,
      );

    const state = defaultState();
    const squadRepos = { cli: 'agents-squads/squads-cli' };
    const signals = scoreSquads(state, squadRepos);

    const cliSignal = signals.find(s => s.squad === 'cli');
    expect(cliSignal).toBeDefined();
    expect(cliSignal!.score).toBeGreaterThan(0);
    expect(cliSignal!.reason).not.toContain('PAUSED');
  });

  it('returns empty when no squads configured', () => {
    mockListSquads.mockReturnValue([]);
    const state = defaultState();
    const signals = scoreSquads(state, {});
    expect(signals).toHaveLength(0);
  });

  it('skips squad when findSquadsDir returns null', () => {
    mockFindSquadsDir.mockReturnValue(null);
    const state = defaultState();
    const signals = scoreSquads(state, {});
    expect(signals).toHaveLength(0);
  });

  it('gives escalation-paused squads score 0 — not dispatched', () => {
    mockListSquads.mockReturnValue(['analytics', 'cli']);

    mockExecSync
      // analytics: blocked check returns an open issue
      .mockReturnValueOnce(
        JSON.stringify([{ number: 77, title: 'BQ credentials missing' }]) as unknown as Buffer,
      )
      // cli: blocked → empty, needs-human → empty, open issues → P1 issue
      .mockReturnValueOnce('[]' as unknown as Buffer)
      .mockReturnValueOnce('[]' as unknown as Buffer)
      .mockReturnValueOnce(
        JSON.stringify([{
          number: 100,
          title: 'Improve test coverage',
          labels: [{ name: 'priority:P1' }],
        }]) as unknown as Buffer,
      );

    const state = defaultState();
    const squadRepos = {
      analytics: 'agents-squads/analytics',
      cli: 'agents-squads/squads-cli',
    };
    const signals = scoreSquads(state, squadRepos);

    const analyticsSignal = signals.find(s => s.squad === 'analytics');
    const cliSignal = signals.find(s => s.squad === 'cli');

    expect(analyticsSignal).toBeDefined();
    expect(analyticsSignal!.score).toBe(0);
    expect(analyticsSignal!.reason).toContain('PAUSED');
    expect(cliSignal).toBeDefined();
    expect(cliSignal!.score).toBeGreaterThan(0);

    // Sorted score descending — cli (non-zero score) wins over analytics (0)
    const nonPaused = signals.filter(s => s.score > 0);
    expect(nonPaused[0]?.squad).toBe('cli');
  });
});

// ── defaultState ──────────────────────────────────────────────────────

describe('defaultState', () => {
  it('returns valid initial state structure', () => {
    const state = defaultState();
    expect(state).toMatchObject({
      failCounts: {},
      cooldowns: {},
      recentRuns: [],
    });
    expect(state.dailyCost).toBe(0);
  });
});
