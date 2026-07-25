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
    // deepseek moved to the claude harness (#1159) — stream-json usage now.
    expect(LLM_CLIS.deepseek.parseUsage).not.toBe(parseAiderUsage);
    expect(LLM_CLIS.deepseek.streamJson).toBe(true);
  });
});

describe('aider map-tokens knob (#845)', () => {
  afterEach(() => {
    delete process.env.SQUADS_AIDER_MAP_TOKENS;
  });

  it('unset env keeps aider defaults (no --map-tokens)', () => {
    delete process.env.SQUADS_AIDER_MAP_TOKENS;
    const args = LLM_CLIS.aider.buildArgs('hi');
    expect(args).not.toContain('--map-tokens');
  });

  it('caps the repo map when SQUADS_AIDER_MAP_TOKENS is set', () => {
    process.env.SQUADS_AIDER_MAP_TOKENS = '2048';
    const args = LLM_CLIS.aider.buildArgs('hi');
    const i = args.indexOf('--map-tokens');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe('2048');
  });

  it('rejects non-integer values (no flag emitted)', () => {
    process.env.SQUADS_AIDER_MAP_TOKENS = 'lots';
    expect(LLM_CLIS.aider.buildArgs('hi')).not.toContain('--map-tokens');
  });
});

describe('deepseek model guard (#937 — foreign model names must not reach the API)', () => {
  afterEach(() => { delete process.env.DEEPSEEK_MODEL; });

  it('ignores anthropic frontmatter models and uses the lane default', () => {
    const args = LLM_CLIS.deepseek.buildArgs('hi', { model: 'claude-sonnet-4-5' });
    // Bare model name on the claude harness (#1159) — the endpoint routes it.
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek-v4-flash');
  });

  it('honors real deepseek model overrides and DEEPSEEK_MODEL env', () => {
    let args = LLM_CLIS.deepseek.buildArgs('hi', { model: 'deepseek/deepseek-v4-pro' });
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek-v4-pro');
    process.env.DEEPSEEK_MODEL = 'deepseek-v4-pro';
    args = LLM_CLIS.deepseek.buildArgs('hi');
    expect(args[args.indexOf('--model') + 1]).toBe('deepseek-v4-pro');
  });

  it('runs the claude harness against the DeepSeek Anthropic endpoint (#1159)', () => {
    const cfg = LLM_CLIS.deepseek;
    expect(cfg.command).toBe('claude');
    const args = cfg.buildArgs('do the task', { allowedTools: ['Edit', 'Write'] });
    expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3)).toEqual(['Edit', 'Write']);
    expect(args[args.length - 1]).toBe('do the task');
    const env = cfg.env!();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
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

describe('kimi lane (Moonshot Anthropic-compatible endpoint via claude CLI)', () => {
  afterEach(() => {
    delete process.env.KIMI_API_KEY;
    delete process.env.KIMI_BASE_URL;
    delete process.env.KIMI_MODEL;
  });

  it('delegates to the claude CLI in non-interactive print mode with a stream-json argv', () => {
    expect(LLM_CLIS.kimi.command).toBe('claude');
    expect(LLM_CLIS.kimi.streamJson).toBe(true);
    const args = LLM_CLIS.kimi.buildArgs('do the thing', { allowedTools: ['Read', 'Edit'] });
    expect(args[0]).toBe('--print');
    expect(args).toContain('stream-json');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Read');
    expect(args[args.length - 1]).toBe('do the thing');
  });

  it('defaults to kimi-k3 and honors override precedence (opts > KIMI_MODEL)', () => {
    expect(LLM_CLIS.kimi.buildArgs('hi')).toContain('kimi-k3');
    process.env.KIMI_MODEL = 'kimi-k2.7-code';
    expect(LLM_CLIS.kimi.buildArgs('hi')).toContain('kimi-k2.7-code');
    expect(LLM_CLIS.kimi.buildArgs('hi', { model: 'kimi-k3' })).toContain('kimi-k3');
  });

  it('maps KIMI_API_KEY to ANTHROPIC_AUTH_TOKEN and removes shadowing vars', () => {
    process.env.KIMI_API_KEY = 'moonshot-test-key';
    const env = LLM_CLIS.kimi.env!();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('moonshot-test-key');
    // undefined = the runner must DELETE these, or an inherited ANTHROPIC_API_KEY
    // silently routes the Kimi run to Anthropic instead.
    expect(env).toHaveProperty('ANTHROPIC_API_KEY', undefined);
    expect(env).toHaveProperty('ANTHROPIC_MODEL', undefined);
  });

  it('honors KIMI_BASE_URL override', () => {
    process.env.KIMI_BASE_URL = 'https://proxy.example/anthropic';
    expect(LLM_CLIS.kimi.env!().ANTHROPIC_BASE_URL).toBe('https://proxy.example/anthropic');
  });
});

describe('opencode lane (#1177 — fallback harness, `opencode run --format json`)', () => {
  it('is registered in LLM_CLIS with the right identity', () => {
    expect(LLM_CLIS.opencode.provider).toBe('opencode');
    expect(LLM_CLIS.opencode.displayName).toBe('OpenCode (fallback harness)');
    expect(LLM_CLIS.opencode.command).toBe('opencode');
  });

  it('builds a headless run with --format json, --auto, and the prompt LAST', () => {
    const args = LLM_CLIS.opencode.buildArgs('do the thing');
    expect(args).toEqual(['run', '--format', 'json', '--auto', 'do the thing']);
  });

  it('appends --model and --dir before the prompt when provided', () => {
    const args = LLM_CLIS.opencode.buildArgs('hi', { model: 'deepseek/deepseek-chat', cwd: '/repo' });
    expect(args).toEqual(['run', '--format', 'json', '--auto', '--model', 'deepseek/deepseek-chat', '--dir', '/repo', 'hi']);
  });

  // #1177: opencode is the fallback HARNESS — full observability parity
  // (its own JSONL shape + real provider-priced usage), never Claude stream-json.
  it('declares opencodeJson (not streamJson) and parses its own usage', () => {
    expect(LLM_CLIS.opencode.streamJson).toBeUndefined();
    expect(LLM_CLIS.opencode.opencodeJson).toBe(true);
    expect(typeof LLM_CLIS.opencode.parseUsage).toBe('function');
  });
});

describe('detectProviderFatalError (#936 — exit-0 API failures must fail loud)', () => {
  it('catches the real failure classes seen in production', async () => {
    const { detectProviderFatalError } = await import('../src/lib/llm-clis.js');
    expect(detectProviderFatalError('litellm.BadRequestError: DeepseekException - {"error":...}')).toContain('litellm.BadRequestError');
    expect(detectProviderFatalError('The supported API model names are deepseek-v4-pro')).toBeTruthy();
    expect(detectProviderFatalError('[1113][Insufficient balance or no resource package. Please recharge.]')).toBeTruthy();
    expect(detectProviderFatalError('You exceeded your current quota, please check your plan')).toBeTruthy();
    expect(detectProviderFatalError('Error: invalid api key provided')).toBeTruthy();
    expect(detectProviderFatalError('AI_APICallError: Incorrect API key provided')).toBeTruthy();
    expect(detectProviderFatalError('AI_APICallError: No auth credentials found')).toBeTruthy();
  });
  it('stays quiet on healthy output', async () => {
    const { detectProviderFatalError } = await import('../src/lib/llm-clis.js');
    expect(detectProviderFatalError('Applied edit to docs/commands.md\nTokens: 57k sent, 1.7k received.')).toBeNull();
    expect(detectProviderFatalError('discussed error handling in the docs')).toBeNull();
  });
});
