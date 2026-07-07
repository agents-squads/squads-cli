import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';

// ── Module mocks (must be before imports) ─────────────────────────────────
const fakeFiles = new Map<string, string>();

vi.mock('fs', () => ({
  existsSync: vi.fn((p: string) => fakeFiles.has(p)),
  readFileSync: vi.fn((p: string) => {
    if (!fakeFiles.has(p)) throw new Error(`ENOENT: ${p}`);
    return fakeFiles.get(p);
  }),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'abc1234 initial commit'),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  findProjectRoot: vi.fn(),
  loadSquad: vi.fn(),
  listSquads: vi.fn(() => []),
  findSimilarSquads: vi.fn(() => []),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(() => null),
}));

vi.mock('../../src/lib/execution-engine.js', () => ({
  preflightExecutorCheck: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../src/lib/llm-clis.js', () => ({
  normalizeProviderName: vi.fn((p: string) => p),
}));

vi.mock('../../src/lib/workflow.js', () => ({
  runConversation: vi.fn(() => Promise.resolve({
    transcript: { squad: 'demo', turns: [], startedAt: '', totalCost: 0 },
    turnCount: 3,
    totalCost: 1.23,
    converged: true,
    reason: 'Cycle complete',
  })),
  saveTranscript: vi.fn(() => '/tmp/transcript.md'),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', cyan: '' },
  RESET: '',
  gradient: vi.fn((s: string) => s),
  icons: { success: '✓', error: '✗', warning: '!' },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────
import {
  proposeCommand,
  tokenize,
  selectSquad,
  assembleProposeContext,
  DEFAULT_PROPOSE_COST_CEILING,
  PROPOSAL_BRANCH_PREFIX,
  type ProposeContext,
} from '../../src/commands/propose.js';
import { findSquadsDir, findProjectRoot, loadSquad, listSquads, findSimilarSquads } from '../../src/lib/squad-parser.js';
import { preflightExecutorCheck } from '../../src/lib/execution-engine.js';
import { runConversation, saveTranscript } from '../../src/lib/workflow.js';
import { writeLine } from '../../src/lib/terminal.js';

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockFindProjectRoot = vi.mocked(findProjectRoot);
const mockLoadSquad = vi.mocked(loadSquad);
const mockListSquads = vi.mocked(listSquads);
const mockFindSimilarSquads = vi.mocked(findSimilarSquads);
const mockPreflight = vi.mocked(preflightExecutorCheck);
const mockRunConversation = vi.mocked(runConversation);
const mockSaveTranscript = vi.mocked(saveTranscript);
const mockWriteLine = vi.mocked(writeLine);

function makeExitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
    throw new Error('process.exit');
  });
}

const SQUADS_DIR = '/project/.agents/squads';
const PROJECT_ROOT = '/project';

describe('tokenize', () => {
  it('lowercases, strips short words and stopwords', () => {
    const tokens = tokenize('The Growth Squad drives Acquisition and Retention with your Funnel');
    expect(tokens).toContain('growth');
    expect(tokens).toContain('acquisition');
    expect(tokens).toContain('retention');
    expect(tokens).toContain('funnel');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('and');
    expect(tokens).not.toContain('your');
    expect(tokens).not.toContain('squad'); // stripped as a domain stopword
  });
});

describe('selectSquad (#983 — deterministic keyword overlap)', () => {
  afterEach(() => fakeFiles.clear());

  it('picks the squad whose SQUAD.md overlaps most with the product signal', () => {
    fakeFiles.set(join('/squads', 'growth', 'SQUAD.md'), 'Growth squad: acquisition, activation, retention, referral, revenue funnel optimization');
    fakeFiles.set(join('/squads', 'engineering', 'SQUAD.md'), 'Engineering squad: build pipelines, fix bugs, ship releases, run tests');

    const ctx: ProposeContext = {
      businessBrief: 'Our focus this quarter is acquisition and retention across the referral funnel.',
      readme: '', packageDescriptor: '', productIntent: '', recentCommits: '',
    };

    const picked = selectSquad(ctx, '/squads', ['growth', 'engineering']);
    expect(picked).toBe('growth');
  });

  it('breaks ties alphabetically', () => {
    fakeFiles.set(join('/squads', 'alpha', 'SQUAD.md'), 'Nothing relevant here at all');
    fakeFiles.set(join('/squads', 'beta', 'SQUAD.md'), 'Nothing relevant here at all either');

    const ctx: ProposeContext = { businessBrief: '', readme: '', packageDescriptor: '', productIntent: '', recentCommits: '' };
    expect(selectSquad(ctx, '/squads', ['beta', 'alpha'])).toBe('alpha');
  });

  it('returns null when there are no squads', () => {
    const ctx: ProposeContext = { businessBrief: '', readme: '', packageDescriptor: '', productIntent: '', recentCommits: '' };
    expect(selectSquad(ctx, '/squads', [])).toBeNull();
  });
});

