/**
 * Multi-provider LLM detection and cost tracking
 *
 * Supports: Anthropic, OpenAI, Google, AWS Bedrock, Azure, Mistral, Groq
 */

// Provider types
export type ProviderName =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'aws_bedrock'
  | 'azure'
  | 'mistral'
  | 'groq'
  | 'unknown';

export interface ProviderDetection {
  provider: ProviderName;
  plan?: string;
  confidence: 'explicit' | 'inferred';
  reason: string;
}

export interface ModelPricing {
  input: number; // per 1M tokens
  output: number; // per 1M tokens
  cached?: number; // per 1M cached tokens (if supported)
}

export interface ProviderConfig {
  name: ProviderName;
  displayName: string;
  models: Record<string, ModelPricing>;
  defaultPricing: ModelPricing;
  envVars: string[]; // API key env vars to check
  modelPatterns: RegExp[]; // Model name patterns
}

// Pricing data per 1M tokens (Jan 2025)
export const PROVIDERS: Record<Exclude<ProviderName, 'unknown'>, ProviderConfig> = {
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic',
    envVars: ['ANTHROPIC_API_KEY'],
    modelPatterns: [/^claude/i],
    defaultPricing: { input: 3.0, output: 15.0 },
    models: {
      'claude-opus-4-5': { input: 15.0, output: 75.0 },
      'claude-opus-4-5-20251101': { input: 15.0, output: 75.0 },
      'claude-sonnet-4': { input: 3.0, output: 15.0 },
      'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
      'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
      'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
      'claude-3-5-sonnet-20240620': { input: 3.0, output: 15.0 },
      'claude-haiku-3-5': { input: 0.8, output: 4.0 },
      'claude-3-5-haiku': { input: 0.8, output: 4.0 },
      'claude-3-5-haiku-20241022': { input: 0.8, output: 4.0 },
      'claude-3-opus': { input: 15.0, output: 75.0 },
      'claude-3-sonnet': { input: 3.0, output: 15.0 },
      'claude-3-haiku': { input: 0.25, output: 1.25 },
    },
  },

  openai: {
    name: 'openai',
    displayName: 'OpenAI',
    envVars: ['OPENAI_API_KEY'],
    modelPatterns: [/^gpt-/i, /^o1/i, /^o3/i],
    defaultPricing: { input: 2.5, output: 10.0 },
    models: {
      'gpt-4o': { input: 2.5, output: 10.0 },
      'gpt-4o-2024-11-20': { input: 2.5, output: 10.0 },
      'gpt-4o-2024-08-06': { input: 2.5, output: 10.0 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'gpt-4o-mini-2024-07-18': { input: 0.15, output: 0.6 },
      'gpt-4-turbo': { input: 10.0, output: 30.0 },
      'gpt-4-turbo-2024-04-09': { input: 10.0, output: 30.0 },
      'gpt-4': { input: 30.0, output: 60.0 },
      'gpt-4-32k': { input: 60.0, output: 120.0 },
      'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
      'gpt-3.5-turbo-0125': { input: 0.5, output: 1.5 },
      o1: { input: 15.0, output: 60.0 },
      'o1-2024-12-17': { input: 15.0, output: 60.0 },
      'o1-preview': { input: 15.0, output: 60.0 },
      'o1-mini': { input: 3.0, output: 12.0 },
      'o1-mini-2024-09-12': { input: 3.0, output: 12.0 },
      'o3-mini': { input: 1.1, output: 4.4 },
    },
  },

  google: {
    name: 'google',
    displayName: 'Google',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    modelPatterns: [/^gemini/i],
    defaultPricing: { input: 0.1, output: 0.4 },
    models: {
      'gemini-2.0-flash': { input: 0.1, output: 0.4 },
      'gemini-2.0-flash-exp': { input: 0.1, output: 0.4 },
      'gemini-1.5-pro': { input: 1.25, output: 5.0 },
      'gemini-1.5-pro-002': { input: 1.25, output: 5.0 },
      'gemini-1.5-flash': { input: 0.075, output: 0.3 },
      'gemini-1.5-flash-002': { input: 0.075, output: 0.3 },
      'gemini-1.0-pro': { input: 0.5, output: 1.5 },
    },
  },

  mistral: {
    name: 'mistral',
    displayName: 'Mistral',
    envVars: ['MISTRAL_API_KEY'],
    modelPatterns: [/^mistral/i, /^mixtral/i, /^codestral/i],
    defaultPricing: { input: 2.0, output: 6.0 },
    models: {
      'mistral-large': { input: 2.0, output: 6.0 },
      'mistral-large-2411': { input: 2.0, output: 6.0 },
      'mistral-medium': { input: 2.7, output: 8.1 },
      'mistral-small': { input: 0.2, output: 0.6 },
      'mistral-small-2409': { input: 0.2, output: 0.6 },
      'mixtral-8x7b': { input: 0.7, output: 0.7 },
      'mixtral-8x22b': { input: 2.0, output: 6.0 },
      codestral: { input: 0.2, output: 0.6 },
      'codestral-2405': { input: 0.2, output: 0.6 },
    },
  },

  groq: {
    name: 'groq',
    displayName: 'Groq',
    envVars: ['GROQ_API_KEY'],
    modelPatterns: [/^llama/i], // llama models on Groq
    defaultPricing: { input: 0.59, output: 0.79 },
    models: {
      'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
      'llama-3.3-70b-specdec': { input: 0.59, output: 0.99 },
      'llama-3.1-70b-versatile': { input: 0.59, output: 0.79 },
      'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
      'llama-3-70b-8192': { input: 0.59, output: 0.79 },
      'llama-3-8b-8192': { input: 0.05, output: 0.08 },
      'mixtral-8x7b-32768': { input: 0.24, output: 0.24 },
      'gemma2-9b-it': { input: 0.2, output: 0.2 },
    },
  },

  aws_bedrock: {
    name: 'aws_bedrock',
    displayName: 'AWS Bedrock',
    envVars: ['AWS_ACCESS_KEY_ID'],
    modelPatterns: [/^anthropic\./i, /^amazon\./i, /^meta\./i, /^mistral\./i],
    defaultPricing: { input: 3.0, output: 15.0 },
    models: {
      'anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 3.0, output: 15.0 },
      'anthropic.claude-3-5-sonnet-20240620-v1:0': { input: 3.0, output: 15.0 },
      'anthropic.claude-3-5-haiku-20241022-v1:0': { input: 0.8, output: 4.0 },
      'anthropic.claude-3-opus-20240229-v1:0': { input: 15.0, output: 75.0 },
      'anthropic.claude-3-sonnet-20240229-v1:0': { input: 3.0, output: 15.0 },
      'anthropic.claude-3-haiku-20240307-v1:0': { input: 0.25, output: 1.25 },
      'amazon.titan-text-premier-v1:0': { input: 0.5, output: 1.5 },
      'amazon.titan-text-express-v1': { input: 0.2, output: 0.6 },
      'amazon.titan-text-lite-v1': { input: 0.15, output: 0.2 },
      'meta.llama3-70b-instruct-v1:0': { input: 2.65, output: 3.5 },
      'meta.llama3-8b-instruct-v1:0': { input: 0.3, output: 0.6 },
      'meta.llama3-1-405b-instruct-v1:0': { input: 5.32, output: 16.0 },
      'mistral.mistral-large-2407-v1:0': { input: 4.0, output: 12.0 },
    },
  },

  azure: {
    name: 'azure',
    displayName: 'Azure OpenAI',
    envVars: ['AZURE_OPENAI_API_KEY'],
    modelPatterns: [], // Detected via endpoint, not model name
    defaultPricing: { input: 2.5, output: 10.0 },
    models: {
      // Same pricing as OpenAI (regional variations possible)
      'gpt-4o': { input: 2.5, output: 10.0 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'gpt-4-turbo': { input: 10.0, output: 30.0 },
      'gpt-4': { input: 30.0, output: 60.0 },
      'gpt-35-turbo': { input: 0.5, output: 1.5 }, // Azure uses different name
    },
  },
};

/**
 * Detect the LLM provider from a model name string.
 * Supports Anthropic, OpenAI, Google, Mistral, Groq, AWS Bedrock, and Azure.
 * @param model - Model identifier (e.g., 'claude-3-5-sonnet', 'gpt-4o')
 * @returns Provider name or 'unknown' if unrecognized
 */
export function detectProviderFromModel(model: string): ProviderName {
  const modelLower = model.toLowerCase();

  // AWS Bedrock - check first (model IDs include provider prefix)
  if (
    modelLower.includes('anthropic.') ||
    modelLower.includes('amazon.') ||
    modelLower.includes('meta.') ||
    modelLower.includes('mistral.')
  ) {
    return 'aws_bedrock';
  }

  // Anthropic
  if (modelLower.startsWith('claude')) {
    return 'anthropic';
  }

  // OpenAI
  if (
    modelLower.startsWith('gpt-') ||
    modelLower.startsWith('o1') ||
    modelLower.startsWith('o3')
  ) {
    // Check for Azure (endpoint-based detection takes priority)
    if (process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_OPENAI_API_KEY) {
      return 'azure';
    }
    return 'openai';
  }

  // Google
  if (modelLower.startsWith('gemini')) {
    return 'google';
  }

  // Mistral vs Groq (both can run mistral/mixtral models)
  if (modelLower.startsWith('mistral') || modelLower.startsWith('mixtral') || modelLower.startsWith('codestral')) {
    // If Groq API key is set and not Mistral key, assume Groq
    if (process.env.GROQ_API_KEY && !process.env.MISTRAL_API_KEY) {
      return 'groq';
    }
    return 'mistral';
  }

  // Groq (llama models, gemma)
  if (modelLower.startsWith('llama') || modelLower.startsWith('gemma')) {
    return 'groq';
  }

  return 'unknown';
}

/**
 * Detect all LLM providers configured via environment variables.
 * Checks for API keys and infers plan type based on tier/budget settings.
 * @returns Array of detected providers with their configuration details
 */
export function detectProvidersFromEnv(): ProviderDetection[] {
  const detected: ProviderDetection[] = [];

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) {
    const tier = parseInt(process.env.ANTHROPIC_TIER || '0', 10);
    const budgetSet = process.env.ANTHROPIC_BUDGET_DAILY || process.env.SQUADS_DAILY_BUDGET;
    const explicitPlan = process.env.SQUADS_PLAN_TYPE?.toLowerCase();

    let plan = 'Max';
    let confidence: 'explicit' | 'inferred' = 'inferred';
    let reason = 'API key detected';

    if (explicitPlan === 'usage') {
      plan = 'Usage';
      confidence = 'explicit';
      reason = 'SQUADS_PLAN_TYPE=usage';
    } else if (explicitPlan === 'max') {
      plan = 'Max';
      confidence = 'explicit';
      reason = 'SQUADS_PLAN_TYPE=max';
    } else if (budgetSet) {
      plan = 'Usage';
      reason = `Budget set ($${budgetSet}/day)`;
    } else if (tier >= 4) {
      plan = 'Max';
      reason = `Tier ${tier} (high usage)`;
    } else if (tier >= 1 && tier <= 2) {
      plan = 'Usage';
      reason = `Tier ${tier} (new user)`;
    }

    detected.push({ provider: 'anthropic', plan, confidence, reason });
  }

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    const orgId = process.env.OPENAI_ORG_ID;
    detected.push({
      provider: 'openai',
      plan: orgId ? 'Team/Enterprise' : 'Personal',
      confidence: 'inferred',
      reason: orgId ? 'Org ID set' : 'API key only',
    });
  }

  // Google
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    detected.push({
      provider: 'google',
      plan: 'Pay-as-you-go',
      confidence: 'inferred',
      reason: 'API key detected',
    });
  }

  // AWS Bedrock
  if (process.env.AWS_ACCESS_KEY_ID) {
    detected.push({
      provider: 'aws_bedrock',
      plan: 'On-demand',
      confidence: 'inferred',
      reason: 'AWS credentials detected',
    });
  }

  // Azure OpenAI
  if (process.env.AZURE_OPENAI_API_KEY) {
    detected.push({
      provider: 'azure',
      plan: process.env.AZURE_OPENAI_DEPLOYMENT ? 'PTU' : 'Pay-as-you-go',
      confidence: 'inferred',
      reason: process.env.AZURE_OPENAI_DEPLOYMENT ? 'Deployment detected' : 'API key only',
    });
  }

  // Mistral
  if (process.env.MISTRAL_API_KEY) {
    detected.push({
      provider: 'mistral',
      plan: 'Pay-per-token',
      confidence: 'inferred',
      reason: 'API key detected',
    });
  }

  // Groq
  if (process.env.GROQ_API_KEY) {
    detected.push({
      provider: 'groq',
      plan: 'Developer',
      confidence: 'inferred',
      reason: 'API key detected',
    });
  }

  return detected;
}

