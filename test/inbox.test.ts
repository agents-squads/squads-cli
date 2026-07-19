import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { scanStrandedBranches, scanRunsWithArtifacts, buildInbox, scanGoalEvents } from '../src/lib/inbox.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'squads-inbox-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function initRepo(): void {
  git('init -q -b develop');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add -A');
  git('commit -qm base');
}

describe('scanStrandedBranches (#924 — the Argonne case)', () => {
  it('surfaces squads/run-* branches with commits ahead of develop', () => {
    initRepo();
    git('checkout -q -b squads/run-intelligence-xyz');
    writeFileSync(join(dir, 'briefs.md'), 'deliverable');
    git('add -A');
    git('commit -qm "intel brief: argonne"');
    git('checkout -q develop');

    const items = scanStrandedBranches(dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'run_branch',
      ref: 'squads/run-intelligence-xyz',
    });
    expect(items[0].title).toContain('argonne');
    expect(items[0].approveSemantics).toContain('open a PR');
    expect(items[0].detail).toContain('1 commit(s) ahead');
  });

  it('ignores run branches already merged (0 ahead) and non-run branches', () => {
    initRepo();
    git('checkout -q -b squads/run-merged-1');
    git('checkout -q develop');       // no commits ahead
    git('checkout -q -b feature/foo'); // wrong prefix
    writeFileSync(join(dir, 'b.txt'), 'b');
    git('add -A');
    git('commit -qm feat');
    git('checkout -q develop');

    expect(scanStrandedBranches(dir)).toHaveLength(0);
  });

  it('non-git directory yields empty, never throws', () => {
    expect(scanStrandedBranches(dir)).toEqual([]);
  });
});

describe('scanRunsWithArtifacts (#924)', () => {
  it('lists runs whose events carry PR URL artifacts, newest first, deduped', () => {
    const eventsDir = join(dir, '.agents', 'observability', 'events');
    mkdirSync(eventsDir, { recursive: true });
    const line = (runId: string, event: unknown, seq: number) =>
      JSON.stringify({ v: 1, runId, seq, ts: '2026-07-04T00:00:00Z', event });
    writeFileSync(join(eventsDir, 'exec_a.jsonl'), [
      line('exec_a', { type: 'run_start', squad: 'cli', mode: 'background', model: '', role: '', startedAt: 'x' }, 0),
      line('exec_a', { type: 'artifact', kind: 'pr', ref: 'https://github.com/o/r/pull/1' }, 1),
      line('exec_a', { type: 'artifact', kind: 'pr', ref: 'https://github.com/o/r/pull/1' }, 2), // dup
    ].join('\n'));
    writeFileSync(join(eventsDir, 'exec_b.jsonl'), [
      line('exec_b', { type: 'run_start', squad: 'demo', mode: 'background', model: '', role: '', startedAt: 'x' }, 0),
      line('exec_b', { type: 'file_read', path: 'x' }, 1), // no artifacts → excluded
    ].join('\n'));

    const items = scanRunsWithArtifacts(dir);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'run_artifacts', ref: 'exec_a' });
    expect(items[0].title).toContain('cli produced 1 PR');
    expect(items[0].approveSemantics).toContain('squads runs --outcome exec_a');
  });

  it('missing events dir yields empty', () => {
    expect(scanRunsWithArtifacts(dir)).toEqual([]);
  });

  describe('stale-row reconcile (#1021)', () => {
    const seed = (execId: string, refs: string[]) => {
      const eventsDir = join(dir, '.agents', 'observability', 'events');
      mkdirSync(eventsDir, { recursive: true });
      const line = (event: unknown, seq: number) =>
        JSON.stringify({ v: 1, runId: execId, seq, ts: '2026-07-04T00:00:00Z', event });
      writeFileSync(join(eventsDir, `${execId}.jsonl`), [
        line({ type: 'run_start', squad: 'cli', mode: 'background', model: '', role: '', startedAt: 'x' }, 0),
        ...refs.map((ref, i) => line({ type: 'artifact', kind: 'pr', ref }, i + 1)),
      ].join('\n'));
    };

    it('drops items whose every PR already landed', () => {
      seed('exec_merged', ['https://github.com/o/r/pull/1']);
      const run = () => 'MERGED\n';
      expect(scanRunsWithArtifacts(dir, 15, { run })).toEqual([]);
    });

    it('keeps items with an open PR and points detail at the open ref', () => {
      seed('exec_mixed', ['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
      const run = (cmd: string) => (cmd.includes('/pull/1') ? 'MERGED\n' : 'OPEN\n');
      const items = scanRunsWithArtifacts(dir, 15, { run });
      expect(items).toHaveLength(1);
      expect(items[0].title).toContain('produced 1 PR');
      expect(items[0].detail).toBe('https://github.com/o/r/pull/2');
    });

    it('fails open: gh errors keep the item visible', () => {
      seed('exec_offline', ['https://github.com/o/r/pull/9']);
      const run = () => { throw new Error('gh: not logged in'); };
      const items = scanRunsWithArtifacts(dir, 15, { run });
      expect(items).toHaveLength(1);
    });

    it('skips liveness entirely under VITEST when no runner injected', () => {
      seed('exec_default', ['https://github.com/o/r/pull/3']);
      expect(scanRunsWithArtifacts(dir)).toHaveLength(1);
    });
  });
});

