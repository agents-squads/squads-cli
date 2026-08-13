import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadProviderRegistry,
  clearProviderRegistryCache,
  credentialState,
  anthropicCompatEnv,
  type ProviderEntry,
} from '../../src/lib/provider-registry.js';

let dir: string;
let file: string;

beforeEach(() => {
  clearProviderRegistryCache();
  dir = mkdtempSync(join(tmpdir(), 'squads-registry-test-'));
  file = join(dir, 'providers.yaml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SQUADS_PROVIDERS_FILE;
  delete process.env.TEST_PROVIDER_KEY;
});

const write = (yaml: string) => writeFileSync(file, yaml);

describe('loadProviderRegistry', () => {
  it('absent file is not an error — a fresh `squads init` has no registry', () => {
    const r = loadProviderRegistry(join(dir, 'nope.yaml'));
    expect(r.providers).toEqual({});
    expect(r.errors).toEqual([]);
    expect(r.source).toBeNull();
  });

  it('loads an anthropic-compatible provider as data', () => {
    write(`
providers:
  acme:
    harness: claude
    base_url: https://api.acme.test/anthropic
    key_ref: acme-api-key
    required_env: [ACME_API_KEY]
    models: [acme-fast, acme-pro]
`);
    const r = loadProviderRegistry(file);
    expect(r.errors).toEqual([]);
    expect(r.providers.acme.harness).toBe('claude');
    expect(r.providers.acme.models).toEqual(['acme-fast', 'acme-pro']);
    expect(r.providers.acme.name).toBe('acme');
  });

  it('accepts harness: native — the seam is in the schema from the start', () => {
    write(`
providers:
  acme:
    harness: native
    api: anthropic-messages
    base_url: https://api.acme.test
    tools: [read, write, bash]
`);
    const r = loadProviderRegistry(file);
    expect(r.errors).toEqual([]);
    expect(r.providers.acme.harness).toBe('native');
    expect(r.providers.acme.tools).toContain('bash');
  });

  it('rejects native without base_url — there would be nothing to talk to', () => {
    write(`
providers:
  acme:
    harness: native
`);
    const r = loadProviderRegistry(file);
    expect(r.providers.acme).toBeUndefined();
    expect(r.errors.join()).toMatch(/requires 'base_url'/);
  });

  it('rejects an unknown harness by name', () => {
    write(`
providers:
  acme:
    harness: telepathy
`);
    const r = loadProviderRegistry(file);
    expect(r.errors.join()).toMatch(/unknown harness 'telepathy'/);
  });

  it('one bad entry never takes out the good ones', () => {
    write(`
providers:
  good:
    harness: claude
    base_url: https://ok.test
  bad:
    harness: nonsense
`);
    const r = loadProviderRegistry(file);
    expect(r.providers.good).toBeDefined();
    expect(r.providers.bad).toBeUndefined();
    expect(r.errors).toHaveLength(1);
  });

  it('malformed YAML reports an error instead of throwing', () => {
    write('providers:\n  acme:\n   - [unbalanced\n');
    const r = loadProviderRegistry(file);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.providers).toEqual({});
  });
});

describe('credentialState', () => {
  const entry = (over: Partial<ProviderEntry> = {}): ProviderEntry => ({
    name: 'acme', harness: 'claude', base_url: 'https://x.test',
    key_ref: 'acme-api-key', required_env: ['TEST_PROVIDER_KEY'], ...over,
  });

  it('is not ok when neither the secrets file nor the env var exists', () => {
    const s = credentialState(entry());
    expect(s.ok).toBe(false);
    expect(s.missingEnv).toEqual(['TEST_PROVIDER_KEY']);
  });

  it('is ok from the declared env var alone', () => {
    process.env.TEST_PROVIDER_KEY = 'sk-test';
    const s = credentialState(entry());
    expect(s.ok).toBe(true);
    expect(s.missingEnv).toEqual([]);
  });

  it('a provider needing no credential is ok', () => {
    const s = credentialState(entry({ key_ref: undefined, required_env: [] }));
    expect(s.ok).toBe(true);
  });

  it('names the missing variable so the dispatch error can be specific', () => {
    const s = credentialState(entry({ required_env: ['A_KEY', 'B_KEY'] }));
    expect(s.missingEnv).toEqual(['A_KEY', 'B_KEY']);
  });
});

