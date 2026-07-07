import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import { scanStrandedBranches, buildInbox, type InboxItem } from '../src/lib/inbox.js';
import {
  approveItem, rejectItem, deferItem, readDecisions, activeDeferrals,
  squadFromBranch, reviewedLedgerPath, operatorIdentity, type CommandRunner,
} from '../src/lib/inbox-decisions.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'squads-inboxdec-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function git(cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

function initRepoWithStrandedBranch(branch = 'squads/run-intelligence-abc123-0'): InboxItem {
  git('init -q -b develop');
  // Local (not just env-per-command) identity: mergeBranchLocally's commit
  // runs through the plain CommandRunner, not the `git()` test helper's env.
  git('config user.email t@t');
  git('config user.name t');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add -A');
  git('commit -qm base');
  git(`checkout -q -b '${branch}'`);
  writeFileSync(join(dir, 'brief.md'), 'deliverable');
  git('add -A');
  git('commit -qm "intel brief"');
  git('checkout -q develop');
  const items = scanStrandedBranches(dir);
  expect(items).toHaveLength(1);
  return items[0];
}

/** Runner that answers gh/ls-remote calls from a script and records everything. */
function fakeRunner(responses: Record<string, string | Error> = {}): { run: CommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: CommandRunner = (cmd, cwd) => {
    calls.push(cmd);
    for (const [prefix, resp] of Object.entries(responses)) {
      if (cmd.startsWith(prefix)) {
        if (resp instanceof Error) throw resp;
        return resp;
      }
    }
    // Git commands run for real (temp repo); anything else defaults to empty.
    if (cmd.startsWith('git ')) return execSync(cmd, { encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    return '';
  };
  return { run, calls };
}

describe('squadFromBranch', () => {
  it('extracts the squad from run and agent branch shapes (hyphenated squads too)', () => {
    expect(squadFromBranch('squads/run-intelligence-mr6ceiap-0')).toBe('intelligence');
    expect(squadFromBranch('squads/run-design-system-xy12ab-3')).toBe('design-system');
    expect(squadFromBranch('agent/cli/issue-solver-1772760575482')).toBe('cli');
    expect(squadFromBranch('feature/unrelated')).toBeUndefined();
  });
});

describe('ledger (reviewed.jsonl)', () => {
  it('records decisions append-only and survives a corrupt line', () => {
    const item = initRepoWithStrandedBranch();
    deferItem(item, 3, { repoRoot: dir, obsRoot: dir });
    writeFileSync(reviewedLedgerPath(dir), readFileSync(reviewedLedgerPath(dir), 'utf8') + 'not json\n');
    deferItem(item, 5, { repoRoot: dir, obsRoot: dir });
    const decisions = readDecisions(dir);
    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.decision === 'defer')).toBe(true);
  });
});

describe('decision attribution (by, C1a)', () => {
  it('stamps the local operator identity on every record when no override is given', () => {
    const item = initRepoWithStrandedBranch();
    deferItem(item, 3, { repoRoot: dir, obsRoot: dir });
    const [rec] = readDecisions(dir);
    expect(rec.by).toBe(operatorIdentity());
    expect(rec.by).toBeTruthy();
  });

  it('a --by override wins over the auto-stamp (bridge attributing an API decider)', () => {
    const item = initRepoWithStrandedBranch('squads/run-intelligence-byover-0');
    const { run } = fakeRunner({ 'git ls-remote': '' });
    rejectItem(item, 'superseded', {
      repoRoot: dir, obsRoot: dir, run, feedbackWriter: () => true, by: 'customer@example.com',
    });
    const [rec] = readDecisions(dir);
    expect(rec.decision).toBe('reject');
    expect(rec.by).toBe('customer@example.com');
  });

  it('operatorIdentity never returns empty', () => {
    expect(operatorIdentity().length).toBeGreaterThan(0);
  });

  describe('headless attribution (#1021)', () => {
    // Under vitest stdin is not a TTY — exactly the headless condition.
    it('stamps agent:headless instead of a login identity when stdin is not a TTY', () => {
      delete process.env.SQUADS_AGENT;
      expect(operatorIdentity()).toBe('agent:headless');
    });

    it('names the agent when SQUADS_AGENT is set', () => {
      process.env.SQUADS_AGENT = 'coo-tick';
      expect(operatorIdentity()).toBe('agent:coo-tick');
      delete process.env.SQUADS_AGENT;
    });
  });
});

describe('defer', () => {
  it('hides the item from buildInbox until the snooze expires; verbs still see it', () => {
    const item = initRepoWithStrandedBranch();
    expect(buildInbox(dir, dir).map((i) => i.id)).toContain(item.id);

    const out = deferItem(item, 7, { repoRoot: dir, obsRoot: dir });
    expect(out.ok).toBe(true);
    expect(buildInbox(dir, dir).map((i) => i.id)).not.toContain(item.id);
    expect(buildInbox(dir, dir, { includeDeferred: true }).map((i) => i.id)).toContain(item.id);

    // Expired snooze resurfaces (evaluate deferrals as-of the future).
    expect(activeDeferrals(dir, Date.now() + 8 * 24 * 3600 * 1000).has(item.id)).toBe(false);
  });

  it('a later decision supersedes the defer', () => {
    const item = initRepoWithStrandedBranch();
    deferItem(item, 7, { repoRoot: dir, obsRoot: dir });
    const { run } = fakeRunner({ 'git ls-remote': '' });
    rejectItem(item, 'superseded', { repoRoot: dir, obsRoot: dir, run, feedbackWriter: () => true });
    expect(activeDeferrals(dir).has(item.id)).toBe(false);
  });
});

describe('reject (decision 2: archive tag, then delete)', () => {
  it('tags archive/<branch>, deletes the branch, writes feedback through, records the decision', () => {
    const item = initRepoWithStrandedBranch('squads/run-intelligence-abc123-0');
    const feedback: string[] = [];
    const { run } = fakeRunner({ 'git ls-remote': '' }); // no origin
    const out = rejectItem(item, 'scratch binary, not a deliverable', {
      repoRoot: dir, obsRoot: dir, run,
      feedbackWriter: (squad, rating, text) => { feedback.push(`${squad}|${rating}|${text}`); return true; },
    });
    expect(out.ok).toBe(true);
    expect(git('tag -l "archive/*"')).toContain('archive/squads/run-intelligence-abc123-0');
    expect(git('branch --list "squads/*"').trim()).toBe('');
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toContain('intelligence|2|');
    expect(feedback[0]).toContain('scratch binary');
    const rec = readDecisions(dir).at(-1)!;
    expect(rec).toMatchObject({ decision: 'reject', id: item.id, reason: 'scratch binary, not a deliverable' });
  });

  it('keeps the branch when the archive tag cannot be created', () => {
    const item = initRepoWithStrandedBranch();
    const { run } = fakeRunner({ 'git tag': new Error('fatal: tag failed'), 'git ls-remote': '' });
    const out = rejectItem(item, 'x', { repoRoot: dir, obsRoot: dir, run, feedbackWriter: () => true });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('branch kept');
  });

  it('closes a PR with the reason', () => {
    const { run, calls } = fakeRunner({ 'gh pr close': '' });
    const item: InboxItem = { id: 'pr-12', kind: 'pr', ref: 'https://x/pull/12', title: 't', ageDays: 1, approveSemantics: 's' };
    const out = rejectItem(item, 'wrong approach', { repoRoot: dir, obsRoot: dir, run });
    expect(out.ok).toBe(true);
    expect(calls.some((c) => c.startsWith(`gh pr close '12'`) && c.includes('wrong approach') && c.includes('--delete-branch'))).toBe(true);
  });
});

describe('approve (decision 1: existing auto-merge path)', () => {
  it('queues the CI-gated auto-merge for a PR', () => {
    const { run, calls } = fakeRunner({ 'gh pr merge': '' });
    const item: InboxItem = { id: 'pr-12', kind: 'pr', ref: 'https://x/pull/12', title: 't', ageDays: 1, approveSemantics: 's' };
    const out = approveItem(item, { repoRoot: dir, obsRoot: dir, run });
    expect(out.ok).toBe(true);
    expect(calls).toContain(`gh pr merge '12' --squash --delete-branch --auto`);
    expect(readDecisions(dir).at(-1)).toMatchObject({ decision: 'approve', id: 'pr-12' });
  });

  it('falls back to a plain squash when the repo has no auto-merge', () => {
    let first = true;
    const run: CommandRunner = (cmd) => {
      if (cmd.startsWith('gh pr merge') && cmd.includes('--auto') && first) {
        first = false;
        throw new Error('GraphQL: Auto merge is not allowed for this repository');
      }
      return '';
    };
    const item: InboxItem = { id: 'pr-9', kind: 'pr', ref: 'https://x/pull/9', title: 't', ageDays: 1, approveSemantics: 's' };
    const out = approveItem(item, { repoRoot: dir, obsRoot: dir, run });
    expect(out.ok).toBe(true);
    expect(out.message).toContain('plain squash');
  });

  it('pushes + opens a PR from a stranded branch and queues its merge', () => {
    const item = initRepoWithStrandedBranch();
    const { run, calls } = fakeRunner({
      'git remote get-url origin': 'https://github.com/o/r.git\n',
      'gh auth status': '',
      'git ls-remote': '',
      'git push': '',
      'git rev-parse --verify --quiet origin/develop': new Error('no'),
      'git rev-parse --verify --quiet develop': '',
      'gh pr create': 'https://github.com/o/r/pull/77\n',
      'gh pr merge': '',
    });
    const out = approveItem(item, { repoRoot: dir, obsRoot: dir, run });
    expect(out.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('git push -u origin'))).toBe(true);
    expect(calls.some((c) => c.startsWith('gh pr create --base develop'))).toBe(true);
    expect(calls).toContain(`gh pr merge '77' --squash --delete-branch --auto`);
  });

  it('refuses run_artifacts items (v1 scope = PRs + branches)', () => {
    const item: InboxItem = { id: 'run-exec_x', kind: 'run_artifacts', ref: 'exec_x', title: 't', ageDays: 0, approveSemantics: 's' };
    const out = approveItem(item, { repoRoot: dir, obsRoot: dir, run: fakeRunner().run });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('runs --outcome');
    expect(existsSync(reviewedLedgerPath(dir))).toBe(false);
  });
});