describe('assembleProposeContext', () => {
  afterEach(() => fakeFiles.clear());

  it('reads BUSINESS_BRIEF.md, README.md, package.json and recent commits', () => {
    fakeFiles.set(join(PROJECT_ROOT, '.agents', 'BUSINESS_BRIEF.md'), '# Business Brief\nFocus on retention.');
    fakeFiles.set(join(PROJECT_ROOT, 'README.md'), '# Demo Product\nA thing that does stuff.');
    fakeFiles.set(join(PROJECT_ROOT, 'package.json'), JSON.stringify({ name: 'demo', description: 'a demo product' }));

    const ctx = assembleProposeContext(PROJECT_ROOT, SQUADS_DIR);
    expect(ctx.businessBrief).toContain('Focus on retention');
    expect(ctx.readme).toContain('Demo Product');
    expect(ctx.packageDescriptor).toBe('demo — a demo product');
    expect(ctx.recentCommits).toContain('initial commit');
  });

  it('degrades gracefully when files are missing or package.json is malformed', () => {
    fakeFiles.set(join(PROJECT_ROOT, 'package.json'), '{not valid json');
    const ctx = assembleProposeContext(PROJECT_ROOT, SQUADS_DIR);
    expect(ctx.businessBrief).toBe('');
    expect(ctx.readme).toBe('');
    expect(ctx.packageDescriptor).toBe('');
    expect(ctx.productIntent).toBe('');
  });
});

describe('proposeCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fakeFiles.clear();
    exitSpy = makeExitSpy();
    mockFindSquadsDir.mockReturnValue(SQUADS_DIR);
    mockFindProjectRoot.mockReturnValue(PROJECT_ROOT);
    mockListSquads.mockReturnValue(['demo']);
    mockLoadSquad.mockReturnValue({
      name: 'demo', dir: 'demo', mission: 'test', agents: [], pipelines: [],
      triggers: { scheduled: [], event: [], manual: [] }, routines: [], dependencies: [],
      outputPath: '', providers: { default: 'anthropic' },
    } as unknown as ReturnType<typeof loadSquad>);
    mockPreflight.mockResolvedValue(true);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits 1 when no .agents/squads directory is found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    await expect(proposeCommand({})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when no squads are configured', async () => {
    mockListSquads.mockReturnValue([]);
    await expect(proposeCommand({})).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 with a suggestion when --squad does not exist', async () => {
    mockListSquads.mockReturnValue(['growth', 'engineering']);
    mockFindSimilarSquads.mockReturnValue(['growth']);
    await expect(proposeCommand({ squad: 'grwoth' })).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const calls = mockWriteLine.mock.calls.map((c) => String(c[0]));
    expect(calls.some((m) => m.includes('not found'))).toBe(true);
    expect(calls.some((m) => m.includes('growth'))).toBe(true);
    expect(mockRunConversation).not.toHaveBeenCalled();
  });

  it('exits 1 loud (fail-fast) when provider preflight fails — never dispatches', async () => {
    mockPreflight.mockResolvedValue(false);
    await expect(proposeCommand({ squad: 'demo' })).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockRunConversation).not.toHaveBeenCalled();
  });

  it('dispatches exactly one bounded run with the proposal branch prefix and default cost ceiling', async () => {
    await proposeCommand({ squad: 'demo' });

    expect(mockRunConversation).toHaveBeenCalledTimes(1);
    const [, convOptions] = mockRunConversation.mock.calls[0];
    expect(convOptions.branchPrefix).toBe(PROPOSAL_BRANCH_PREFIX);
    expect(convOptions.costCeiling).toBe(DEFAULT_PROPOSE_COST_CEILING);
    expect(typeof convOptions.task).toBe('string');
    expect(convOptions.task).toContain('Do NOT open a pull request');
    expect(mockSaveTranscript).toHaveBeenCalledTimes(1);
  });

  it('respects a --cost-ceiling override', async () => {
    await proposeCommand({ squad: 'demo', costCeiling: '12.5' });
    const [, convOptions] = mockRunConversation.mock.calls[0];
    expect(convOptions.costCeiling).toBe(12.5);
  });

  it('emits machine-readable JSON with --json', async () => {
    await proposeCommand({ squad: 'demo', json: true });
    const jsonCall = mockWriteLine.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith('{'));
    expect(jsonCall).toBeTruthy();
    const parsed = JSON.parse(jsonCall!);
    expect(parsed).toMatchObject({ squad: 'demo', costCeiling: DEFAULT_PROPOSE_COST_CEILING, converged: true, reason: 'Cycle complete' });
  });
});