describe('buildInbox ordering', () => {
  it('one failing scanner never empties the others', () => {
    // dir is not a git repo (branch scan fails) and has no gh remote (pr scan
    // fails) — but events still surface.
    const eventsDir = join(dir, '.agents', 'observability', 'events');
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(join(eventsDir, 'exec_c.jsonl'), JSON.stringify({
      v: 1, runId: 'exec_c', seq: 0, ts: '2026-07-04T00:00:00Z',
      event: { type: 'artifact', kind: 'pr', ref: 'https://github.com/o/r/pull/9' },
    }));
    const items = buildInbox(dir, dir);
    expect(items.some((i) => i.ref === 'exec_c')).toBe(true);
  });
});

describe('scanner correctness (#929)', () => {
  it('pickScanBase prefers develop normally, but main when develop is vestigial', async () => {
    const { pickScanBase } = await import('../src/lib/inbox.js');
    initRepo(); // repo born on develop
    expect(pickScanBase(dir)).toBe('develop');

    // main forks ahead: 2 direct-push commits develop never saw → main is the trunk
    git('checkout -q -b main');
    writeFileSync(join(dir, 'm1.txt'), '1'); git('add -A'); git('commit -qm direct1');
    writeFileSync(join(dir, 'm2.txt'), '2'); git('add -A'); git('commit -qm direct2');
    git('checkout -q develop');
    expect(pickScanBase(dir)).toBe('main');
  });

  it('hides branches whose commits squash-landed (patch-id equivalent)', () => {
    initRepo();
    git('checkout -q -b squads/run-x-ab12cd-0');
    writeFileSync(join(dir, 'brief.md'), 'deliverable');
    git('add -A'); git('commit -qm "brief"');
    git('checkout -q develop');
    expect(scanStrandedBranches(dir)).toHaveLength(1); // genuinely unlanded

    // simulate the squash merge: same patch, new SHA, on develop
    writeFileSync(join(dir, 'brief.md'), 'deliverable');
    git('add -A'); git('commit -qm "brief (squashed #99)"');
    expect(scanStrandedBranches(dir)).toHaveLength(0); // landed → not waiting on a human
  });
});

describe('partial class (A5 — timed-out runs surface, not archaeology)', () => {
  it('flags auto-saved (#875) branches as PARTIAL', () => {
    initRepo();
    git('checkout -q -b squads/run-intel-tm99x-0');
    writeFileSync(join(dir, 'half-brief.md'), 'partial work');
    git('add -A');
    git('commit -qm "squads run: auto-save uncommitted deliverables on cleanup (#875)"');
    git('checkout -q develop');
    const [item] = scanStrandedBranches(dir);
    expect(item.title).toContain('PARTIAL');
    expect(item.detail).toContain('inspect before approving');
  });
});

describe('ambient proposal class (#983 — squads propose lands distinctly)', () => {
  it('flags squads/proposal-* branches as PROPOSAL', () => {
    initRepo();
    git('checkout -q -b squads/proposal-growth-tm99x-0');
    writeFileSync(join(dir, 'copy-update.md'), 'proposed deliverable');
    git('add -A');
    git('commit -qm "draft: homepage copy refresh"');
    git('checkout -q develop');

    const items = scanStrandedBranches(dir);
    expect(items).toHaveLength(1);
    expect(items[0].ref).toBe('squads/proposal-growth-tm99x-0');
    expect(items[0].title).toContain('PROPOSAL — draft: homepage copy refresh');
    expect(items[0].detail).toContain('ambient proposal');
  });

  it('combines PROPOSAL and PARTIAL labels when a proposal run auto-saved on exit', () => {
    initRepo();
    git('checkout -q -b squads/proposal-growth-ab12cd-0');
    writeFileSync(join(dir, 'half-copy.md'), 'partial proposal');
    git('add -A');
    git('commit -qm "squads run: auto-save uncommitted deliverables on cleanup (#875)"');
    git('checkout -q develop');

    const [item] = scanStrandedBranches(dir);
    expect(item.title).toContain('PROPOSAL (partial) —');
  });
});