describe('approve — local-first fallback, no GitHub remote/gh (#979)', () => {
  it('squash-merges the stranded branch into develop locally when there is no origin remote', () => {
    const item = initRepoWithStrandedBranch();
    // No origin configured on this repo at all — `git remote get-url origin`
    // and `gh auth status` both run for real and fail (temp repo, no remote).
    const { run, calls } = fakeRunner();
    const out = approveItem(item, { repoRoot: dir, obsRoot: dir, run });
    expect(out.ok).toBe(true);
    expect(out.message).toContain('merged locally to develop');
    expect(calls.some((c) => c.startsWith('gh ') || c.startsWith('git push'))).toBe(false);
    expect(git('show develop:brief.md').trim()).toBe('deliverable');
    expect(git('branch --list "squads/*"').trim()).toBe('');
    const rec = readDecisions(dir).at(-1)!;
    expect(rec).toMatchObject({ decision: 'approve', id: item.id });
  });

  it('falls back locally when origin exists but gh is missing/unauthenticated', () => {
    const item = initRepoWithStrandedBranch();
    const { run, calls } = fakeRunner({
      'git remote get-url origin': 'https://github.com/o/r.git\n',
      'gh auth status': new Error('gh: command not found'),
    });
    const out = approveItem(item, { repoRoot: dir, obsRoot: dir, run });
    expect(out.ok).toBe(true);
    expect(out.message).toContain('merged locally to develop');
    expect(calls.some((c) => c.startsWith('gh pr'))).toBe(false);
  });

  it('reports failure (branch kept) when the local squash-merge conflicts', () => {
    const item = initRepoWithStrandedBranch();
    // A conflicting change on develop that collides with the branch's edit.
    git('checkout -q develop');
    writeFileSync(join(dir, 'brief.md'), 'conflicting develop content');
    git('add -A');
    git('commit -qm "conflicting develop edit"');

    const { run } = fakeRunner();
    const out = approveItem(item, { repoRoot: dir, obsRoot: dir, run });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('branch kept');
    expect(git('branch --list "squads/*"').trim()).not.toBe('');
  });
});
