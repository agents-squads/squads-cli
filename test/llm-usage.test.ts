import { describe, it, expect, afterEach } from 'vitest';
import { parseAiderUsage, LLM_CLIS } from '../src/lib/llm-clis.js';

describe('parseAiderUsage (#824 — provider runs must be observable)', () => {
  it('parses a single usage line with cost', () => {
    const out = 'Applied edit to report.md\nTokens: 57k sent, 1.7k received. Cost: $0.02 message, $0.02 session.\n';
    expect(parseAiderUsage(out)).toEqual({ input_tokens: 57_000, output_tokens: 1_700, cost_usd: 0.02 });
  });

  it('sums tokens across messages and keeps the last (cumulative) session cost', () => {
    const out = [
      'Tokens: 2.3k sent, 150 received. Cost: $0.001 message, $0.001 session.',
      'Tokens: 4.1k sent, 1.2k received. Cost: $0.002 message, $0.003 session.',
    ].join('\n');
    expect(parseAiderUsage(out)).toEqual({ input_tokens: 6_400, output_tokens: 1_350, cost_usd: 0.003 });
  });

  it('handles plain counts and missing cost (free/local models)', () => {
    const out = 'Tokens: 1,234 sent, 1 received.\n';
    expect(parseAiderUsage(out)).toEqual({ input_tokens: 1_234, output_tokens: 1, cost_usd: 0 });
  });

  it('returns null when no usage line is present', () => {
    expect(parseAiderUsage('no usage here')).toBeNull();
  });

  it('is wired into the aider-backed registry entries', () => {
    expect(LLM_CLIS.aider.parseUsage).toBe(parseAiderUsage);
    expect(LLM_CLIS.deepseek.parseUsage).toBe(parseAiderUsage);
  });
});

describe('aider map-tokens knob (#845)', () => {
  afterEach(() => {
    delete process.env.SQUADS_AIDER_MAP_TOKENS;
  });

  it('unset env keeps aider defaults (no --map-tokens)', () => {
    delete process.env.SQUADS_AIDER_MAP_TOKENS;
    const args = LLM_CLIS.deepseek.buildArgs('hi');
    expect(args).not.toContain('--map-tokens');
  });

  it('caps the repo map when SQUADS_AIDER_MAP_TOKENS is set', () => {
    process.env.SQUADS_AIDER_MAP_TOKENS = '2048';
    for (const provider of ['deepseek', 'aider']) {
      const args = LLM_CLIS[provider].buildArgs('hi');
      const i = args.indexOf('--map-tokens');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe('2048');
    }
  });

  it('rejects non-integer values (no flag emitted)', () => {
    process.env.SQUADS_AIDER_MAP_TOKENS = 'lots';
    expect(LLM_CLIS.deepseek.buildArgs('hi')).not.toContain('--map-tokens');
  });
});

describe('deepseek model guard (#937 — foreign model names must not reach the API)', () => {
  afterEach(() => { delete process.env.DEEPSEEK_MODEL; });

  it('ignores anthropic frontmatter models and uses the lane default', () => {
    const args = LLM_CLIS.deepseek.buildArgs('hi', { model: 'claude-sonnet-4-5' });
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek/deepseek-v4-flash');
  });

  it('honors real deepseek model overrides and DEEPSEEK_MODEL env', () => {
    expect(LLM_CLIS.deepseek.buildArgs('hi', { model: 'deepseek/deepseek-v4-pro' })).toContain('deepseek/deepseek-v4-pro');
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
    expect(LLM_CLIS.deepseek.buildArgs('hi')).toContain('deepseek/deepseek-v4-pro');
  });
});

describe('glm lane (#926 — z.ai Anthropic-compatible endpoint via claude CLI)', () => {
  afterEach(() => {
    delete process.env.GLM_API_KEY;
    delete process.env.GLM_BASE_URL;
    delete process.env.GLM_MODEL;
  });

  it('delegates to the claude CLI in non-interactive print mode', () => {
    expect(LLM_CLIS.glm.command).toBe('claude');
    const args = LLM_CLIS.glm.buildArgs('do the thing');
    expect(args[0]).toBe('--print');
    expect(args).toContain('do the thing');
  });

  it('defaults the model and honors override precedence (opts > GLM_MODEL)', () => {
    expect(LLM_CLIS.glm.buildArgs('hi')).toContain('glm-4.7');
    process.env.GLM_MODEL = 'glm-4.6';
    expect(LLM_CLIS.glm.buildArgs('hi')).toContain('glm-4.6');
    expect(LLM_CLIS.glm.buildArgs('hi', { model: 'glm-4.7-air' })).toContain('glm-4.7-air');
  });

  it('maps GLM_API_KEY to ANTHROPIC_AUTH_TOKEN and removes shadowing vars', () => {
    process.env.GLM_API_KEY = 'zai-test-key';
    const env = LLM_CLIS.glm.env!();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('zai-test-key');
    // undefined = the runner must DELETE these from the child env, or an
    // inherited ANTHROPIC_API_KEY silently routes the run to Anthropic
    expect(env).toHaveProperty('ANTHROPIC_API_KEY', undefined);
    expect(env).toHaveProperty('ANTHROPIC_MODEL', undefined);
  });

  it('honors GLM_BASE_URL override', () => {
    process.env.GLM_BASE_URL = 'https://proxy.example/anthropic';
    expect(LLM_CLIS.glm.env!().ANTHROPIC_BASE_URL).toBe('https://proxy.example/anthropic');
  });
});