describe('scanGoalEvents (#1040 — goal-achieved heuristic false-positives)', () => {
  it('DEBUG: test basic setup', () => {
    // Debug test to check if basic setup works
    const memoryDir = join(dir, '.agents', 'memory');
    const squadDir = join(memoryDir, 'cli');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(join(squadDir, 'goals.md'), '# Test\n\n## Active\n\n1. **Test goal** — status: achieved');

    const squadsDir = join(dir, '.agents', 'squads');
    mkdirSync(squadsDir, { recursive: true });

    const mockScript = join(dir, 'scripts', 'validate-goals.sh');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(mockScript, `#!/bin/bash
echo "⤴ REVIEW: Test goal"
`);
    // Make script executable
    execSync(`chmod +x ${mockScript}`, { stdio: 'ignore' });

    // Check if files exist
    expect(existsSync(join(squadDir, 'goals.md'))).toBe(true);
    expect(existsSync(mockScript)).toBe(true);

    const items = scanGoalEvents(dir);
    console.log('DEBUG items:', JSON.stringify(items, null, 2));
    expect(items).toHaveLength(1);
  });

  it('active goal with merged PR ref stays active (not marked as achieved)', () => {
    // Setup: create goals.md with an active goal that has a merged PR
    const memoryDir = join(dir, '.agents', 'memory');
    const squadDir = join(memoryDir, 'cli');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(join(squadDir, 'goals.md'), [
      '# CLI Goals',
      '',
      '## Active',
      '',
      '1. **Fix goal-achieved heuristic** — metric: bug-fixed | baseline: false-positives exist | target: zero | deadline: 2026-07-20 | status: in-progress',
      '',
      '## Achieved',
      '',
      '(none)',
    ].join('\n'));

    // Mock validate-goals.sh output suggesting this goal for review
    // (simulating the case where a merged PR references the goal)
    const squadsDir = join(dir, '.agents', 'squads');
    mkdirSync(squadsDir, { recursive: true });
    const mockScript = join(dir, 'scripts', 'validate-goals.sh');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(mockScript, `#!/bin/bash
echo "⤴ REVIEW: Fix goal-achieved heuristic"
`);
    // Make script executable
    execSync(`chmod +x ${mockScript}`, { stdio: 'ignore' });

    const items = scanGoalEvents(dir);

    // Should NOT create a "Goal achieved" inbox item because status is in-progress
    expect(items).toHaveLength(0);
  });

  it('status=achieved is respected (marked as achieved)', () => {
    // Setup: create goals.md with an achieved goal
    const memoryDir = join(dir, '.agents', 'memory');
    const squadDir = join(memoryDir, 'cli');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(join(squadDir, 'goals.md'), [
      '# CLI Goals',
      '',
      '## Active',
      '',
      '(none)',
      '',
      '## Achieved',
      '',
      '1. **Fix goal-achieved heuristic** — metric: bug-fixed | baseline: false-positives exist | target: zero | deadline: 2026-07-20 | status: achieved',
    ].join('\n'));

    // Mock validate-goals.sh output
    const mockScript = join(dir, 'scripts', 'validate-goals.sh');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(mockScript, `#!/bin/bash
echo "⤴ REVIEW: Fix goal-achieved heuristic"
`);

    const items = scanGoalEvents(dir);

    // Should create a "Goal achieved" inbox item because status=achieved
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('goal');
    expect(items[0].title).toContain('Goal achieved');
    expect(items[0].title).toContain('Fix goal-achieved heuristic');
    expect(items[0].approveSemantics).toContain('confirm achieved');
  });

  it('goal in Achieved section is respected even without explicit status', () => {
    // Setup: goal in Achieved section without explicit status field
    const memoryDir = join(dir, '.agents', 'memory');
    const squadDir = join(memoryDir, 'cli');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(join(squadDir, 'goals.md'), [
      '# CLI Goals',
      '',
      '## Achieved',
      '',
      '1. **Another completed goal** — metric: shipped | baseline: zero | target: one | deadline: 2026-07-15',
      '',
      '## Active',
      '',
      '(none)',
    ].join('\n'));

    // Mock validate-goals.sh output
    const mockScript = join(dir, 'scripts', 'validate-goals.sh');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(mockScript, `#!/bin/bash
echo "⤴ REVIEW: Another completed goal"
`);

    const items = scanGoalEvents(dir);

    // Should create a "Goal achieved" inbox item because it's in the Achieved section
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('goal');
    expect(items[0].title).toContain('Goal achieved');
    expect(items[0].title).toContain('Another completed goal');
  });

  it('active goal with status=complete is treated as achieved', () => {
    // Setup: active goal with status=complete (variant of achieved)
    const memoryDir = join(dir, '.agents', 'memory');
    const squadDir = join(memoryDir, 'cli');
    mkdirSync(squadDir, { recursive: true });
    writeFileSync(join(squadDir, 'goals.md'), [
      '# CLI Goals',
      '',
      '## Active',
      '',
      '1. **Some completed work** — metric: delivered | baseline: zero | target: one | deadline: 2026-07-19 | status: complete',
    ].join('\n'));

    // Mock validate-goals.sh output
    const mockScript = join(dir, 'scripts', 'validate-goals.sh');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(mockScript, `#!/bin/bash
echo "⤴ REVIEW: Some completed work"
`);

    const items = scanGoalEvents(dir);

    // Should create a "Goal achieved" inbox item because status=complete
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('goal');
    expect(items[0].title).toContain('Goal achieved');
  });
});
