/**
 * Tests for src/lib/workflow.ts — squad conversation orchestration.
 *
 * Covers:
 * - runConversation: no squads dir, no lead agent, single lead, max cycle safety
 * - saveTranscript: creates file, returns path, handles no squads dir
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Helper: create a mock child process that emits stream-json output then closes.
// runIndependentAgent now spawns `claude --output-format stream-json`, so the
// mock emits the canonical terminal `result` event carrying the text + usage
// (mirroring real claude output) rather than a bare text blob.
function createMockChild(output: string, code = 0, usage?: Record<string, unknown>) {
  const child = new EventEmitter() as any;
  child.stdin = { write: vi.fn(), end: vi.fn() };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  const resultEvent = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: output,
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    num_turns: 1,
    is_error: false,
    ...usage,
  });
  // Emit output async so listeners are attached first
  process.nextTick(() => {
    if (output) child.stdout.emit('data', Buffer.from(resultEvent + '\n'));
    child.emit('close', code);
  });
  return child;
}

// Mock fs before import
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue(''),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  // writeSandboxSettingsFile (#931) stats the .git target and falls back to a
  // tmpdir on failure — treat the mocked path as a plain directory.
  statSync: vi.fn().mockReturnValue({ isDirectory: () => true }),
  mkdtempSync: vi.fn().mockReturnValue('/mock/tmp/squads-sandbox-x'),
}));

// Mock child_process before import — workflow.ts uses spawn for agent execution
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

// Mock squad-parser
vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  findProjectRoot: vi.fn().mockReturnValue('/mock/root'),
}));

// Mock observability to avoid file system reads
vi.mock('../../src/lib/observability.js', () => ({
  logObservability: vi.fn(),
  snapshotGoals: vi.fn().mockReturnValue({}),
  diffGoals: vi.fn().mockReturnValue([]),
}));

// Mock run-context to avoid file system reads in unit tests
vi.mock('../../src/lib/run-context.js', () => ({
  gatherSquadContext: vi.fn().mockReturnValue(''),
  resolveContextRoleFromAgent: vi.fn().mockReturnValue('lead'),
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
import { spawn, execSync } from 'child_process';
import { findSquadsDir } from '../../src/lib/squad-parser.js';
import { runConversation, saveTranscript, buildAgentRoster } from '../../src/lib/workflow.js';
import { createTranscript, addTurn } from '../../src/lib/conversation.js';
import type { Squad } from '../../src/lib/squad-parser.js';

const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockSpawn = vi.mocked(spawn);
const mockExecSync = vi.mocked(execSync);
const mockFindSquadsDir = vi.mocked(findSquadsDir);

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
    mockSpawn.mockImplementation(() => createMockChild('Session complete. All PRs merged.') as any);

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
    mockSpawn.mockImplementation(() => createMockChild('Still working on it.') as any);

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
    mockSpawn.mockImplementation(() => createMockChild('Still working on it.') as any);

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
      const child = createMockChild('Session complete.');
      child.stdin.write = vi.fn((data: string) => { capturedPrompts.push(data); return true; });
      return child as any;
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

    mockSpawn.mockImplementation(() => createMockChild('Session complete.') as any);

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

    mockSpawn.mockImplementation(() => createMockChild('Session complete.') as any);

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

  it('deliver-and-stop gate: stops when a PR already addresses the --task issue, even though turn/cost ceilings alone would not', async () => {
    mockFindSquadsDir.mockReturnValue('/fake/.agents/squads');
    mockExistsSync.mockReturnValue(true);

    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('gh pr list')) {
        return JSON.stringify([
          { number: 951, title: 'fix: issue-951 gate', body: 'Closes #951', state: 'MERGED' },
        ]);
      }
      return '';
    });

    // Every turn is non-convergent — proves the gate (not the turn/cost ceiling,
    // both far from being hit) is what stops the run.
    mockSpawn.mockImplementation(() => createMockChild('Still working on it.') as any);

    const squad = makeSquad({
      repo: 'agents-squads/squads-cli',
      agents: [{ name: 'squad-lead', role: 'orchestrates the team', model: undefined }],
    });

    const result = await runConversation(squad, {
      task: 'Fix #951',
      maxTurns: 100,
      costCeiling: 999,
      verbose: false,
    });

    expect(result.converged).toBe(true);
    expect(result.reason).toContain('951');
  });
});

// ─── buildAgentRoster (lead detection robustness, #449) ─────────────────────────

describe('buildAgentRoster', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true); // all agent .md files exist
  });

  it('detects a lead from a Spanish "Orquestador" role value', () => {
    const squad = makeSquad({
      name: 'client-graffo',
      dir: 'client-graffo',
      agents: [
        { name: 'client-graffo-lead', role: 'Orquestador — coordina el squad', model: undefined } as any,
        { name: 'finanzas-agent', role: 'P&L, F29, márgenes, flujo de caja', model: undefined } as any,
      ],
    });
    const roster = buildAgentRoster(squad, '/fake/.agents/squads');
    const lead = roster.find(a => a.role === 'lead');
    expect(lead).toBeDefined();
    expect(lead!.name).toBe('client-graffo-lead');
  });

  it('recognizes other Spanish role synonyms (verificador, escáner, trabajador)', () => {
    const squad = makeSquad({
      name: 'es-squad',
      dir: 'es-squad',
      agents: [
        { name: 'a', role: 'Orquestador del equipo', model: undefined } as any,
        { name: 'b', role: 'Escáner de oportunidades', model: undefined } as any,
        { name: 'c', role: 'Trabajador que entrega', model: undefined } as any,
        { name: 'd', role: 'Verificador de calidad', model: undefined } as any,
      ],
    });
    const roster = buildAgentRoster(squad, '/fake/.agents/squads');
    expect(roster.find(a => a.name === 'a')!.role).toBe('lead');
    expect(roster.find(a => a.name === 'b')!.role).toBe('scanner');
    expect(roster.find(a => a.name === 'c')!.role).toBe('worker');
    expect(roster.find(a => a.name === 'd')!.role).toBe('verifier');
  });

  it('falls back to NAME detection when no role tags a lead', () => {
    const squad = makeSquad({
      name: 'mystery',
      dir: 'mystery',
      agents: [
        // None of these roles classify as lead.
        { name: 'mystery-lead', role: 'does general stuff', model: undefined } as any,
        { name: 'helper-bot', role: 'builds things', model: undefined } as any,
      ],
    });
    const roster = buildAgentRoster(squad, '/fake/.agents/squads');
    const lead = roster.find(a => a.role === 'lead');
    expect(lead).toBeDefined();
    expect(lead!.name).toBe('mystery-lead');
  });

  it('name fallback matches any agent ending in -lead', () => {
    const squad = makeSquad({
      name: 'acme',
      dir: 'acme',
      agents: [
        { name: 'ops-lead', role: 'runs operations', model: undefined } as any,
        { name: 'helper', role: 'builds things', model: undefined } as any,
      ],
    });
    const roster = buildAgentRoster(squad, '/fake/.agents/squads');
    expect(roster.find(a => a.role === 'lead')!.name).toBe('ops-lead');
  });

  it('does not promote a -lead-named agent when a real lead is already classified', () => {
    // `worker-bot` ends in nothing lead-ish; the only lead is the orchestrator.
    // The name fallback must NOT fire (a lead already exists), so the worker
    // stays a worker rather than being promoted.
    const squad = makeSquad({
      name: 'dup',
      dir: 'dup',
      agents: [
        { name: 'real-orchestrator', role: 'orchestrates the team', model: undefined } as any,
        { name: 'worker-bot', role: 'builds things', model: undefined } as any,
      ],
    });
    const roster = buildAgentRoster(squad, '/fake/.agents/squads');
    const leads = roster.filter(a => a.role === 'lead');
    expect(leads).toHaveLength(1);
    expect(leads[0].name).toBe('real-orchestrator');
    expect(roster.find(a => a.name === 'worker-bot')!.role).toBe('worker');
  });

  it('taskMode trims the roster to lead + first non-eval/critic/tester worker, dropping scanners/verifiers (#951)', () => {
    const squad = makeSquad({
      name: 'cli',
      dir: 'cli',
      agents: [
        { name: 'cli-lead', role: 'orchestrates the team', model: undefined } as any,
        // Eval/critic/tester agents come FIRST here so the test actually
        // exercises the exclusion regex — if it were a no-op, one of these
        // (not issue-solver) would win as "first worker".
        { name: 'code-eval', role: 'evaluates code quality', model: undefined } as any,
        { name: 'cli-critic', role: 'critiques output', model: undefined } as any,
        { name: 'ux-tester', role: 'tests the UX', model: undefined } as any,
        { name: 'issue-solver', role: 'solves issues', model: undefined } as any,
      ],
    });
    const roster = buildAgentRoster(squad, '/fake/.agents/squads', { taskMode: true });
    expect(roster.map(a => a.name)).toEqual(['cli-lead', 'issue-solver']);
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
