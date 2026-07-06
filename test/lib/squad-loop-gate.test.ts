/**
 * #971 — the deliver-and-stop gate (#951/#954) must match CLOSING KEYWORDS
 * only. Bare `#N` mentions ("tracked in #957", "Part of #955") are casual
 * cross-references, not deliveries; matching them stopped runs whose work
 * nobody had done — including the run dispatched to fix this bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';
import { checkPrForIssue } from '../../src/lib/squad-loop.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  exec: vi.fn(),
  spawn: vi.fn(),
}));

const mockExecSync = vi.mocked(execSync);

function ghReturns(prs: Array<{ number: number; title: string; body: string; state?: string }>) {
  mockExecSync.mockReturnValue(
    JSON.stringify(prs.map(p => ({ state: 'MERGED', ...p }))) as never,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('checkPrForIssue (#971 closing-keywords-only)', () => {
  it('a prose mention ("tracked in #957") does NOT satisfy the gate', () => {
    ghReturns([{ number: 965, title: 'fix(providers): normalize vocabulary', body: 'the exit-code half is tracked in #957' }]);
    expect(checkPrForIssue('agents-squads/squads-cli', 957)).toBeNull();
  });

  it('"Part of #955" does NOT satisfy the gate', () => {
    ghReturns([{ number: 965, title: 'fix(providers): normalize vocabulary', body: 'Part of #955 — leave open' }]);
    expect(checkPrForIssue('agents-squads/squads-cli', 955)).toBeNull();
  });

  it('the recursive case: a PR narrating "the A4 gate false-positive (#971)" does not block #971', () => {
    ghReturns([{ number: 972, title: 'fix(doctor): truthful exit codes', body: 'stopped by the A4 gate false-positive (#971) before delivering' }]);
    expect(checkPrForIssue('agents-squads/squads-cli', 971)).toBeNull();
  });

  it('"Closes #957" in the body satisfies the gate', () => {
    ghReturns([{ number: 972, title: 'fix(doctor): truthful exit codes', body: 'Real auth check.\n\nCloses #957' }]);
    expect(checkPrForIssue('agents-squads/squads-cli', 957)).toEqual({ number: 972, title: 'fix(doctor): truthful exit codes' });
  });

  it('closing keyword in the TITLE satisfies the gate (case-insensitive, colon tolerated)', () => {
    ghReturns([{ number: 10, title: 'Fixes: #42 flaky watcher', body: '' }]);
    expect(checkPrForIssue('agents-squads/squads-cli', 42)).toEqual({ number: 10, title: 'Fixes: #42 flaky watcher' });
  });

  it('does not match a longer issue number by prefix ("Closes #9571" for #957)', () => {
    ghReturns([{ number: 11, title: 'chore', body: 'Closes #9571' }]);
    expect(checkPrForIssue('agents-squads/squads-cli', 957)).toBeNull();
  });

  it('CLOSED-unmerged PRs never satisfy the gate', () => {
    ghReturns([{ number: 12, title: 'abandoned', body: 'Closes #957', state: 'CLOSED' }]);
    expect(checkPrForIssue('agents-squads/squads-cli', 957)).toBeNull();
  });

  it('gh failure returns null (gate stays open, run proceeds)', () => {
    mockExecSync.mockImplementation(() => { throw new Error('gh: not authenticated'); });
    expect(checkPrForIssue('agents-squads/squads-cli', 957)).toBeNull();
  });
});
