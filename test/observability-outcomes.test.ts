/**
 * #1060 — outcomes on foreground runs come from the session JSONL, never
 * fabricated zeros. Locks the parseSessionUsage outcome extraction via the
 * public captureSessionUsageById reader against a hermetic HOME fixture.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { captureSessionUsageById } from '../src/lib/observability.js';

describe('session outcomes extraction (#1060)', () => {
  let home: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'squads-home-'));
    oldHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeSession(sessionId: string, lines: object[]): void {
    const projDir = join(home, '.claude', 'projects', '-Users-x-repo');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

  it('counts tool_use blocks into outcomes', () => {
    writeSession('sess-real', [
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          usage,
          content: [
            { type: 'text', text: 'editing' },
            { type: 'tool_use', name: 'Edit', input: { file_path: '/x' } },
            { type: 'tool_use', name: 'Bash', input: { command: 'git add -A && git commit -m "x"' } },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          usage,
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gh pr create --title x' } }],
        },
      },
    ]);

    const out = captureSessionUsageById('sess-real');
    expect(out).not.toBeNull();
    expect(out!.outcomes).toEqual({
      actions: 3,
      files_edited: 1,
      commits: 1,
      prs_created: 1,
      issues_created: 0,
    });
  });

  it('omits outcomes (unknown, not zero) when no tool_use blocks are seen', () => {
    writeSession('sess-idle', [
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-5', usage, content: [{ type: 'text', text: 'just talked' }] },
      },
    ]);

    const out = captureSessionUsageById('sess-idle');
    expect(out).not.toBeNull();
    expect(out!.outcomes).toBeUndefined();
  });
});
