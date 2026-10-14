/**
 * Memory-growth delta for run completion (#693).
 *
 * Snapshot an agent's memory file (entry count + approximate token size) before
 * a run, then diff after, so a run can report how much the agent learned — e.g.
 * "Memory: +2 patterns learned. Total: 340 tokens. (view: <path>)".
 *
 * Mirrors the snapshotGoals/diffGoals pattern in observability.ts: a pure diff
 * over two snapshots, plus thin I/O wrappers.
 *
 * This is the run-completion surface (Option A) ONLY. `squads memory show
 * <squad>` already covers on-demand inspection (Option B) — do not duplicate it.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findMemoryDir } from './memory.js';

export interface MemorySnapshot {
  /** Number of dated `## ` entries in the file (one per appended learning). */
  entries: number;
  /** Approximate token size (chars / 4). */
  tokens: number;
  /** Whether the memory file existed at snapshot time. */
  exists: boolean;
}

export interface MemoryDelta {
  /** Entries added during the run (clamped at zero — never negative). */
  entriesAdded: number;
  /** Tokens added during the run (clamped at zero — never negative). */
  tokensAdded: number;
  /** Total entries after the run. */
  totalEntries: number;
  /** Total tokens after the run. */
  totalTokens: number;
  /** Whether any memory file existed after the run. */
  exists: boolean;
}

/** ~4 chars per token — the same heuristic used for the dry-run context preview
 * in agent-runner.ts. Good enough for a human-facing "Total: X tokens" line. */
export function approxTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

/**
 * Snapshot raw memory content. Entries are the dated `## ` headings that
 * `appendToMemory()` writes (`## YYYY-MM-DD: heading`), so each top-level h2 is
 * one learned pattern. `^##\s+` deliberately ignores h1 titles and h3 sub-bullets.
 */
export function snapshotMemoryContent(content: string): MemorySnapshot {
  const entries = (content.match(/^##\s+/gm) || []).length;
  return { entries, tokens: approxTokens(content), exists: true };
}

/**
 * Snapshot an agent's memory file on disk. Defaults to `learnings.md` — the
 * canonical "patterns learned" surface. Returns a zeroed, non-existent snapshot
 * when there is no memory dir or no file yet, so a brand-new agent's first
 * learnings still produce a positive delta rather than a spurious -N.
 */
export function snapshotAgentMemory(
  squad: string,
  agent: string,
  type: string = 'learnings',
): MemorySnapshot {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return { entries: 0, tokens: 0, exists: false };
  const filePath = join(memoryDir, squad, agent, `${type}.md`);
  if (!existsSync(filePath)) return { entries: 0, tokens: 0, exists: false };
  return snapshotMemoryContent(readFileSync(filePath, 'utf-8'));
}

/** Resolve the on-disk path of an agent's memory file for the "(view: ...)"
 * hint, or null when no memory dir exists. */
export function agentMemoryPath(
  squad: string,
  agent: string,
  type: string = 'learnings',
): string | null {
  const memoryDir = findMemoryDir();
  if (!memoryDir) return null;
  return join(memoryDir, squad, agent, `${type}.md`);
}

/**
 * Pure diff of two snapshots. Clamps growth at zero so a file that shrank
 * (manual edit, condenser run) never reports negative learning.
 */
export function computeMemoryDelta(
  before: MemorySnapshot,
  after: MemorySnapshot,
): MemoryDelta {
  return {
    entriesAdded: Math.max(0, after.entries - before.entries),
    tokensAdded: Math.max(0, after.tokens - before.tokens),
    totalEntries: after.entries,
    totalTokens: after.tokens,
    exists: after.exists,
  };
}

/**
 * Format the run-completion memory-delta line (no color — the caller wraps it).
 * Matches the issue's shape: "Memory: +N patterns learned. Total: X tokens.
 * (view: <path>)". The view hint is omitted when no path resolves.
 */
export function formatMemoryDeltaLine(delta: MemoryDelta, viewPath: string | null): string {
  const view = viewPath ? ` (view: ${viewPath})` : '';
  return `Memory: +${delta.entriesAdded} patterns learned. Total: ${delta.totalTokens} tokens.${view}`;
}
