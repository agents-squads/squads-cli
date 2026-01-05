import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectProviderFromModel,
  detectProvidersFromEnv,
  getModelPricing,
  calcCost,
  getProviderDisplayName,
  isProviderConfigured,
  PROVIDERS,
  ProviderName,
} from '../src/lib/providers.js';

describe('provider detection', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear all provider env vars
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.MISTRAL_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.OPENAI_ORG_ID;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
    delete process.env.ANTHROPIC_TIER;
    delete process.env.SQUADS_PLAN_TYPE;
    delete process.env.ANTHROPIC_BUDGET_DAILY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('detectProviderFromModel', () => {
    it('detects Anthropic from claude models', () => {
      expect(detectProviderFromModel('claude-3-5-sonnet')).toBe('anthropic');
      expect(detectProviderFromModel('claude-opus-4-5')).toBe('anthropic');
      expect(detectProviderFromModel('claude-haiku-3-5')).toBe('anthropic');
      expect(detectProviderFromModel('Claude-3-Opus')).toBe('anthropic');
    });

    it('detects OpenAI from gpt models', () => {
      expect(detectProviderFromModel('gpt-4o')).toBe('openai');
      expect(detectProviderFromModel('gpt-4o-mini')).toBe('openai');
      expect(detectProviderFromModel('gpt-4-turbo')).toBe('openai');
      expect(detectProviderFromModel('gpt-3.5-turbo')).toBe('openai');
      expect(detectProviderFromModel('GPT-4')).toBe('openai');
    });

    it('detects OpenAI from o1/o3 models', () => {
      expect(detectProviderFromModel('o1')).toBe('openai');
      expect(detectProviderFromModel('o1-mini')).toBe('openai');
      expect(detectProviderFromModel('o1-preview')).toBe('openai');
      expect(detectProviderFromModel('o3-mini')).toBe('openai');
    });

    it('detects Azure when Azure env vars are set', () => {
      process.env.AZURE_OPENAI_API_KEY = 'test-key';
      expect(detectProviderFromModel('gpt-4o')).toBe('azure');
    });

    it('detects Google from gemini models', () => {
      expect(detectProviderFromModel('gemini-2.0-flash')).toBe('google');
      expect(detectProviderFromModel('gemini-1.5-pro')).toBe('google');
      expect(detectProviderFromModel('gemini-1.5-flash')).toBe('google');
      expect(detectProviderFromModel('Gemini-Pro')).toBe('google');
    });

    it('detects Mistral from mistral/mixtral models', () => {
      expect(detectProviderFromModel('mistral-large')).toBe('mistral');
      expect(detectProviderFromModel('mistral-small')).toBe('mistral');
      expect(detectProviderFromModel('mixtral-8x7b')).toBe('mistral');
      expect(detectProviderFromModel('codestral')).toBe('mistral');
    });

    it('detects Groq when GROQ_API_KEY is set for mistral models', () => {
      process.env.GROQ_API_KEY = 'test-key';
      expect(detectProviderFromModel('mixtral-8x7b')).toBe('groq');
    });

    it('prefers Mistral over Groq when both keys are set', () => {
      process.env.GROQ_API_KEY = 'test-key';
      process.env.MISTRAL_API_KEY = 'test-key';
      expect(detectProviderFromModel('mixtral-8x7b')).toBe('mistral');
    });

    it('detects Groq from llama models', () => {
      expect(detectProviderFromModel('llama-3.3-70b-versatile')).toBe('groq');
      expect(detectProviderFromModel('llama-3.1-8b-instant')).toBe('groq');
      expect(detectProviderFromModel('gemma2-9b-it')).toBe('groq');
    });

    it('detects AWS Bedrock from prefixed models', () => {
      expect(detectProviderFromModel('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBe('aws_bedrock');
      expect(detectProviderFromModel('amazon.titan-text-premier-v1:0')).toBe('aws_bedrock');
      expect(detectProviderFromModel('meta.llama3-70b-instruct-v1:0')).toBe('aws_bedrock');
      expect(detectProviderFromModel('mistral.mistral-large-2407-v1:0')).toBe('aws_bedrock');
    });

    it('returns unknown for unrecognized models', () => {
      expect(detectProviderFromModel('some-random-model')).toBe('unknown');
      expect(detectProviderFromModel('local-llm')).toBe('unknown');
    });
  });

  describe('detectProvidersFromEnv', () => {
    it('detects Anthropic when API key is set', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      const providers = detectProvidersFromEnv();
      expect(providers.find((p) => p.provider === 'anthropic')).toBeDefined();
    });

    it('detects Anthropic plan from SQUADS_PLAN_TYPE', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.SQUADS_PLAN_TYPE = 'max';
      const providers = detectProvidersFromEnv();
      const anthropic = providers.find((p) => p.provider === 'anthropic');
      expect(anthropic?.plan).toBe('Max');
      expect(anthropic?.confidence).toBe('explicit');
    });

    it('infers usage plan from budget setting', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.ANTHROPIC_BUDGET_DAILY = '50';
      const providers = detectProvidersFromEnv();
      const anthropic = providers.find((p) => p.provider === 'anthropic');
      expect(anthropic?.plan).toBe('Usage');
      expect(anthropic?.confidence).toBe('inferred');
    });

    it('detects OpenAI when API key is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      const providers = detectProvidersFromEnv();
      const openai = providers.find((p) => p.provider === 'openai');
      expect(openai).toBeDefined();
      expect(openai?.plan).toBe('Personal');
    });

    it('detects OpenAI Team plan when org ID is set', () => {
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.OPENAI_ORG_ID = 'org-test';
      const providers = detectProvidersFromEnv();
      const openai = providers.find((p) => p.provider === 'openai');
      expect(openai?.plan).toBe('Team/Enterprise');
    });

    it('detects Google when GEMINI_API_KEY is set', () => {
      process.env.GEMINI_API_KEY = 'test-key';
      const providers = detectProvidersFromEnv();
      expect(providers.find((p) => p.provider === 'google')).toBeDefined();
    });

    it('detects Google when GOOGLE_API_KEY is set', () => {
      process.env.GOOGLE_API_KEY = 'test-key';
      const providers = detectProvidersFromEnv();
      expect(providers.find((p) => p.provider === 'google')).toBeDefined();
    });

    it('detects AWS Bedrock when credentials are set', () => {
      process.env.AWS_ACCESS_KEY_ID = 'test-key';
      const providers = detectProvidersFromEnv();
      expect(providers.find((p) => p.provider === 'aws_bedrock')).toBeDefined();
    });

    it('detects Azure OpenAI when API key is set', () => {
      process.env.AZURE_OPENAI_API_KEY = 'test-key';
      const providers = detectProvidersFromEnv();
      expect(providers.find((p) => p.provider === 'azure')).toBeDefined();
    });

    it('detects Mistral when API key is set', () => {
      process.env.MISTRAL_API_KEY = 'test-key';
      const providers = detectProvidersFromEnv();
      expect(providers.find((p) => p.provider === 'mistral')).toBeDefined();
    });

    it('detects Groq when API key is set', () => {
      process.env.GROQ_API_KEY = 'test-key';
      const providers = detectProvidersFromEnv();
      expect(providers.find((p) => p.provider === 'groq')).toBeDefined();
    });

    it('detects multiple providers', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.GROQ_API_KEY = 'test-key';
      const providers = detectProvidersFromEnv();
      expect(providers.length).toBe(3);
      expect(providers.map((p) => p.provider)).toContain('anthropic');
      expect(providers.map((p) => p.provider)).toContain('openai');
      expect(providers.map((p) => p.provider)).toContain('groq');
    });

    it('returns empty array when no providers configured', () => {
      const providers = detectProvidersFromEnv();
      expect(providers).toEqual([]);
    });
  });

  describe('getModelPricing', () => {
    it('returns exact pricing for known models', () => {
      const pricing = getModelPricing('anthropic', 'claude-opus-4-5');
      expect(pricing.input).toBe(15.0);
      expect(pricing.output).toBe(75.0);
    });

    it('returns case-insensitive pricing', () => {
      const pricing = getModelPricing('openai', 'GPT-4O');
      expect(pricing.input).toBe(2.5);
      expect(pricing.output).toBe(10.0);
    });

    it('returns default pricing for unknown models', () => {
      const pricing = getModelPricing('anthropic', 'claude-future-model');
      expect(pricing.input).toBe(3.0); // default
      expect(pricing.output).toBe(15.0); // default
    });

    it('returns fallback pricing for unknown provider', () => {
      const pricing = getModelPricing('unknown', 'some-model');
      expect(pricing.input).toBe(3.0);
      expect(pricing.output).toBe(15.0);
    });
  });

  describe('calcCost', () => {
    it('calculates cost for Anthropic models', () => {
      // claude-sonnet-4: $3/1M input, $15/1M output
      const cost = calcCost('anthropic', 'claude-sonnet-4', 1_000_000, 1_000_000);
      expect(cost).toBe(18.0);
    });

    it('calculates cost for OpenAI models', () => {
      // gpt-4o: $2.5/1M input, $10/1M output
      const cost = calcCost('openai', 'gpt-4o', 1_000_000, 1_000_000);
      expect(cost).toBe(12.5);
    });

    it('calculates cost for Google models', () => {
      // gemini-2.0-flash: $0.10/1M input, $0.40/1M output
      const cost = calcCost('google', 'gemini-2.0-flash', 1_000_000, 1_000_000);
      expect(cost).toBe(0.5);
    });

    it('calculates cost for Groq models', () => {
      // llama-3.3-70b: $0.59/1M input, $0.79/1M output
      const cost = calcCost('groq', 'llama-3.3-70b-versatile', 1_000_000, 1_000_000);
      expect(cost).toBe(1.38);
    });

    it('handles partial token amounts', () => {
      // 500k tokens = half the cost
      const cost = calcCost('anthropic', 'claude-sonnet-4', 500_000, 500_000);
      expect(cost).toBe(9.0);
    });

    it('returns 0 for 0 tokens', () => {
      const cost = calcCost('anthropic', 'claude-sonnet-4', 0, 0);
      expect(cost).toBe(0);
    });
  });

  describe('getProviderDisplayName', () => {
    it('returns display names for known providers', () => {
      expect(getProviderDisplayName('anthropic')).toBe('Anthropic');
      expect(getProviderDisplayName('openai')).toBe('OpenAI');
      expect(getProviderDisplayName('google')).toBe('Google');
      expect(getProviderDisplayName('aws_bedrock')).toBe('AWS Bedrock');
      expect(getProviderDisplayName('azure')).toBe('Azure OpenAI');
      expect(getProviderDisplayName('mistral')).toBe('Mistral');
      expect(getProviderDisplayName('groq')).toBe('Groq');
    });

    it('returns Unknown for unknown provider', () => {
      expect(getProviderDisplayName('unknown')).toBe('Unknown');
    });
  });

  describe('isProviderConfigured', () => {
    it('returns true when provider API key is set', () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      expect(isProviderConfigured('anthropic')).toBe(true);
    });

    it('returns false when provider API key is not set', () => {
      expect(isProviderConfigured('anthropic')).toBe(false);
    });

    it('returns false for unknown provider', () => {
      expect(isProviderConfigured('unknown')).toBe(false);
    });
  });

  describe('PROVIDERS registry', () => {
    it('has all expected providers', () => {
      const expectedProviders: Exclude<ProviderName, 'unknown'>[] = [
        'anthropic',
        'openai',
        'google',
        'aws_bedrock',
        'azure',
        'mistral',
        'groq',
      ];

      for (const provider of expectedProviders) {
        expect(PROVIDERS[provider]).toBeDefined();
        expect(PROVIDERS[provider].displayName).toBeTruthy();
        expect(PROVIDERS[provider].models).toBeTruthy();
        expect(PROVIDERS[provider].defaultPricing).toBeTruthy();
      }
    });

    it('has valid pricing for all models', () => {
      for (const [providerName, config] of Object.entries(PROVIDERS)) {
        for (const [modelName, pricing] of Object.entries(config.models)) {
          expect(pricing.input).toBeGreaterThan(0);
          expect(pricing.output).toBeGreaterThan(0);
          // Sanity check: output price should generally be higher than input
          // (except for some models like mixtral where they're equal)
          expect(pricing.output).toBeGreaterThanOrEqual(pricing.input * 0.5);
        }
      }
    });
  });
});
