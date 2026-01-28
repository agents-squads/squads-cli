import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the terminal module to avoid actual console output
vi.mock('../src/lib/terminal.js', () => ({
  colors: {
    red: '',
    green: '',
    yellow: '',
    cyan: '',
    purple: '',
    white: '',
    dim: '',
  },
  bold: '',
  RESET: '',
  gradient: (text: string) => text,
  box: {
    topLeft: '+',
    topRight: '+',
    bottomLeft: '+',
    bottomRight: '+',
    horizontal: '-',
    vertical: '|',
    teeLeft: '+',
    teeRight: '+',
  },
  padEnd: (str: string, len: number) => str.padEnd(len),
  icons: {
    active: '*',
    pending: '-',
    success: 'v',
    error: 'x',
    warning: '!',
    progress: '>',
    empty: 'o',
  },
  writeLine: vi.fn(),
}));

// Mock telemetry
vi.mock('../src/lib/telemetry.js', () => ({
  track: vi.fn(),
  Events: { CLI_STATUS: 'cli_status' },
}));

// Mock update check
vi.mock('../src/lib/update.js', () => ({
  checkForUpdate: () => ({ updateAvailable: false }),
}));

// Mock sessions
vi.mock('../src/lib/sessions.js', () => ({
  getLiveSessionSummaryAsync: async () => ({
    totalSessions: 0,
    squadCount: 0,
    byTool: {},
  }),
  cleanupStaleSessions: vi.fn(),
}));

import {
  findSquadsDir,
  listSquads,
  listAgents,
  loadSquad,
} from '../src/lib/squad-parser.js';

import { findMemoryDir, getSquadState } from '../src/lib/memory.js';

