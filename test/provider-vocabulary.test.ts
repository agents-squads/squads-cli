import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProviderName, getCLIConfig, LLM_CLIS } from '../src/lib/llm-clis.js';
import { PROVIDERS as INIT_PROVIDERS } from '../src/lib/setup-checks.js';

/**
 * Regression guard for #955: `squads init` writes provider: "claude" into
 * every scaffolded agent's frontmatter (setup-checks.ts PROVIDERS vocabulary),
 * but the runtime resolver (agent-runner.ts) only recognized LLM_CLIS keys
 * ('anthropic', not 'claude') — every fresh-init agent failed with exit 0.
 */
describe('normalizeProviderName (#955)', () => {
  it('maps claude (squads init vocabulary) to anthropic (runtime key)', () => {
    expect(normalizeProviderName('claude')).toBe('anthropic');
  });

  it('maps gemini (squads init vocabulary) to google (runtime key)', () => {
    expect(normalizeProviderName('gemini')).toBe('google');
  });

  it('passes through already-canonical runtime keys unchanged', () => {
    for (const key of Object.keys(LLM_CLIS)) {
      expect(normalizeProviderName(key)).toBe(key);
    }
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(normalizeProviderName('Claude')).toBe('anthropic');
    expect(normalizeProviderName('  GEMINI  ')).toBe('google');
  });

  // 'none' (planning-only) and 'cursor' (manual IDE usage) are intentionally
  // never dispatched through a runtime CLI — they have no LLM_CLIS entry by
  // design, not by oversight.
  const NON_DISPATCHED_INIT_PROVIDERS = new Set(['none', 'cursor']);

  it('resolves every dispatchable squads-init provider to a key present in LLM_CLIS', () => {
    for (const providerId of Object.keys(INIT_PROVIDERS)) {
      if (NON_DISPATCHED_INIT_PROVIDERS.has(providerId)) continue;
      const runtimeKey = normalizeProviderName(providerId);
      expect(
        LLM_CLIS[runtimeKey],
        `setup-checks PROVIDERS['${providerId}'] normalizes to '${runtimeKey}', which is missing from LLM_CLIS`
      ).toBeDefined();
    }
  });
});

describe('provider:"claude" frontmatter resolves to Anthropic at runtime (#955)', () => {
  it('getCLIConfig("claude") returns the anthropic CLI config', () => {
    const config = getCLIConfig('claude');
    expect(config).toBeDefined();
    expect(config?.provider).toBe('anthropic');
    expect(config?.command).toBe('claude');
  });

  it('the isAnthropic check (provider === "anthropic") matches after normalization', () => {
    const provider = normalizeProviderName('claude');
    const isAnthropic = provider === 'anthropic';
    expect(isAnthropic).toBe(true);
  });
});

/**
 * Source-contract regression for #955: runLeadMode resolves the squad's
 * provider (options.provider || SQUAD.md providers.default || 'anthropic')
 * independently of agent-runner.ts and run.ts, so it needs its own
 * normalizeProviderName() call sites. A full runLeadMode() behavioral test
 * needs many module mocks (see test/agent-runner-provider-routing.test.ts);
 * this narrow check covers the actual regression without pinning unrelated
 * implementation details.
 */
describe('run-modes provider resolution wraps normalizeProviderName (#955)', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'run-modes.ts'),
    'utf8'
  );

  it('imports normalizeProviderName from llm-clis', () => {
    expect(source).toMatch(/import \{[^}]*normalizeProviderName[^}]*\} from '\.\/llm-clis\.js'/s);
  });

  it('runLeadMode wraps both provider resolutions in normalizeProviderName', () => {
    const matches = source.match(/const (?:squadProvider|provider) = normalizeProviderName\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
