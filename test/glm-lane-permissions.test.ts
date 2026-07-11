/**
 * #1073 — the GLM lane runs `claude --print`, where permission prompts can't
 * be answered; without an explicit allowlist every Edit/Write is denied and
 * the lane is read-only. Locks the buildArgs permission surface.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { getCLIConfig, parseGlmStreamUsage } from '../src/lib/llm-clis.js';

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

  it('emits stream-json (with the required --verbose) so usage/outcomes are parseable (#1077)', () => {
    const args = glm.buildArgs('do the task');
    const idx = args.indexOf('--output-format');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
  });
});

describe('parseGlmStreamUsage (#1077)', () => {
  afterEach(() => {
    delete process.env.SQUADS_GLM_COST_PER_MTOK_IN;
    delete process.env.SQUADS_GLM_COST_PER_MTOK_OUT;
  });

  const resultLine = JSON.stringify({
    type: 'result', result: 'done', is_error: false, num_turns: 3, cost_usd: 0,
    usage: { input_tokens: 200_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });

  it('reads tokens from the terminal result event; cost stays 0 without env rates (visible gap, not fabricated)', () => {
    const out = parseGlmStreamUsage(resultLine + '\n');
    expect(out).toEqual({ input_tokens: 200_000, output_tokens: 10_000, cost_usd: 0 });
  });

  it('derives cost from env-configured $/Mtok rates when the CLI priced it 0', () => {
    process.env.SQUADS_GLM_COST_PER_MTOK_IN = '0.6';
    process.env.SQUADS_GLM_COST_PER_MTOK_OUT = '2.2';
    const out = parseGlmStreamUsage(resultLine + '\n');
    expect(out!.cost_usd).toBeCloseTo(0.6 * 0.2 + 2.2 * 0.01, 6); // 200k in + 10k out
  });

  it('returns null when the stream carried no usage', () => {
    expect(parseGlmStreamUsage('not json\n')).toBeNull();
  });
});
