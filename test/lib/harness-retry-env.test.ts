import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCLIConfig, harnessRetryEnv } from '../../src/lib/llm-clis.js';
import { clearProviderRegistryCache } from '../../src/lib/provider-registry.js';

const RETRY_KEY = 'CLAUDE_CODE_MAX_RETRIES';

describe('harness retry env (#1298)', () => {
  let dir: string | undefined;
  const prev = process.env[RETRY_KEY];

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    delete process.env.SQUADS_PROVIDERS_FILE;
    clearProviderRegistryCache();
    if (prev === undefined) delete process.env[RETRY_KEY];
    else process.env[RETRY_KEY] = prev;
  });

  it('caps the claude harness at 2 retries for deepseek/glm/kimi by default', () => {
    delete process.env[RETRY_KEY];
    for (const provider of ['deepseek', 'glm', 'kimi']) {
      expect(getCLIConfig(provider)!.env!()[RETRY_KEY]).toBe('2');
    }
  });

  it('a registry claude-harness entry gets the cap too', () => {
    dir = mkdtempSync(join(tmpdir(), 'squads-retry-test-'));
    const file = join(dir, 'providers.yaml');
    writeFileSync(file, `
providers:
  acme:
    harness: claude
    base_url: https://api.acme.test/anthropic
    models: [acme-fast]
`);
    process.env.SQUADS_PROVIDERS_FILE = file;
    delete process.env[RETRY_KEY];
    expect(getCLIConfig('acme')!.env!()[RETRY_KEY]).toBe('2');
  });

  it('does NOT set the cap on anthropic or non-claude harnesses', () => {
    delete process.env[RETRY_KEY];
    expect(getCLIConfig('anthropic')!.env?.[RETRY_KEY]).toBeUndefined();
    expect(getCLIConfig('opencode')!.env?.[RETRY_KEY]).toBeUndefined();
    expect(getCLIConfig('aider')!.env?.[RETRY_KEY]).toBeUndefined();
    expect(getCLIConfig('google')!.env?.[RETRY_KEY]).toBeUndefined();
    expect(getCLIConfig('openai')!.env?.[RETRY_KEY]).toBeUndefined();
  });

  it('an operator-set value always wins', () => {
    process.env[RETRY_KEY] = '5';
    expect(harnessRetryEnv()[RETRY_KEY]).toBe('5');
    expect(getCLIConfig('glm')!.env!()[RETRY_KEY]).toBe('5');
  });
});
