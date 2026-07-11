/**
 * #1073 — the GLM lane runs `claude --print`, where permission prompts can't
 * be answered; without an explicit allowlist every Edit/Write is denied and
 * the lane is read-only. Locks the buildArgs permission surface.
 */
import { describe, it, expect } from 'vitest';
import { getCLIConfig } from '../src/lib/llm-clis.js';

describe('glm lane permission surface (#1073)', () => {
  const glm = getCLIConfig('glm')!;

  it('passes the compiled allowlist through --allowedTools', () => {
    const args = glm.buildArgs('do the task', { allowedTools: ['Edit', 'Write', 'Bash(git:*)'] });
    const idx = args.indexOf('--allowedTools');
    expect(idx).toBeGreaterThan(-1);
    expect(args.slice(idx + 1, idx + 4)).toEqual(['Edit', 'Write', 'Bash(git:*)']);
    // Prompt stays the final argument.
    expect(args[args.length - 1]).toBe('do the task');
    expect(args).toContain('--disable-slash-commands');
  });

  it('omits --allowedTools when no allowlist is provided (legacy read-only shape)', () => {
    const args = glm.buildArgs('do the task', { model: 'glm-4.7' });
    expect(args).not.toContain('--allowedTools');
    expect(args[args.length - 1]).toBe('do the task');
  });
});
