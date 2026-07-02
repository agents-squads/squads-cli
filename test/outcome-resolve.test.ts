import { describe, it, expect } from 'vitest';
import { resolveRunOutcome, type GhExec } from '../src/lib/outcome-resolve.js';
import { createClaudeStreamJsonAdapter, type ExecEvent, type PersistedExecEvent } from '../src/lib/exec-events.js';

let seq = 0;
const ev = (event: ExecEvent, agent?: string): PersistedExecEvent =>
  ({ v: 1, runId: 'exec_outcome_1', seq: seq++, ts: '2026-07-01T00:00:00Z', ...(agent ? { agent } : {}), event });

const PR_URL = 'https://github.com/acme/widgets/pull/42';
const ISSUE_URL = 'https://github.com/acme/widgets/issues/7';

describe('adapter mines artifact URLs from gh create results (#817)', () => {
  it('emits a URL-ref artifact when a gh pr create result carries the URL', () => {
    const adapter = createClaudeStreamJsonAdapter();
    adapter.parseLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'gh pr create --base develop --title x' } }] },
    }));
    const events = adapter.parseLine(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: `Creating pull request…\n${PR_URL}\n` }] },
    }));

    const artifact = events.find((e) => e.type === 'artifact');
    expect(artifact).toMatchObject({ type: 'artifact', kind: 'pr', ref: PR_URL });
  });

  it('does not fabricate a URL artifact from a failed create or URL-less output', () => {
    const adapter = createClaudeStreamJsonAdapter();
    adapter.parseLine(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'gh issue create --title y' } }] },
    }));
    const failed = adapter.parseLine(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b2', content: 'GraphQL: rate limited', is_error: true }] },
    }));
    expect(failed.filter((e) => e.type === 'artifact')).toHaveLength(0);
  });
});

describe('resolveRunOutcome (#817)', () => {
  const ghFake = (states: Record<string, string>): GhExec => (args) => {
    const url = args.find((a) => a.startsWith('https://'));
    if (!url || !(url in states)) return null;
    const state = states[url];
    return state === 'merged'
      ? JSON.stringify({ state: 'MERGED', mergedAt: '2026-07-01T00:00:00Z' })
      : JSON.stringify({ state: state.toUpperCase(), mergedAt: null });
  };

  it('resolves URL refs live, dedupes, and verdicts LANDED on a merged PR', () => {
    const outcome = resolveRunOutcome([
      ev({ type: 'artifact', kind: 'pr', ref: PR_URL }, 'worker'),
      ev({ type: 'artifact', kind: 'pr', ref: PR_URL }, 'worker'),      // dup (create cmd + result)
      ev({ type: 'artifact', kind: 'issue', ref: ISSUE_URL }, 'lead'),
      ev({ type: 'artifact', kind: 'commit', ref: 'git commit -m x' }),
    ], ghFake({ [PR_URL]: 'merged', [ISSUE_URL]: 'open' }));

    expect(outcome.landed).toBe(true);
    expect(outcome.artifacts).toHaveLength(2); // deduped
    expect(outcome.summary).toEqual({
      prs: { total: 1, merged: 1, open: 0, closed: 0 },
      issues: { total: 1, open: 1, closed: 0 },
      commits: 1,
    });
    expect(outcome.artifacts.find((a) => a.kind === 'pr')?.agent).toBe('worker');
  });

  it('an open PR is NOT LANDED; command-string refs surface as unconfirmed', () => {
    const outcome = resolveRunOutcome([
      ev({ type: 'artifact', kind: 'pr', ref: PR_URL }),
      ev({ type: 'artifact', kind: 'issue', ref: 'gh issue create --title z' }), // cmd ref, no URL
    ], ghFake({ [PR_URL]: 'open' }));

    expect(outcome.landed).toBe(false);
    expect(outcome.summary.prs.open).toBe(1);
    expect(outcome.unconfirmed).toEqual([{ kind: 'issue', ref: 'gh issue create --title z' }]);
  });

  it('gh failure degrades to unknown, never throws', () => {
    const outcome = resolveRunOutcome(
      [ev({ type: 'artifact', kind: 'pr', ref: PR_URL })],
      () => null,
    );
    expect(outcome.artifacts[0].state).toBe('unknown');
    expect(outcome.landed).toBe(false);
  });

  it('a run with no artifacts is spend without output', () => {
    const outcome = resolveRunOutcome([
      ev({ type: 'token_usage', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costEst: 0.01, model: 'haiku' }),
    ], () => null);
    expect(outcome.artifacts).toEqual([]);
    expect(outcome.summary.commits).toBe(0);
    expect(outcome.landed).toBe(false);
  });
});
