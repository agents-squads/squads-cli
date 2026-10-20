import { describe, it, expect } from 'vitest';
import { computeBilling } from '../../src/lib/billing.js';

describe('computeBilling (#1355)', () => {
  it('metered: tokens × the provider\'s own price, source names the table + date', () => {
    const b = computeBilling({
      provider: 'deepseek',
      model: 'deepseek-chat',
      harness: 'claude',
      input_tokens: 1_000_000,
      output_tokens: 2_000_000,
    });
    expect(b.kind).toBe('metered');
    // 1M input × $0.27 + 2M output × $1.10
    expect(b.usd).toBeCloseTo(0.27 + 2.2, 6);
    expect(b.source).toContain('provider-prices.json@');
    expect(b.source).toContain('deepseek');
  });

  it('subscription: kimi-code rides the flat plan — usd 0, kind says so', () => {
    const b = computeBilling({
      provider: 'kimi-code',
      model: 'kimi-code/k3',
      harness: 'kimi-code',
      input_tokens: 1000,
      output_tokens: 2000,
    });
    expect(b.kind).toBe('subscription');
    expect(b.usd).toBe(0);
    expect(b.source).toContain('subscription');
  });

  it('free: an opencode free model is 0, kind free', () => {
    const b = computeBilling({
      provider: 'opencode',
      model: 'opencode/deepseek-v4.1-flash-free',
      harness: 'opencode',
      input_tokens: 5000,
      output_tokens: 900,
    });
    expect(b.kind).toBe('free');
    expect(b.usd).toBe(0);
    expect(b.source).toContain('free');
  });

  it('metered but no price entry → usd null, never a fabricated figure', () => {
    const b = computeBilling({
      provider: 'glm',
      model: 'glm-4.7',
      harness: 'claude',
      input_tokens: 100,
      output_tokens: 100,
    });
    expect(b.kind).toBe('metered');
    expect(b.usd).toBeNull();
    expect(b.source).toContain('no price entry');
  });

  it('opencode-hosted paid model bills the inner provider', () => {
    const b = computeBilling({
      provider: 'opencode',
      model: 'deepseek/deepseek-chat',
      harness: 'opencode',
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(b.kind).toBe('metered');
    expect(b.usd).toBeCloseTo(0.27, 6);
    expect(b.source).toContain('deepseek');
  });

  it('anthropic metering includes cache read/write at the cache rates', () => {
    const b = computeBilling({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      harness: 'claude',
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 1_000_000,
      cache_write_tokens: 1_000_000,
    });
    expect(b.kind).toBe('metered');
    // 1M cache read × $0.30 + 1M cache write × $3.75
    expect(b.usd).toBeCloseTo(0.3 + 3.75, 6);
  });

  it('falls back to the provider default when the model is unknown', () => {
    const b = computeBilling({
      provider: 'deepseek',
      model: 'deepseek-v9-future',
      harness: 'claude',
      input_tokens: 1_000_000,
      output_tokens: 0,
    });
    expect(b.kind).toBe('metered');
    expect(b.usd).toBeCloseTo(0.27, 6);
  });
});
