import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks (must be before imports) ─────────────────────────────────
vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(() => ({
    on: vi.fn(),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    stdin: { write: vi.fn(), end: vi.fn() },
    pid: 1234,
    kill: vi.fn(),
  })),
  execSync: vi.fn(() => Buffer.from('')),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  cpSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  loadSquad: vi.fn(() => null),
  listAgents: vi.fn(() => []),
  loadAgentDefinition: vi.fn(() => null),
  parseAgentProvider: vi.fn(() => 'anthropic'),
  listSquads: vi.fn(() => []),
  findSimilarSquads: vi.fn(() => []),
  EffortLevel: { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' },
}));

vi.mock('../../src/lib/mcp-config.js', () => ({
  resolveMcpConfigPath: vi.fn(() => ''),
}));

vi.mock('../../src/lib/permissions.js', () => ({
  buildContextFromSquad: vi.fn(() => ({})),
  validateExecution: vi.fn(() => ({ allowed: true, violations: [] })),
  formatViolations: vi.fn(() => ''),
}));

vi.mock('../../src/lib/memory.js', () => ({
  findMemoryDir: vi.fn(() => null),
  appendToMemory: vi.fn(),
  listMemoryEntries: vi.fn(() => []),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn(() => Promise.resolve()),
  Events: {
    CLI_RUN: 'cli_run',
    CLI_AGENT_RUN: 'cli_agent_run',
    CLI_RUN_COMPLETE: 'cli_run_complete',
    CLI_RUN_ERROR: 'cli_run_error',
  },
  flushEvents: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/cron.js', () => ({
  parseCooldown: vi.fn(() => null),
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
    bold: '',
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
    teeLeft: '┤',
    teeRight: '├',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
  icons: {
    success: '✓',
    error: '✗',
    warning: '!',
    progress: '›',
    empty: '○',
    bullet: '•',
  },
}));

vi.mock('../../src/lib/llm-clis.js', () => ({
  getCLIConfig: vi.fn(() => undefined),
  isProviderCLIAvailable: vi.fn(() => true),
  normalizeProviderName: vi.fn((provider: string) => provider),
}));

vi.mock('../../src/lib/providers.js', () => ({
  detectProviderFromModel: vi.fn(() => 'anthropic'),
}));

vi.mock('../../src/lib/auth.js', () => ({
  loadSession: vi.fn(() => null),
  isLoggedIn: vi.fn(() => false),
}));

vi.mock('../../src/lib/env-config.js', () => ({
  getApiUrl: vi.fn(() => null),
  getBridgeUrl: vi.fn(() => null),
}));

vi.mock('../../src/lib/workflow.js', () => ({
  runConversation: vi.fn(() => Promise.resolve({ success: true, turns: 0 })),
  saveTranscript: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/api-client.js', () => ({
  reportExecutionStart: vi.fn(() => Promise.resolve()),
  reportConversationResult: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/github.js', () => ({
  getBotGitEnv: vi.fn(() => ({})),
  getBotPushUrl: vi.fn(() => null),
  getBotGhEnv: vi.fn(() => ({})),
  getCoAuthorTrailer: vi.fn(() => ''),
}));

vi.mock('../../src/lib/squad-loop.js', () => ({
  loadLoopState: vi.fn(() => ({})),
  saveLoopState: vi.fn(),
  getSquadRepos: vi.fn(() => []),
  scoreSquads: vi.fn(() => []),
  checkCooldown: vi.fn(() => false),
  classifyRunOutcome: vi.fn(() => 'completed'),
  slackNotify: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/cognition.js', () => ({
  loadCognitionState: vi.fn(() => ({})),
  saveCognitionState: vi.fn(),
  seedBeliefsIfEmpty: vi.fn(),
  runCognitionCycle: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/run-context.js', () => ({
  parseAgentFrontmatter: vi.fn(() => ({})),
  extractMcpServersFromDefinition: vi.fn(() => []),
  loadApprovalInstructions: vi.fn(() => ''),
  loadPostExecution: vi.fn(() => null),
  gatherSquadContext: vi.fn(() => ''),
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────
import { runCommand, runSquadCommand, mergeAgentPositional } from '../../src/commands/run.js';
import { findSquadsDir, loadSquad, listAgents, findSimilarSquads } from '../../src/lib/squad-parser.js';
import { writeLine } from '../../src/lib/terminal.js';
import { isProviderCLIAvailable } from '../../src/lib/llm-clis.js';

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockLoadSquad = vi.mocked(loadSquad);
const mockListAgents = vi.mocked(listAgents);
const mockFindSimilarSquads = vi.mocked(findSimilarSquads);
const mockWriteLine = vi.mocked(writeLine);
const mockIsProviderCLIAvailable = vi.mocked(isProviderCLIAvailable);

// ── Helpers ────────────────────────────────────────────────────────────────
function makeExitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
    throw new Error('process.exit');
  });
}

