import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { scanStrandedBranches, scanRunsWithArtifacts, buildInbox } from '../src/lib/inbox.js';

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
