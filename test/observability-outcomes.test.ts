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

  it('derives artifacts from tool_results, not command text (cli#1134)', () => {
    // The Bash create commands only flag candidates; the count comes from the
    // paired tool_result on the next `user` event. The `gh pr create` here has
    // NO result URL, so it must count 0 — counting its command text was the bug.
    writeSession('sess-real', [
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          usage,
          content: [
            { type: 'text', text: 'editing' },
            { type: 'tool_use', id: 'toolu_e', name: 'Edit', input: { file_path: '/x' } },
            { type: 'tool_use', id: 'toolu_c', name: 'Bash', input: { command: 'git add -A && git commit -m "x"' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_c', content: '[main abc1234] x\n 1 file changed' }],
        },
      },
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          usage,
          content: [{ type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'gh pr create --title x' } }],
        },
      },
      // No tool_result for toolu_p with a verified URL → prs_created stays 0.
    ]);

    const out = captureSessionUsageById('sess-real');
    expect(out).not.toBeNull();
    expect(out!.outcomes).toEqual({
      actions: 3,
      files_edited: 1,
      commits: 1,        // verified [main abc1234] in toolu_c's result
      prs_created: 0,    // command ran but no verified /pull/N URL → 0 (cli#1134)
      issues_created: 0,
    });
  });

  it('counts a verified PR URL from the tool_result (cli#1134)', () => {
    writeSession('sess-pr', [
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          usage,
          content: [{ type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'gh pr create' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_p',
            content: 'https://github.com/agents-squads/squads-cli/pull/1134',
          }],
        },
      },
    ]);
    const out = captureSessionUsageById('sess-pr');
    expect(out).not.toBeNull();
    expect(out!.outcomes!.prs_created).toBe(1);
    expect(out!.outcomes!.commits).toBe(0);
  });

  it('counts ZERO for a failed gh pr create (is_error result)', () => {
    writeSession('sess-fail', [
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          usage,
          content: [{ type: 'tool_use', id: 'toolu_p', name: 'Bash', input: { command: 'gh pr create' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_p',
            is_error: true,
            content: 'Warning: no commits resolved; exiting',
          }],
        },
      },
    ]);
    const out = captureSessionUsageById('sess-fail');
    expect(out).not.toBeNull();
    expect(out!.outcomes!.prs_created).toBe(0);
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

describe('session_id on captured usage (#1129)', () => {
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

  it('captureSessionUsageById returns the session file basename as session_id', () => {
    writeSession('11111111-2222-3333-4444-555555555555', [
      { type: 'assistant', message: { model: 'claude-sonnet-5', usage } },
    ]);

    const out = captureSessionUsageById('11111111-2222-3333-4444-555555555555');
    expect(out).not.toBeNull();
    expect(out!.session_id).toBe('11111111-2222-3333-4444-555555555555');
  });
});