// ── Tests: runCommand ──────────────────────────────────────────────────────
describe('runCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SQUADS_SKIP_CHECKS = '1';
    exitSpy = makeExitSpy();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    delete process.env.SQUADS_SKIP_CHECKS;
  });

  describe('no squads directory', () => {
    it('exits with code 1 when no .agents/squads dir found', async () => {
      mockFindSquadsDir.mockReturnValue(null);

      await expect(runCommand('demo', {})).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('writes error message when no squads dir found', async () => {
      mockFindSquadsDir.mockReturnValue(null);

      await expect(runCommand('demo', {})).rejects.toThrow('process.exit');

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('No .agents/squads directory found')
      );
    });

    it('suggests squads init when no squads dir found', async () => {
      mockFindSquadsDir.mockReturnValue(null);

      await expect(runCommand('demo', {})).rejects.toThrow('process.exit');

      const calls = mockWriteLine.mock.calls.map(c => c[0]);
      expect(calls.some(msg => msg?.toString().includes('squads init'))).toBe(true);
    });
  });

  describe('--cloud flag', () => {
    it('exits with code 1 when --cloud used without agent name', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');

      await expect(runCommand('demo', { cloud: true })).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('writes --cloud requires agent error when no agent specified', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');

      await expect(runCommand('demo', { cloud: true })).rejects.toThrow('process.exit');

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('--cloud requires a specific agent')
      );
    });

    it('exits with code 1 when API URL not configured for cloud dispatch', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      // getApiUrl is mocked to return null

      // target includes agent via slash syntax → skips "no agent" error
      await expect(runCommand('demo/researcher', { cloud: true })).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('API URL not configured')
      );
    });

    it('parses slash syntax and extracts agent from target', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');

      // With slash syntax, agentName is set from the second part
      // This leads to runCloudDispatch → exits with "API URL not configured"
      // rather than "--cloud requires a specific agent"
      await expect(runCommand('squad/agent', { cloud: true })).rejects.toThrow('process.exit');

      const cloudRequiresAgentCalled = mockWriteLine.mock.calls
        .some(c => c[0]?.toString().includes('--cloud requires a specific agent'));
      expect(cloudRequiresAgentCalled).toBe(false);
    });

    it('uses options.agent over slash syntax when both provided', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');

      // explicit --agent overrides slash-parsed agent
      await expect(
        runCommand('squad/ignored', { cloud: true, agent: 'explicit-agent' })
      ).rejects.toThrow('process.exit');

      // Should reach runCloudDispatch (no "requires agent" error), exits on missing API URL
      const cloudRequiresAgentCalled = mockWriteLine.mock.calls
        .some(c => c[0]?.toString().includes('--cloud requires a specific agent'));
      expect(cloudRequiresAgentCalled).toBe(false);
    });
  });

  describe('target not found', () => {
    it('exits with code 1 when squad and agent not found', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockListAgents.mockReturnValue([]);
      mockFindSimilarSquads.mockReturnValue([]);

      await expect(runCommand('nonexistent', { dryRun: true })).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('writes target not found error message', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockListAgents.mockReturnValue([]);
      mockFindSimilarSquads.mockReturnValue([]);

      await expect(runCommand('ghost-squad', { dryRun: true })).rejects.toThrow('process.exit');

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('"ghost-squad" not found')
      );
    });

    it('shows similar squad suggestions when available', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockListAgents.mockReturnValue([]);
      mockFindSimilarSquads.mockReturnValue(['cli', 'website']);

      await expect(runCommand('clii', { dryRun: true })).rejects.toThrow('process.exit');

      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('cli, website')
      );
    });

    it('does not show suggestions line when no similar squads found', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockListAgents.mockReturnValue([]);
      mockFindSimilarSquads.mockReturnValue([]);

      await expect(runCommand('xyz', { dryRun: true })).rejects.toThrow('process.exit');

      const didShowSuggestions = mockWriteLine.mock.calls
        .some(c => c[0]?.toString().includes('Did you mean'));
      expect(didShowSuggestions).toBe(false);
    });

    it('exits when target not found even with execute flag', async () => {
      // SQUADS_SKIP_CHECKS=1 bypasses preflight; target not found → exit(1)
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockListAgents.mockReturnValue([]);
      mockFindSimilarSquads.mockReturnValue([]);

      await expect(runCommand('nonexistent', { execute: true })).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('suggests squads status command when target not found', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockListAgents.mockReturnValue([]);
      mockFindSimilarSquads.mockReturnValue([]);

      await expect(runCommand('missing', { dryRun: true })).rejects.toThrow('process.exit');

      const calls = mockWriteLine.mock.calls.map(c => c[0]);
      expect(calls.some(msg => msg?.toString().includes('squads status'))).toBe(true);
    });
  });

  describe('paused squad enforcement', () => {
    function makePausedSquad(reason?: string) {
      return {
        name: 'engineering',
        dir: 'engineering',
        mission: 'Build things',
        agents: [],
        pipelines: [],
        triggers: { scheduled: [], event: [], manual: [] },
        routines: [],
        dependencies: [],
        outputPath: '',
        goals: [],
        status: 'paused',
        paused_since: '2026-06-14T10:00:00.000Z',
        paused_reason: reason,
        frontmatter: {},
      };
    }

    it('exits with code 1 when squad is paused without --force', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof mockLoadSquad>);

      await expect(runCommand('engineering', { dryRun: true })).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('shows paused message when squad is paused', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof mockLoadSquad>);

      await expect(runCommand('engineering', { dryRun: true })).rejects.toThrow('process.exit');

      const calls = mockWriteLine.mock.calls.map(c => c[0]);
      expect(calls.some(msg => msg?.toString().includes('paused'))).toBe(true);
    });

    it('shows reason in paused message when paused_reason is set', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(makePausedSquad('waiting for design') as ReturnType<typeof mockLoadSquad>);

      await expect(runCommand('engineering', { dryRun: true })).rejects.toThrow('process.exit');

      const calls = mockWriteLine.mock.calls.map(c => c[0]);
      expect(calls.some(msg => msg?.toString().includes('waiting for design'))).toBe(true);
    });

    it('shows --force override hint in paused message', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof mockLoadSquad>);

      await expect(runCommand('engineering', { dryRun: true })).rejects.toThrow('process.exit');

      const calls = mockWriteLine.mock.calls.map(c => c[0]);
      expect(calls.some(msg => msg?.toString().includes('--force'))).toBe(true);
    });

    it('proceeds with warning when --force overrides a paused squad', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof mockLoadSquad>);

      // With --force + dryRun, should NOT call exit(1) for pause enforcement;
      // may still exit for other reasons (no agents found etc.) — just check
      // that the pause-enforcement exit path was NOT taken.
      try {
        await runCommand('engineering', { dryRun: true, force: true });
      } catch {
        // May throw for unrelated reasons — just ensure no "paused" exit
      }

      const calls = mockWriteLine.mock.calls.map(c => c[0]);
      // The force-warning line is shown but process should not have been exited
      // for the pause check (may still exit for dry-run/no-agents reasons)
      const showedForceWarning = calls.some(msg => msg?.toString().includes('Warning: running paused squad'));
      expect(showedForceWarning).toBe(true);
    });
  });

  describe('preflight check', () => {
    // The preflight only runs for a target that EXISTS (#912): a nonexistent
    // squad now reports "not found" BEFORE any executor CLI check, so these
    // tests mock a real squad to legitimately reach the provider gate.
    function makeDemoSquad() {
      return {
        name: 'demo',
        dir: 'demo',
        mission: 'Demo things',
        agents: [],
        pipelines: [],
        triggers: { scheduled: [], event: [], manual: [] },
        goals: [],
        status: 'active',
        frontmatter: {},
      };
    }

    it('exits with code 1 when non-anthropic provider CLI not found', async () => {
      delete process.env.SQUADS_SKIP_CHECKS;
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(makeDemoSquad() as ReturnType<typeof mockLoadSquad>);
      mockIsProviderCLIAvailable.mockReturnValue(false);

      await expect(
        runCommand('demo', { execute: true, provider: 'google' })
      ).rejects.toThrow('process.exit');

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('writes CLI not found error for missing provider', async () => {
      delete process.env.SQUADS_SKIP_CHECKS;
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(makeDemoSquad() as ReturnType<typeof mockLoadSquad>);
      mockIsProviderCLIAvailable.mockReturnValue(false);

      await expect(
        runCommand('demo', { execute: true, provider: 'ollama' })
      ).rejects.toThrow('process.exit');

      const calls = mockWriteLine.mock.calls.map(c => c[0]);
      expect(calls.some(msg => msg?.toString().includes('CLI not found'))).toBe(true);
    });

    it('reports "not found" (not a CLI error) for a nonexistent target (#912)', async () => {
      delete process.env.SQUADS_SKIP_CHECKS;
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockIsProviderCLIAvailable.mockReturnValue(false);

      await expect(
        runCommand('typo-squadd', { execute: true, provider: 'ollama' })
      ).rejects.toThrow('process.exit');

      const calls = mockWriteLine.mock.calls.map(c => c[0]?.toString() ?? '');
      expect(calls.some(msg => msg.includes('not found') && msg.includes('typo-squadd'))).toBe(true);
      expect(calls.some(msg => msg.includes('CLI not found'))).toBe(false);
    });

    it('skips preflight when dryRun is true', async () => {
      delete process.env.SQUADS_SKIP_CHECKS;
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockListAgents.mockReturnValue([]);
      mockFindSimilarSquads.mockReturnValue([]);
      mockIsProviderCLIAvailable.mockReturnValue(false); // would fail if called

      // dryRun bypasses preflight — reaches "not found" error instead of "CLI not found"
      await expect(runCommand('demo', { dryRun: true })).rejects.toThrow('process.exit');

      expect(mockIsProviderCLIAvailable).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('slash syntax parsing', () => {
    it('splits target on slash to extract squad and agent', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      mockLoadSquad.mockReturnValue(null);
      mockListAgents.mockReturnValue([]);
      mockFindSimilarSquads.mockReturnValue([]);

      // "engineering/issue-solver" → squad="engineering", agent="issue-solver"
      await expect(runCommand('engineering/issue-solver', { dryRun: true })).rejects.toThrow(
        'process.exit'
      );

      // loadSquad should be called with just the squad part
      expect(mockLoadSquad).toHaveBeenCalledWith('engineering');
    });

    it('preserves existing options.agent over slash-parsed agent', async () => {
      mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
      // cloud path lets us verify agent was NOT overwritten
      // getApiUrl returns null → exits at "API URL not configured"

      await expect(
        runCommand('demo/slash-agent', { cloud: true, agent: 'cli-agent' })
      ).rejects.toThrow('process.exit');

      // Should exit on API URL issue, not on "no agent" — meaning cli-agent was preserved
      expect(mockWriteLine).toHaveBeenCalledWith(
        expect.stringContaining('API URL not configured')
      );
    });
  });
});

// ── Tests: runSquadCommand ─────────────────────────────────────────────────
describe('runSquadCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SQUADS_SKIP_CHECKS = '1';
    exitSpy = makeExitSpy();
  });

  afterEach(() => {
    exitSpy.mockRestore();
    delete process.env.SQUADS_SKIP_CHECKS;
  });

  it('delegates to runCommand and exits when no squads dir', async () => {
    mockFindSquadsDir.mockReturnValue(null);

    await expect(runSquadCommand('demo', {})).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('delegates to runCommand and exits when target not found', async () => {
    mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
    mockLoadSquad.mockReturnValue(null);
    mockListAgents.mockReturnValue([]);
    mockFindSimilarSquads.mockReturnValue([]);

    await expect(runSquadCommand('ghost', { dryRun: true })).rejects.toThrow('process.exit');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mockWriteLine).toHaveBeenCalledWith(expect.stringContaining('"ghost" not found'));
  });

  it('passes options through to runCommand', async () => {
    mockFindSquadsDir.mockReturnValue('/project/.agents/squads');

    // cloud=true, no agent → exits with "--cloud requires agent" error
    await expect(runSquadCommand('demo', { cloud: true })).rejects.toThrow('process.exit');

    expect(mockWriteLine).toHaveBeenCalledWith(
      expect.stringContaining('--cloud requires a specific agent')
    );
  });
});

// ── mergeAgentPositional (#858) ────────────────────────────────────────────
describe('mergeAgentPositional', () => {
  it('rewrites squad + agent positionals to slash notation', () => {
    expect(mergeAgentPositional('research', 'weekly-reporter', undefined))
      .toEqual({ target: 'research/weekly-reporter' });
  });

  it('passes target through when no agent positional given', () => {
    expect(mergeAgentPositional('research', undefined, undefined))
      .toEqual({ target: 'research' });
    expect(mergeAgentPositional(null, undefined, undefined))
      .toEqual({ target: null });
  });

  it('errors when positional conflicts with --agent flag', () => {
    const result = mergeAgentPositional('research', 'weekly-reporter', 'housekeeper');
    expect(result.target).toBe('research');
    expect(result.error).toContain('Conflicting agents');
  });

  it('rewrites when positional and --agent flag name the same agent', () => {
    expect(mergeAgentPositional('research', 'weekly-reporter', 'weekly-reporter'))
      .toEqual({ target: 'research/weekly-reporter' });
  });

  it('errors when target already has a different agent via slash', () => {
    const result = mergeAgentPositional('research/housekeeper', 'weekly-reporter', undefined);
    expect(result.target).toBe('research/housekeeper');
    expect(result.error).toContain('already names an agent');
  });

  it('accepts a redundant positional matching the slash agent', () => {
    expect(mergeAgentPositional('research/weekly-reporter', 'weekly-reporter', undefined))
      .toEqual({ target: 'research/weekly-reporter' });
  });
});
