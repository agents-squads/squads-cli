import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * Regression guard for the bundled Bash denylist PreToolUse hook.
 *
 * This hook once silently no-op'd: it read a non-existent `$CLAUDE_TOOL_INPUT`
 * env var instead of the JSON payload Claude Code pipes on stdin, so every
 * dangerous command slipped through. These tests run the actual hook command
 * from templates/guardrail.json with real payloads and assert the exit code
 * (2 = blocked, 0 = allowed). The hook only pattern-matches the command text —
 * it never executes it.
 */
const guardrailPath = fileURLToPath(new URL('../templates/guardrail.json', import.meta.url));
const guardrail = JSON.parse(readFileSync(guardrailPath, 'utf8'));
const bashHook = guardrail.hooks.PreToolUse.find((h: { matcher: string }) => h.matcher === 'Bash');
const hookCommand: string = bashHook.hooks[0].command;

function runHook(command: string): number | null {
  const payload = JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  return spawnSync('bash', ['-c', hookCommand], { input: payload, encoding: 'utf8' }).status;
}

describe('guardrail Bash denylist hook', () => {
  it.each([
    'git push --force origin main',
    'git push -f origin main',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'npm publish',
    'rm -rf /',
  ])('blocks dangerous command (exit 2): %s', (command) => {
    expect(runHook(command)).toBe(2);
  });

  it.each([
    'git status',
    'ls -la',
    'npm run build',
    'echo hello',
  ])('allows safe command (exit 0): %s', (command) => {
    expect(runHook(command)).toBe(0);
  });

  it('reads the command from tool_input on stdin, not a $CLAUDE_TOOL_INPUT env var', () => {
    // The old broken hook referenced $CLAUDE_TOOL_INPUT; ensure we don't regress to it.
    expect(hookCommand).not.toContain('CLAUDE_TOOL_INPUT');
    expect(hookCommand).toContain('tool_input');
  });
});
