/**
 * Tests for src/lib/observability.ts — goal tracking and diffing.
 *
 * Covers:
 * - snapshotGoals: no project root, missing file, parses status lines
 * - diffGoals: new goals, changed status, removed goals
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before import
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(),
}));

// Mock squad-parser — must include findProjectRoot used by snapshotGoals
vi.mock('../../src/lib/squad-parser.js', () => ({
  findProjectRoot: vi.fn().mockReturnValue(null),
  findSquadsDir: vi.fn(),
}));

import { existsSync, readFileSync } from 'fs';
import { findProjectRoot } from '../../src/lib/squad-parser.js';
import { snapshotGoals, diffGoals } from '../../src/lib/observability.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockFindProjectRoot = vi.mocked(findProjectRoot);

beforeEach(() => {
  vi.clearAllMocks();
  mockFindProjectRoot.mockReturnValue(null);
});

describe('snapshotGoals', () => {
  it('returns empty object when project root is not found', () => {
    mockFindProjectRoot.mockReturnValue(null);
    expect(snapshotGoals('my-squad')).toEqual({});
  });

  it('returns empty object when goals.md does not exist', () => {
    mockFindProjectRoot.mockReturnValue('/project');
    mockExistsSync.mockReturnValue(false);
    expect(snapshotGoals('my-squad')).toEqual({});
  });

  it('parses goal name and status from goals.md', () => {
    mockFindProjectRoot.mockReturnValue('/project');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '**Consulting revenue** — metric: $10k MRR | status: in-progress\n' +
      '**Ship v1** — metric: released | status: not-started\n'
    );

    const goals = snapshotGoals('my-squad');
    expect(goals).toEqual({
      'Consulting revenue': 'in-progress',
      'Ship v1': 'not-started',
    });
  });

  it('skips lines without status field', () => {
    mockFindProjectRoot.mockReturnValue('/project');
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      '# Goals\n' +
      'Some freeform text\n' +
      '**Active goal** — metric: X | status: active\n'
    );

    const goals = snapshotGoals('my-squad');
    expect(goals).toEqual({ 'Active goal': 'active' });
  });
});

describe('diffGoals', () => {
  it('returns empty array when nothing changed', () => {
    const before = { 'Goal A': 'in-progress' };
    const after = { 'Goal A': 'in-progress' };
    expect(diffGoals(before, after)).toEqual([]);
  });

  it('detects status change', () => {
    const before = { 'Goal A': 'not-started' };
    const after = { 'Goal A': 'completed' };
    const changes = diffGoals(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ name: 'Goal A', before: 'not-started', after: 'completed' });
  });

  it('detects new goal appearing after run', () => {
    const before = {};
    const after = { 'New Goal': 'in-progress' };
    const changes = diffGoals(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ name: 'New Goal', before: 'new', after: 'in-progress' });
  });

  it('detects goal removed from goals.md', () => {
    const before = { 'Old Goal': 'in-progress' };
    const after = {};
    const changes = diffGoals(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual({ name: 'Old Goal', before: 'in-progress', after: 'removed' });
  });

  it('handles multiple concurrent changes', () => {
    const before = { 'A': 'not-started', 'B': 'in-progress', 'C': 'completed' };
    const after  = { 'A': 'in-progress', 'B': 'in-progress', 'D': 'not-started' };
    const changes = diffGoals(before, after);
    // A changed, C removed, D is new
    expect(changes).toHaveLength(3);
    const names = changes.map(c => c.name).sort();
    expect(names).toEqual(['A', 'C', 'D']);
  });
});
