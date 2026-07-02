/**
 * outcome-resolve.ts — did the run's output actually LAND? (#817)
 *
 * Activity counters (commits/PRs/issues created) answer "did the agent act";
 * this answers the question that matters for evaluating an agent workforce:
 * did anyone MERGE/USE the output, or did it strand? A completed run whose
 * deliverable nobody uses is pure cost — this makes that visible per run.
 *
 * Sources: the run's `artifact` events. URL refs (mined from `gh … create`
 * results by the adapter) are resolvable — checked live against GitHub.
 * Command-string refs (the create command was seen but no URL was captured)
 * are reported as unconfirmed rather than silently dropped.
 */

import { execSync } from 'child_process';
import type { PersistedExecEvent } from './exec-events.js';

export type ArtifactState = 'merged' | 'open' | 'closed' | 'unknown';

export interface ResolvedArtifact {
  kind: 'pr' | 'issue' | 'commit' | 'file';
  ref: string;
  /** Live state from GitHub; 'unknown' when unresolvable (no URL / gh failed). */
  state: ArtifactState;
  agent?: string;
}

export interface RunOutcome {
  runId: string;
  artifacts: ResolvedArtifact[];
  /** Artifact-creating commands whose result URL was never captured. */
  unconfirmed: Array<{ kind: string; ref: string }>;
  summary: {
    prs: { total: number; merged: number; open: number; closed: number };
    issues: { total: number; open: number; closed: number };
    commits: number;
  };
  /** The verdict: did any artifact land (PR merged)? */
  landed: boolean;
}

const GITHUB_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(pull|issues)\/\d+$/;

/** Runs `gh …` and returns stdout, or null on failure. Injectable for tests. */
export type GhExec = (args: string[]) => string | null;

const defaultGhExec: GhExec = (args) => {
  try {
    return execSync(`gh ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 15_000,
    });
  } catch {
    return null;
  }
};

function resolvePrState(url: string, gh: GhExec): ArtifactState {
  const out = gh(['pr', 'view', url, '--json', 'state,mergedAt']);
  if (!out) return 'unknown';
  try {
    const parsed = JSON.parse(out) as { state?: string; mergedAt?: string | null };
    if (parsed.mergedAt || parsed.state === 'MERGED') return 'merged';
    if (parsed.state === 'OPEN') return 'open';
    if (parsed.state === 'CLOSED') return 'closed';
  } catch { /* fall through */ }
  return 'unknown';
}

function resolveIssueState(url: string, gh: GhExec): ArtifactState {
  const out = gh(['issue', 'view', url, '--json', 'state']);
  if (!out) return 'unknown';
  try {
    const parsed = JSON.parse(out) as { state?: string };
    if (parsed.state === 'OPEN') return 'open';
    if (parsed.state === 'CLOSED') return 'closed';
  } catch { /* fall through */ }
  return 'unknown';
}

/**
 * Resolve a run's artifact events into landed/stranded facts.
 * URL refs are deduped (create + retry emit the same URL once each) and
 * checked live; command-string refs are surfaced as unconfirmed.
 */
export function resolveRunOutcome(events: PersistedExecEvent[], gh: GhExec = defaultGhExec): RunOutcome {
  const runId = events[0]?.runId ?? '';
  const seenUrls = new Set<string>();
  const artifacts: ResolvedArtifact[] = [];
  const unconfirmed: Array<{ kind: string; ref: string }> = [];
  let commits = 0;

  for (const line of events) {
    const ev = line.event;
    if (ev.type !== 'artifact') continue;
    if (ev.kind === 'commit') {
      commits += 1;
      continue;
    }
    if (ev.kind === 'file') continue;
    if (GITHUB_URL.test(ev.ref)) {
      if (seenUrls.has(ev.ref)) continue;
      seenUrls.add(ev.ref);
      const state = ev.kind === 'pr' ? resolvePrState(ev.ref, gh) : resolveIssueState(ev.ref, gh);
      artifacts.push({ kind: ev.kind, ref: ev.ref, state, agent: line.agent });
    } else {
      // A create command with no captured URL — activity without a resolvable
      // ref. Reported, never silently dropped.
      unconfirmed.push({ kind: ev.kind, ref: ev.ref });
    }
  }

  const prs = artifacts.filter((a) => a.kind === 'pr');
  const issues = artifacts.filter((a) => a.kind === 'issue');
  const summary = {
    prs: {
      total: prs.length,
      merged: prs.filter((a) => a.state === 'merged').length,
      open: prs.filter((a) => a.state === 'open').length,
      closed: prs.filter((a) => a.state === 'closed').length,
    },
    issues: {
      total: issues.length,
      open: issues.filter((a) => a.state === 'open').length,
      closed: issues.filter((a) => a.state === 'closed').length,
    },
    commits,
  };

  return {
    runId,
    artifacts,
    unconfirmed,
    summary,
    landed: summary.prs.merged > 0,
  };
}
