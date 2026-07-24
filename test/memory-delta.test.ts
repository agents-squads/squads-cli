/** cli#693: run-completion memory-growth delta. The pure diff is the load-bearing
 * piece (snapshots are thin I/O wrappers), so that's what we pin down here. */
import { describe, it, expect } from 'vitest';
import {
  approxTokens,
  snapshotMemoryContent,
  computeMemoryDelta,
  formatMemoryDeltaLine,
  type MemorySnapshot,
} from '../src/lib/memory-delta.js';

const snap = (entries: number, tokens: number, exists = true): MemorySnapshot => ({
  entries,
  tokens,
  exists,
});

describe('snapshotMemoryContent', () => {
  it('counts dated ## entries and approximates tokens from content', () => {
    // appendToMemory() writes `## YYYY-MM-DD: heading` blocks — one entry each.
    const content = [
      '# Learnings',          // h1 title — not counted
      '',
      '## 2026-07-24: cache results',
      '',
      'don\'t recompute twice',
      '',
      '### sub-bullet',       // h3 — not counted
      '',
      '## 2026-07-24: pin versions',
    ].join('\n');
    const s = snapshotMemoryContent(content);
    expect(s.entries).toBe(2);
    expect(s.tokens).toBe(approxTokens(content));
    expect(s.exists).toBe(true);
  });

  it('reports zero entries for a heading-less file', () => {
    const s = snapshotMemoryContent('just a flat note with no headings');
    expect(s.entries).toBe(0);
    expect(s.exists).toBe(true);
  });
});

describe('computeMemoryDelta', () => {
  it('reports positive growth in entries and tokens', () => {
    const d = computeMemoryDelta(snap(3, 120), snap(5, 460));
    expect(d.entriesAdded).toBe(2);
    expect(d.tokensAdded).toBe(340);
    expect(d.totalEntries).toBe(5);
    expect(d.totalTokens).toBe(460);
    expect(d.exists).toBe(true);
  });

  it('treats a brand-new memory (before did not exist) as growth from zero', () => {
    const d = computeMemoryDelta(snap(0, 0, false), snap(1, 80));
    expect(d.entriesAdded).toBe(1);
    expect(d.totalTokens).toBe(80);
  });

  it('clamps a shrunken file to zero — never reports negative learning', () => {
    // A condenser or manual edit trimmed the file; the delta must not go negative.
    const d = computeMemoryDelta(snap(5, 400), snap(2, 150));
    expect(d.entriesAdded).toBe(0);
    expect(d.tokensAdded).toBe(0);
    expect(d.totalEntries).toBe(2);
    expect(d.totalTokens).toBe(150);
  });

  it('reports no change when the snapshots match', () => {
    const d = computeMemoryDelta(snap(4, 300), snap(4, 300));
    expect(d.entriesAdded).toBe(0);
    expect(d.tokensAdded).toBe(0);
    expect(d.totalEntries).toBe(4);
  });
});

describe('formatMemoryDeltaLine', () => {
  it('renders the issue\'s shape with a view path', () => {
    const line = formatMemoryDeltaLine(
      computeMemoryDelta(snap(0, 0, false), snap(2, 340)),
      '/p/.agents/memory/cli/lead/learnings.md',
    );
    expect(line).toBe(
      'Memory: +2 patterns learned. Total: 340 tokens. (view: /p/.agents/memory/cli/lead/learnings.md)',
    );
  });

  it('omits the view hint when no path resolves', () => {
    const line = formatMemoryDeltaLine(computeMemoryDelta(snap(1, 50), snap(3, 150)), null);
    expect(line).toBe('Memory: +2 patterns learned. Total: 150 tokens.');
  });
});
