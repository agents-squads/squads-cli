import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../src/lib/squad-parser.js', () => ({
  findSquadsDir: vi.fn(),
  listSquads: vi.fn(),
  loadSquad: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', purple: '', cyan: '' },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  box: {
    topLeft: '┌', topRight: '┐', bottomLeft: '└', bottomRight: '┘',
    vertical: '│', horizontal: '─', teeLeft: '┤', teeRight: '├',
  },
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
  truncate: vi.fn((s: string) => s),
  icons: { progress: '◉', empty: '○' },
}));

import { resultsCommand } from '../../src/commands/results.js';
import { findSquadsDir, listSquads, loadSquad } from '../../src/lib/squad-parser.js';
import { execSync } from 'child_process';

const mockFindSquadsDir = vi.mocked(findSquadsDir);
const mockListSquads = vi.mocked(listSquads);
const mockLoadSquad = vi.mocked(loadSquad);
const mockExecSync = vi.mocked(execSync);

const sampleSquad = {
  name: 'engineering',
  goals: [
    { description: 'Ship v0.7.0', metrics: ['prs_merged'], completed: false },
    { description: 'Reduce costs', metrics: ['cost_usd'], completed: true },
  ],
  context: {},
  agents: [],
  routines: [],
};

describe('resultsCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindSquadsDir.mockReturnValue('/test/.agents/squads');
    mockListSquads.mockReturnValue(['engineering']);
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);
    mockExecSync.mockReturnValue('' as ReturnType<typeof execSync>);
  });

  it('resolves without error with default options', async () => {
    await expect(resultsCommand()).resolves.toBeUndefined();
  });

  it('resolves when no .agents directory found', async () => {
    mockFindSquadsDir.mockReturnValue(null);

    await expect(resultsCommand()).resolves.toBeUndefined();
  });

  it('resolves for a specific squad', async () => {
    await expect(resultsCommand({ squad: 'engineering' })).resolves.toBeUndefined();
  });

  it('resolves with verbose mode', async () => {
    await expect(resultsCommand({ verbose: true })).resolves.toBeUndefined();
  });

  it('resolves with custom days option', async () => {
    await expect(resultsCommand({ days: '30' })).resolves.toBeUndefined();
  });

  it('handles squad with no goals', async () => {
    mockLoadSquad.mockReturnValue({ ...sampleSquad, goals: [] } as ReturnType<typeof loadSquad>);

    await expect(resultsCommand()).resolves.toBeUndefined();
  });

  it('handles squad with only completed goals', async () => {
    mockLoadSquad.mockReturnValue({
      ...sampleSquad,
      goals: [{ description: 'Done', metrics: [], completed: true }],
    } as ReturnType<typeof loadSquad>);

    await expect(resultsCommand()).resolves.toBeUndefined();
  });

  it('handles squad not found via loadSquad', async () => {
    mockLoadSquad.mockReturnValue(null);

    await expect(resultsCommand()).resolves.toBeUndefined();
  });

  it('handles execSync throwing (not in git repo)', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('not a git repository');
    });

    await expect(resultsCommand()).resolves.toBeUndefined();
  });

  it('uses metrics from goal.metrics when present', async () => {
    mockLoadSquad.mockReturnValue({
      ...sampleSquad,
      goals: [{ description: 'Revenue goal', metrics: ['revenue_usd', 'leads'], completed: false }],
    } as ReturnType<typeof loadSquad>);

    await expect(resultsCommand({ squad: 'engineering', verbose: true })).resolves.toBeUndefined();
  });

  it('infers metrics from goal description when no metrics defined', async () => {
    mockLoadSquad.mockReturnValue({
      ...sampleSquad,
      goals: [{ description: 'Increase revenue and leads', metrics: [], completed: false }],
    } as ReturnType<typeof loadSquad>);

    await expect(resultsCommand({ squad: 'engineering', verbose: true })).resolves.toBeUndefined();
  });

  it('handles multiple squads', async () => {
    mockListSquads.mockReturnValue(['engineering', 'marketing', 'product']);
    mockLoadSquad.mockReturnValue(sampleSquad as ReturnType<typeof loadSquad>);

    await expect(resultsCommand()).resolves.toBeUndefined();
  });
});
