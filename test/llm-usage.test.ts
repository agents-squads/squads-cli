import { describe, it, expect } from 'vitest';
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