/**
 * Get pricing information for a specific model.
 * Attempts exact match first, then case-insensitive, then partial match.
 * @param provider - Provider name
 * @param model - Model identifier
 * @returns Pricing in dollars per 1M tokens (input/output/cached)
 */
export function getModelPricing(provider: ProviderName, model: string): ModelPricing {
  if (provider === 'unknown') {
    // Fallback to Anthropic Sonnet pricing for unknown models
    return { input: 3.0, output: 15.0 };
  }

  const config = PROVIDERS[provider];
  const modelLower = model.toLowerCase();

  // Exact match first
  if (config.models[model]) {
    return config.models[model];
  }

  // Case-insensitive match
  const matchedModel = Object.keys(config.models).find(
    (m) => m.toLowerCase() === modelLower
  );
  if (matchedModel) {
    return config.models[matchedModel];
  }

  // Partial match (for versioned models)
  const partialMatch = Object.keys(config.models).find(
    (m) => modelLower.includes(m.toLowerCase()) || m.toLowerCase().includes(modelLower)
  );
  if (partialMatch) {
    return config.models[partialMatch];
  }

  return config.defaultPricing;
}

/**
 * Calculate cost for token usage based on provider pricing.
 * @param provider - Provider name
 * @param model - Model identifier
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param cachedTokens - Number of cached tokens (for providers that support it)
 * @returns Total cost in dollars
 */
export function calcCost(
  provider: ProviderName,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedTokens = 0
): number {
  const pricing = getModelPricing(provider, model);

  // Per 1M tokens pricing
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cachedCost = pricing.cached
    ? (cachedTokens / 1_000_000) * pricing.cached
    : 0;

  return inputCost + outputCost + cachedCost;
}

/**
 * Get human-readable display name for a provider.
 * @param provider - Provider name
 * @returns Display name (e.g., 'Anthropic', 'OpenAI', 'AWS Bedrock')
 */
export function getProviderDisplayName(provider: ProviderName): string {
  if (provider === 'unknown') return 'Unknown';
  return PROVIDERS[provider].displayName;
}

/**
 * Check if a provider has its API key configured in environment variables.
 * @param provider - Provider name
 * @returns true if any of the provider's API key env vars are set
 */
export function isProviderConfigured(provider: ProviderName): boolean {
  if (provider === 'unknown') return false;
  const config = PROVIDERS[provider];
  return config.envVars.some((envVar) => !!process.env[envVar]);
}