describe('status command utilities', () => {
  let tempDir: string;
  let squadsDir: string;
  let memoryDir: string;
  let originalCwd: string;

  beforeEach(() => {
    const rawTempDir = mkdtempSync(join(tmpdir(), 'squads-status-test-'));
    tempDir = realpathSync(rawTempDir);
    squadsDir = join(tempDir, '.agents', 'squads');
    memoryDir = join(tempDir, '.agents', 'memory');
    mkdirSync(squadsDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    originalCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('status data gathering', () => {
    it('lists squads with their agents', () => {
      // Create squads with agents
      mkdirSync(join(squadsDir, 'cli'), { recursive: true });
      writeFileSync(join(squadsDir, 'cli', 'SQUAD.md'), `---
name: CLI
mission: Build CLI
---
`);
      writeFileSync(join(squadsDir, 'cli', 'solver.md'), '# Solver');
      writeFileSync(join(squadsDir, 'cli', 'reviewer.md'), '# Reviewer');

      mkdirSync(join(squadsDir, 'web'), { recursive: true });
      writeFileSync(join(squadsDir, 'web', 'SQUAD.md'), `---
name: Web
mission: Build web
---
`);
      writeFileSync(join(squadsDir, 'web', 'builder.md'), '# Builder');

      const squads = listSquads(squadsDir);
      expect(squads).toHaveLength(2);

      const cliAgents = listAgents(squadsDir, 'cli');
      expect(cliAgents).toHaveLength(2);

      const webAgents = listAgents(squadsDir, 'web');
      expect(webAgents).toHaveLength(1);
    });

    it('loads squad goals for status display', () => {
      mkdirSync(join(squadsDir, 'cli'), { recursive: true });
      writeFileSync(join(squadsDir, 'cli', 'SQUAD.md'), `---
name: CLI
---

## Goals

- [x] Complete v1.0
- [ ] Add testing (progress: 60% done)
- [ ] Documentation
`);

      const squad = loadSquad('cli');
      expect(squad?.goals).toHaveLength(3);

      const completed = squad?.goals.filter(g => g.completed).length || 0;
      const active = squad?.goals.filter(g => !g.completed).length || 0;

      expect(completed).toBe(1);
      expect(active).toBe(2);
    });

    it('tracks memory activity by squad', () => {
      // Create memory entries
      mkdirSync(join(memoryDir, 'cli', 'solver'), { recursive: true });
      writeFileSync(
        join(memoryDir, 'cli', 'solver', 'state.md'),
        '# State\nUpdated: 2026-01-27\n'
      );

      mkdirSync(join(squadsDir, 'cli'), { recursive: true });
      writeFileSync(join(squadsDir, 'cli', 'SQUAD.md'), '# CLI');

      const states = getSquadState('cli');
      expect(states).toHaveLength(1);
      expect(states[0].agent).toBe('solver');
    });
  });

  describe('goal statistics calculation', () => {
    it('calculates correct goal stats across squads', () => {
      // Squad 1: 2 goals, 1 completed
      mkdirSync(join(squadsDir, 'squad1'), { recursive: true });
      writeFileSync(join(squadsDir, 'squad1', 'SQUAD.md'), `---
name: Squad 1
---

## Goals

- [x] Done
- [ ] In progress
`);

      // Squad 2: 3 goals, 2 completed
      mkdirSync(join(squadsDir, 'squad2'), { recursive: true });
      writeFileSync(join(squadsDir, 'squad2', 'SQUAD.md'), `---
name: Squad 2
---

## Goals

- [x] Done 1
- [x] Done 2
- [ ] Todo
`);

      const squads = listSquads(squadsDir);
      let totalGoals = 0;
      let completedGoals = 0;

      for (const name of squads) {
        const squad = loadSquad(name);
        if (squad?.goals) {
          totalGoals += squad.goals.length;
          completedGoals += squad.goals.filter(g => g.completed).length;
        }
      }

      expect(totalGoals).toBe(5);
      expect(completedGoals).toBe(3);
    });

    it('handles squads with no goals', () => {
      mkdirSync(join(squadsDir, 'empty'), { recursive: true });
      writeFileSync(join(squadsDir, 'empty', 'SQUAD.md'), `---
name: Empty
---
`);

      const squad = loadSquad('empty');
      expect(squad?.goals).toEqual([]);
    });
  });
});

describe('status table formatting helpers', () => {
  /**
   * Calculate activity display based on last modification time
   */
  function formatActivityTime(lastModified: number | null): { text: string; recency: 'recent' | 'moderate' | 'old' } {
    if (lastModified === null) {
      return { text: '—', recency: 'old' };
    }

    const daysAgo = Math.floor((Date.now() - lastModified) / (1000 * 60 * 60 * 24));

    if (daysAgo === 0) {
      return { text: 'today', recency: 'recent' };
    } else if (daysAgo === 1) {
      return { text: 'yesterday', recency: 'recent' };
    } else if (daysAgo < 7) {
      return { text: `${daysAgo}d ago`, recency: 'moderate' };
    } else {
      return { text: `${daysAgo}d ago`, recency: 'old' };
    }
  }

  /**
   * Format goal progress display
   */
  function formatGoalProgress(completed: number, total: number): string {
    if (total === 0) return '—';
    return `${completed}/${total}`;
  }

  it('formats today activity', () => {
    const now = Date.now();
    const result = formatActivityTime(now);
    expect(result.text).toBe('today');
    expect(result.recency).toBe('recent');
  });

  it('formats yesterday activity', () => {
    const yesterday = Date.now() - 24 * 60 * 60 * 1000;
    const result = formatActivityTime(yesterday);
    expect(result.text).toBe('yesterday');
    expect(result.recency).toBe('recent');
  });

  it('formats days ago activity', () => {
    const threeDays = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const result = formatActivityTime(threeDays);
    expect(result.text).toBe('3d ago');
    expect(result.recency).toBe('moderate');
  });

  it('formats old activity', () => {
    const twoWeeks = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const result = formatActivityTime(twoWeeks);
    expect(result.text).toBe('14d ago');
    expect(result.recency).toBe('old');
  });

  it('handles null activity', () => {
    const result = formatActivityTime(null);
    expect(result.text).toBe('—');
    expect(result.recency).toBe('old');
  });

  it('formats goal progress', () => {
    expect(formatGoalProgress(3, 5)).toBe('3/5');
    expect(formatGoalProgress(0, 5)).toBe('0/5');
    expect(formatGoalProgress(5, 5)).toBe('5/5');
    expect(formatGoalProgress(0, 0)).toBe('—');
  });
});
