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
