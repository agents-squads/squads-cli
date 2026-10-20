/**
 * Tests for src/lib/provider-errors.ts (#1298 part 1).
 *
 * Fixtures are the response shapes the providers return, one per class per
 * provider we run, taken from the failures observed in the field (GLM 1309,
 * Moonshot exceeded_current_quota_error — see the issue) and from each
 * vendor's documented error envelope. They are not byte-captures of live
 * traffic; the structured fields the classifier reads are what matter.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyProviderError,
  extractProviderError,
  redactSecrets,
  providerErrorSentinel,
  parseProviderErrorSentinel,
  classifyFailedRun,
  providerForModel,
  type ProviderErrorType,
} from '../../src/lib/provider-errors.js';

interface Fixture {
  name: string;
  provider: string;
  status?: number;
  body: string;
  type: ProviderErrorType;
  retryable: boolean;
}

const FIXTURES: Fixture[] = [
  // ── GLM / z.ai ───────────────────────────────────────────────────────────
  {
    name: 'glm 429 code 1309 package expired is plan_expired, not a throttle',
    provider: 'glm', status: 429, type: 'plan_expired', retryable: false,
    body: '{"error":{"code":"1309","message":"Your Coding Plan package has expired, please renew."}}',
  },
  {
    name: 'glm 1314 plan_expired',
    provider: 'glm', status: 429, type: 'plan_expired', retryable: false,
    body: '{"error":{"code":"1314","message":"subscription ended"}}',
  },
  {
    name: 'glm 1113 no balance',
    provider: 'glm', status: 429, type: 'quota_exhausted', retryable: false,
    body: '{"error":{"code":"1113","message":"Insufficient balance or no resource package."}}',
  },
  {
    name: 'glm 1302 high concurrency is a retryable throttle',
    provider: 'glm', status: 429, type: 'rate_limited', retryable: true,
    body: '{"error":{"code":"1302","message":"Rate limit reached for requests"}}',
  },
  {
    name: 'glm 1311 model not in plan is bad_request',
    provider: 'glm', status: 429, type: 'bad_request', retryable: false,
    body: '{"error":{"code":"1311","message":"Current plan does not include this model"}}',
  },
  {
    name: 'glm 401 token expired',
    provider: 'glm', status: 401, type: 'auth_invalid', retryable: false,
    body: '{"error":{"code":"1001","message":"Header Authorization not found"}}',
  },
  // ── Moonshot / Kimi ──────────────────────────────────────────────────────
  {
    name: 'kimi 429 exceeded_current_quota_error is quota_exhausted, not rate_limited',
    provider: 'kimi', status: 429, type: 'quota_exhausted', retryable: false,
    body: '{"error":{"type":"exceeded_current_quota_error","message":"Your account org-x is suspended due to insufficient balance, please recharge."}}',
  },
  {
    name: 'kimi 429 engine overloaded',
    provider: 'kimi', status: 429, type: 'rate_limited', retryable: true,
    body: '{"error":{"type":"rate_limit_reached_error","message":"Your account is sending too many requests"}}',
  },
  {
    name: 'kimi 401 invalid authentication',
    provider: 'kimi', status: 401, type: 'auth_invalid', retryable: false,
    body: '{"error":{"type":"invalid_authentication_error","message":"The API Key appears to be invalid"}}',
  },
  // ── DeepSeek ─────────────────────────────────────────────────────────────
  {
    name: 'deepseek 402 insufficient balance',
    provider: 'deepseek', status: 402, type: 'quota_exhausted', retryable: false,
    body: '{"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}',
  },
  {
    name: 'deepseek 401 authentication fails',
    provider: 'deepseek', status: 401, type: 'auth_invalid', retryable: false,
    body: '{"error":{"message":"Authentication Fails, Your api key: ****abcd is invalid","type":"authentication_error"}}',
  },
  {
    name: 'deepseek 429 rate limit',
    provider: 'deepseek', status: 429, type: 'rate_limited', retryable: true,
    body: '{"error":{"message":"Rate Limit Reached","type":"rate_limit_error"}}',
  },
  {
    name: 'deepseek 503 server overloaded',
    provider: 'deepseek', status: 503, type: 'overloaded', retryable: true,
    body: '{"error":{"message":"Server is busy, please try again later.","type":"server_error"}}',
  },
  // ── Anthropic ────────────────────────────────────────────────────────────
  {
    name: 'anthropic 401',
    provider: 'anthropic', status: 401, type: 'auth_invalid', retryable: false,
    body: '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
  },
  {
    name: 'anthropic 429',
    provider: 'anthropic', status: 429, type: 'rate_limited', retryable: true,
    body: '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your organization\'s rate limit"}}',
  },
  {
    name: 'anthropic 529',
    provider: 'anthropic', status: 529, type: 'overloaded', retryable: true,
    body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  },
  {
    name: 'anthropic 400 credit balance too low is quota_exhausted, not bad_request',
    provider: 'anthropic', status: 400, type: 'quota_exhausted', retryable: false,
    body: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
  },
  {
    name: 'anthropic 400 malformed request',
    provider: 'anthropic', status: 400, type: 'bad_request', retryable: false,
    body: '{"type":"error","error":{"type":"invalid_request_error","message":"messages.0.content: Field required"}}',
  },
  {
    name: 'anthropic 403 permission',
    provider: 'anthropic', status: 403, type: 'auth_invalid', retryable: false,
    body: '{"type":"error","error":{"type":"permission_error","message":"Your API key does not have permission to use the specified resource."}}',
  },
  // ── OpenAI-style (gpt lane) ──────────────────────────────────────────────
  {
    name: 'openai 429 insufficient_quota is quota_exhausted',
    provider: 'gpt', status: 429, type: 'quota_exhausted', retryable: false,
    body: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
  },
  {
    name: 'openai 429 tokens-per-minute stays a throttle (no bare /quota/ match)',
    provider: 'gpt', status: 429, type: 'rate_limited', retryable: true,
    body: '{"error":{"message":"Rate limit reached for gpt in organization org-x on tokens per min (TPM): Limit 30000, quota used 29990.","type":"tokens","code":"rate_limit_exceeded"}}',
  },
  // ── opencode / non-HTTP ──────────────────────────────────────────────────
  {
    name: 'opencode Invalid credential has no status',
    provider: 'opencode', type: 'auth_invalid', retryable: false,
    body: 'Error: Invalid credential for provider zai',
  },
  {
    name: 'connection reset is network',
    provider: 'glm', type: 'network', retryable: true,
    body: 'API Error: read ECONNRESET',
  },
  {
    name: 'unclassifiable text stays unknown and non-retryable',
    provider: 'glm', type: 'unknown', retryable: false,
    body: 'something odd happened',
  },
];

describe('classifyProviderError', () => {
  it.each(FIXTURES)('$name', ({ provider, status, body, type, retryable }) => {
    const r = classifyProviderError(provider, status, body);
    expect(r.type).toBe(type);
    expect(r.retryable).toBe(retryable);
    expect(r.provider).toBe(provider);
    if (status !== undefined) expect(r.status).toBe(status);
  });

  it('keeps the provider code as evidence', () => {
    const r = classifyProviderError('glm', 429, FIXTURES[0].body);
    expect(r.providerCode).toBe('1309');
    expect(r.message).toContain('package has expired');
  });

  it('numeric codes outrank the HTTP status (429 + 1309 is never rate_limited)', () => {
    expect(classifyProviderError('glm', 429, '{"code":1309,"message":"x"}').type).toBe('plan_expired');
  });

  it('reads the code from details[].reason', () => {
    const body = '{"error":{"message":"denied","details":[{"reason":"permission_denied"}]}}';
    expect(classifyProviderError('x', undefined, body).type).toBe('auth_invalid');
  });

  it('redacts keys in the message and caps its length', () => {
    const body = `{"error":{"message":"bad key sk-abcdefghijklmnop1234 ${'x'.repeat(900)}","type":"authentication_error"}}`;
    const r = classifyProviderError('deepseek', 401, body);
    expect(r.message).not.toContain('sk-abcdefghijklmnop1234');
    expect(r.message).toContain('[redacted-key]');
    expect(r.message.length).toBeLessThanOrEqual(500);
  });
});

describe('extractProviderError', () => {
  it('finds the status and body inside a claude result text', () => {
    const text = `API Error: 429 ${FIXTURES[0].body}`;
    const r = extractProviderError('glm', text);
    expect(r?.type).toBe('plan_expired');
    expect(r?.status).toBe(429);
    expect(r?.retryable).toBe(false);
  });

  it('classifies Anthropic 529 from "API Error: 529" text', () => {
    expect(extractProviderError('anthropic', `API Error: 529 ${FIXTURES.find((f) => f.provider === 'anthropic' && f.status === 529)!.body}`)?.type).toBe('overloaded');
  });

  it('returns null for healthy output', () => {
    expect(extractProviderError('glm', 'All done. Opened PR #12 and ran the tests.')).toBeNull();
    expect(extractProviderError('glm', '')).toBeNull();
  });
});

describe('redactSecrets', () => {
  it('masks bearer tokens, sk- keys and GitHub tokens', () => {
    const out = redactSecrets('Authorization: Bearer abcdef1234567890 sk-live-abcdefgh12345 ghs_abcdefghijklmnopqrst');
    expect(out).not.toMatch(/abcdef1234567890|sk-live|ghs_abc/);
  });
});

describe('sentinel', () => {
  it('round-trips the type through turn text', () => {
    const err = classifyProviderError('glm', 429, FIXTURES[0].body);
    const text = providerErrorSentinel(err, 'cli-lead');
    expect(parseProviderErrorSentinel(text)).toBe('plan_expired');
    expect(parseProviderErrorSentinel('plain text')).toBeNull();
  });
});

// ── Review of #1333 ──────────────────────────────────────────────────────────
const PROSE = 'Documented HTTP 401 handling: HTTP 401 means the request was unauthorized. All tests pass.';
const GLM_BODY = 'API Error: 429 {"error":{"code":"1309","message":"Your Coding Plan package has expired, please renew."}}';

describe('classifyFailedRun — structural evidence only', () => {
  it('never reads the result text of a run that did not report is_error', () => {
    expect(classifyFailedRun({ provider: 'anthropic', structured: true, resultText: PROSE, resultIsError: false })).toBeNull();
  });

  it('reads an is_error result, the fatal line and stderr', () => {
    expect(classifyFailedRun({ provider: 'glm', structured: true, resultText: GLM_BODY, resultIsError: true })?.type).toBe('plan_expired');
    expect(classifyFailedRun({ provider: 'glm', structured: true, fatal: GLM_BODY })?.type).toBe('plan_expired');
    expect(classifyFailedRun({ provider: 'glm', structured: true, stderr: GLM_BODY })?.type).toBe('plan_expired');
  });

  it('ignores the raw tail of a structured log (it is agent prose)', () => {
    expect(classifyFailedRun({ provider: 'glm', structured: true, rawTail: GLM_BODY })).toBeNull();
  });

  it('reads a plain-text tail only when it carries a provider-error anchor', () => {
    expect(classifyFailedRun({ provider: 'aider', structured: false, rawTail: PROSE })).toBeNull();
    expect(classifyFailedRun({ provider: 'aider', structured: false, rawTail: GLM_BODY })?.type).toBe('plan_expired');
  });
});

describe('providerForModel', () => {
  it('names the vendor serving a claude-harness lane, not the harness', () => {
    expect(providerForModel('glm-4.7')).toBe('glm');
    expect(providerForModel('deepseek-v4-flash')).toBe('deepseek');
    expect(providerForModel('kimi-k3')).toBe('kimi');
    expect(providerForModel('sonnet')).toBe('anthropic');
    expect(providerForModel(undefined)).toBe('anthropic');
  });
});

describe('parseProviderErrorSentinel — validated', () => {
  it('rejects a class that is not a ProviderErrorType', () => {
    expect(parseProviderErrorSentinel('[PROVIDER_ERROR:whatever] agent output')).toBeNull();
    expect(parseProviderErrorSentinel('[PROVIDER_ERROR:quota_exhausted] x')).toBe('quota_exhausted');
  });
});

describe('redactSecrets — more key formats', () => {
  it.each([
    ['stripe', 'key sk_live_abcdefgh12345678 here'],
    ['stripe restricted', 'key rk_test_abcdefgh12345678 here'],
    ['aws', 'key AKIAIOSFODNN7EXAMPLE here'],
    ['google', 'key AIzaSyA1234567890abcdefghijklmnopqrstuv here'],
    ['slack', 'token xoxb-1234567890-abcdefghij here'],
  ])('masks %s keys', (_name, text) => {
    expect(redactSecrets(text)).toContain('[redacted-key]');
    expect(redactSecrets(text)).not.toMatch(/abcdefgh1234|AKIAIOSFODNN7|AIzaSy|xoxb-1234/);
  });
});