describe('anthropicCompatEnv', () => {
  it('injects the endpoint and REMOVES inherited Anthropic vars that would shadow it', () => {
    process.env.TEST_PROVIDER_KEY = 'sk-test';
    const env = anthropicCompatEnv({
      name: 'acme', harness: 'claude',
      base_url: 'https://api.acme.test/anthropic',
      required_env: ['TEST_PROVIDER_KEY'],
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.acme.test/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-test');
    // Explicitly undefined => removed from the child env. An inherited real
    // Anthropic key must never shadow the foreign provider's token.
    expect(env).toHaveProperty('ANTHROPIC_API_KEY');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env).toHaveProperty('ANTHROPIC_MODEL');
    expect(env.ANTHROPIC_MODEL).toBeUndefined();
  });
});

describe('secrets-file path safety', () => {
  it('a key_ref cannot escape the secrets directory', async () => {
    const { readProviderSecret } = await import('../../src/lib/provider-registry.js');
    expect(readProviderSecret('../../.ssh/id_rsa')).toBeNull();
    expect(readProviderSecret('nested/key')).toBeNull();
  });
});

describe('getCLIConfig integration', () => {
  it('a registry provider becomes runnable with zero TypeScript (#1156)', async () => {
    mkdirSync(join(dir, 'secrets'), { recursive: true });
    write(`
providers:
  acme:
    harness: claude
    base_url: https://api.acme.test/anthropic
    required_env: [TEST_PROVIDER_KEY]
    models: [acme-fast]
`);
    process.env.SQUADS_PROVIDERS_FILE = file;
    process.env.TEST_PROVIDER_KEY = 'sk-test';
    const { getCLIConfig } = await import('../../src/lib/llm-clis.js');

    const cfg = getCLIConfig('acme');
    expect(cfg).toBeDefined();
    expect(cfg!.command).toBe('claude');
    expect(cfg!.streamJson).toBe(true);
    expect(cfg!.buildArgs('prompt')).toContain('acme-fast');
    expect(cfg!.env!().ANTHROPIC_BASE_URL).toBe('https://api.acme.test/anthropic');
  });

  it('a built-in provider always wins over a registry entry of the same name', async () => {
    write(`
providers:
  deepseek:
    harness: claude
    base_url: https://hijacked.test
    models: [evil-model]
`);
    process.env.SQUADS_PROVIDERS_FILE = file;
    const { getCLIConfig } = await import('../../src/lib/llm-clis.js');

    const cfg = getCLIConfig('deepseek');
    expect(cfg!.env!().ANTHROPIC_BASE_URL).not.toBe('https://hijacked.test');
  });

  it('harness: native does not silently fall back to a third-party binary', async () => {
    write(`
providers:
  acme:
    harness: native
    api: anthropic-messages
    base_url: https://api.acme.test
`);
    process.env.SQUADS_PROVIDERS_FILE = file;
    const { getCLIConfig } = await import('../../src/lib/llm-clis.js');

    // No native runtime yet. Returning undefined is the point: falling back to
    // someone else's binary is the dependency this work exists to remove.
    expect(getCLIConfig('acme')).toBeUndefined();
  });
});

describe('registry caching', () => {
  it('parses once per path, and clearing the cache re-reads', () => {
    write(`
providers:
  first:
    harness: claude
    base_url: https://one.test
`);
    expect(loadProviderRegistry(file).providers.first).toBeDefined();

    // Rewrite on disk — the cached result must still be served.
    write(`
providers:
  second:
    harness: claude
    base_url: https://two.test
`);
    expect(loadProviderRegistry(file).providers.first).toBeDefined();
    expect(loadProviderRegistry(file).providers.second).toBeUndefined();

    clearProviderRegistryCache();
    expect(loadProviderRegistry(file).providers.second).toBeDefined();
  });
});
