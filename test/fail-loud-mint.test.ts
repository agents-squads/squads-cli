/** cli#1150: a detached lane whose tools include gh must fail at dispatch
 * when the bot token mint fails — not burn its run on failing gh calls. */
import { describe, it, expect } from 'vitest';
import { toolsRequireGh } from '../src/lib/execution-engine.js';

describe('toolsRequireGh', () => {
  it('matches the gh-shaped Bash grants', () => {
    expect(toolsRequireGh(['Read', 'Bash(gh:*)'])).toBe(true);
    expect(toolsRequireGh(['Bash(gh pr create:*)'])).toBe(true);
    expect(toolsRequireGh(['Bash(gh)'])).toBe(true);
  });

  it('ignores non-gh grants (incl. lookalikes)', () => {
    expect(toolsRequireGh(['Read', 'Write', 'Bash(git:*)'])).toBe(false);
    expect(toolsRequireGh(['Bash(ghostscript:*)'])).toBe(false);
    expect(toolsRequireGh([])).toBe(false);
  });
});
