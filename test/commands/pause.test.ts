import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(() => '/project/.agents/squads'),
  loadSquad: vi.fn(() => null),
  listSquads: vi.fn(() => []),
  findSimilarSquads: vi.fn(() => []),
  setSquadPauseState: vi.fn(() => true),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn(() => Promise.resolve()),
  Events: { CLI_STATUS: 'cli_status' },
  flushEvents: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '', red: '', green: '', yellow: '', purple: '', cyan: '', white: '', bold: '',
  },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  icons: { success: '✓', error: '✗', warning: '!', progress: '›', empty: '○', bullet: '•' },
}));

// ── Imports ───────────────────────────────────────────────────────────────────
import { pauseCommand, resumeCommand } from '../../src/commands/pause.js';
import {
  findSquadsDir,
  loadSquad,
  setSquadPauseState,
} from '../../src/lib/squad-parser.js';
import { writeLine } from '../../src/lib/terminal.js';

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockLoadSquad = vi.mocked(loadSquad);
const mockSetSquadPauseState = vi.mocked(setSquadPauseState);
const mockWriteLine = vi.mocked(writeLine);

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeExitSpy() {
  return vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
    throw new Error('process.exit');
  });
}

function makeActiveSquad(overrides: Record<string, unknown> = {}) {
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
    status: undefined,
    paused_since: undefined,
    paused_reason: undefined,
    frontmatter: {},
    ...overrides,
  };
}

function makePausedSquad(reason?: string) {
  return makeActiveSquad({
    status: 'paused',
    paused_since: '2026-06-14T10:00:00.000Z',
    paused_reason: reason,
  });
}

// ── Tests: pauseCommand ───────────────────────────────────────────────────────
describe('pauseCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
    mockSetSquadPauseState.mockReturnValue(true);
    exitSpy = makeExitSpy();
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits with code 1 when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    await expect(pauseCommand('engineering')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    await expect(pauseCommand('nonexistent')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when squad is already paused', async () => {
    mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof loadSquad>);
    await expect(pauseCommand('engineering')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    const calls = mockWriteLine.mock.calls.map(c => c[0]);
    expect(calls.some(msg => msg?.toString().includes('already paused'))).toBe(true);
  });

  it('calls setSquadPauseState with paused=true when squad is active', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    await pauseCommand('engineering');
    expect(mockSetSquadPauseState).toHaveBeenCalledWith('engineering', true, undefined);
  });

  it('calls setSquadPauseState with reason when --reason provided', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    await pauseCommand('engineering', { reason: 'waiting for design' });
    expect(mockSetSquadPauseState).toHaveBeenCalledWith('engineering', true, 'waiting for design');
  });

  it('exits with code 1 when setSquadPauseState returns false', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    mockSetSquadPauseState.mockReturnValue(false);
    await expect(pauseCommand('engineering')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('shows pause confirmation message', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    await pauseCommand('engineering');
    const calls = mockWriteLine.mock.calls.map(c => c[0]);
    expect(calls.some(msg => msg?.toString().includes('paused'))).toBe(true);
  });

  it('outputs JSON when --json flag is set', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await pauseCommand('engineering', { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(output.command).toBe('pause');
    consoleSpy.mockRestore();
  });

  // ── Issue #885: command field in error JSON responses ──────────────────────

  it('includes command field in JSON error when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(pauseCommand('engineering', { json: true })).rejects.toThrow('process.exit');
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.command).toBe('pause');
    consoleSpy.mockRestore();
  });

  it('includes command field in JSON error when squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(pauseCommand('engineering', { json: true })).rejects.toThrow('process.exit');
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.command).toBe('pause');
    consoleSpy.mockRestore();
  });

  it('includes command field in JSON error when squad already paused', async () => {
    mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof loadSquad>);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(pauseCommand('engineering', { json: true })).rejects.toThrow('process.exit');
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.command).toBe('pause');
    consoleSpy.mockRestore();
  });

  it('includes command field in JSON error when write fails', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    mockSetSquadPauseState.mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(pauseCommand('engineering', { json: true })).rejects.toThrow('process.exit');
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.command).toBe('pause');
    consoleSpy.mockRestore();
  });
});

// ── Tests: resumeCommand ──────────────────────────────────────────────────────
describe('resumeCommand', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockFindSquadsDir.mockReturnValue('/project/.agents/squads');
    mockSetSquadPauseState.mockReturnValue(true);
    exitSpy = makeExitSpy();
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('exits with code 1 when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    await expect(resumeCommand('engineering')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    await expect(resumeCommand('nonexistent')).rejects.toThrow('process.exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Issue #884: guard setSquadPauseState — idempotent no-op when not paused ─

  it('returns cleanly when squad is not paused (idempotent no-op)', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    await expect(resumeCommand('engineering')).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
    const calls = mockWriteLine.mock.calls.map(c => c[0]);
    expect(calls.some(msg => msg?.toString().includes('not paused'))).toBe(true);
  });

  it('does not call setSquadPauseState when squad is not paused', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    await resumeCommand('engineering');
    expect(mockSetSquadPauseState).not.toHaveBeenCalled();
  });

  it('outputs noop JSON when --json and squad is not paused', async () => {
    mockLoadSquad.mockReturnValue(makeActiveSquad() as ReturnType<typeof loadSquad>);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await resumeCommand('engineering', { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(output.command).toBe('resume');
    expect(output.action).toBe('noop');
    consoleSpy.mockRestore();
  });

  it('calls setSquadPauseState with paused=false when squad is paused', async () => {
    mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof loadSquad>);
    await resumeCommand('engineering');
    expect(mockSetSquadPauseState).toHaveBeenCalledWith('engineering', false);
  });

  it('shows resume confirmation message', async () => {
    mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof loadSquad>);
    await resumeCommand('engineering');
    const calls = mockWriteLine.mock.calls.map(c => c[0]);
    expect(calls.some(msg => msg?.toString().includes('active'))).toBe(true);
  });

  it('outputs JSON when --json flag is set', async () => {
    mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof loadSquad>);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await resumeCommand('engineering', { json: true });
    expect(consoleSpy).toHaveBeenCalled();
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(true);
    expect(output.command).toBe('resume');
    consoleSpy.mockRestore();
  });

  // ── Issue #885: command field in error JSON responses ──────────────────────

  it('includes command field in JSON error when no squads dir found', async () => {
    mockFindSquadsDir.mockReturnValue(null);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(resumeCommand('engineering', { json: true })).rejects.toThrow('process.exit');
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.command).toBe('resume');
    consoleSpy.mockRestore();
  });

  it('includes command field in JSON error when squad not found', async () => {
    mockLoadSquad.mockReturnValue(null);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(resumeCommand('nonexistent', { json: true })).rejects.toThrow('process.exit');
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.command).toBe('resume');
    consoleSpy.mockRestore();
  });

  it('includes command field in JSON error when write fails', async () => {
    mockLoadSquad.mockReturnValue(makePausedSquad() as ReturnType<typeof loadSquad>);
    mockSetSquadPauseState.mockReturnValue(false);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(resumeCommand('engineering', { json: true })).rejects.toThrow('process.exit');
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.ok).toBe(false);
    expect(output.command).toBe('resume');
    consoleSpy.mockRestore();
  });
});
