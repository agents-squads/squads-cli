/**
 * Cost tracking via Squads Bridge (postgres) or Langfuse
 * Primary: Squads Bridge API → PostgreSQL
 * Fallback: Langfuse API (if bridge unavailable)
 */

import {
  ProviderName,
  ProviderDetection,
  detectProviderFromModel,
  detectProvidersFromEnv,
  calcCost as calcProviderCost,
  getProviderDisplayName,
} from './providers.js';

// Re-export provider types for convenience
export { ProviderName, ProviderDetection, detectProviderFromModel, detectProvidersFromEnv, getProviderDisplayName };

interface SquadCosts {
  squad: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  models: Record<string, number>;
}

export interface ProviderCosts {
  provider: ProviderName;
  displayName: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  plan?: string;
  confidence?: 'explicit' | 'inferred';
  reason?: string;
}

export interface CostSummary {
  totalCost: number;
  dailyBudget: number;
  usedPercent: number;
  idleBudget: number;
  totalCalls: number;
  dailyCallLimit: number;
  callsPercent: number;
  totalCachedTokens: number;
  totalInputTokens: number;
  cacheHitRate: number;
  bySquad: SquadCosts[];
  byProvider: ProviderCosts[];
  source: 'postgres' | 'langfuse' | 'none';
}

// Legacy MODEL_PRICING kept for backward compatibility
// New code should use getModelPricing() from providers.ts
const _MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-4-5-20251101': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0 },
  'claude-3-5-sonnet-20241022': { input: 3.0, output: 15.0 },
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4.0 },
  default: { input: 3.0, output: 15.0 },
};

const DEFAULT_DAILY_BUDGET = 200.0;
const DEFAULT_DAILY_CALL_LIMIT = 1000; // Default API call limit per day
const BRIDGE_URL = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';
const FETCH_TIMEOUT_MS = 2000; // 2 second timeout for all fetch calls

/**
 * Anthropic plan types:
 * - 'max': Flat fee subscription ($200/mo), no overage - only rate limits matter
 * - 'usage': Pay-per-token, budget tracking matters
 * - 'unknown': Not configured yet
 */
export type PlanType = 'max' | 'usage' | 'unknown';

/**
 * Plan detection result with confidence and reason
 */
export interface PlanDetection {
  plan: PlanType;
  confidence: 'explicit' | 'inferred';
  reason: string;
}

/**
 * Detect the Anthropic plan type using multiple signals:
 *
 * Priority order:
 * 1. Explicit SQUADS_PLAN_TYPE env var (highest confidence)
 * 2. ANTHROPIC_BUDGET_DAILY set → usage plan (user cares about budget)
 * 3. Tier 4 + no budget → likely Max plan (heavy user)
 * 4. Low tier (1-2) → usage plan (new user, pay-as-you-go)
 * 5. Default: max (assumes professional use)
 */
export function detectPlan(): PlanDetection {
  // 1. Explicit configuration (highest priority)
  const explicitPlan = process.env.SQUADS_PLAN_TYPE?.toLowerCase();
  if (explicitPlan === 'usage') {
    return { plan: 'usage', confidence: 'explicit', reason: 'SQUADS_PLAN_TYPE=usage' };
  }
  if (explicitPlan === 'max') {
    return { plan: 'max', confidence: 'explicit', reason: 'SQUADS_PLAN_TYPE=max' };
  }

  // 2. Budget explicitly set → user cares about costs → usage plan
  const budgetSet = process.env.ANTHROPIC_BUDGET_DAILY || process.env.SQUADS_DAILY_BUDGET;
  if (budgetSet) {
    return { plan: 'usage', confidence: 'inferred', reason: `Budget set ($${budgetSet}/day)` };
  }

  // 3. Check tier - Tier 4 usually indicates Max plan user
  const tier = parseInt(process.env.ANTHROPIC_TIER || '0', 10);
  if (tier >= 4) {
    return { plan: 'max', confidence: 'inferred', reason: `Tier ${tier} (high usage)` };
  }

  // 4. Low tier (1-2) → likely new user on usage plan
  if (tier >= 1 && tier <= 2) {
    return { plan: 'usage', confidence: 'inferred', reason: `Tier ${tier} (new user)` };
  }

  // 5. Default: unknown - prompt user to configure
  return { plan: 'unknown', confidence: 'inferred', reason: 'Not configured' };
}

/**
 * Get the current Anthropic plan type
 * Use detectPlan() for full details including confidence
 */
export function getPlanType(): PlanType {
  return detectPlan().plan;
}

/**
 * Check if we're on a flat-fee plan where budget doesn't matter
 */
export function isMaxPlan(): boolean {
  return getPlanType() === 'max';
}

/**
 * Get human-readable plan description for dashboard display
 */
export function getPlanDescription(): string {
  const detection = detectPlan();
  const planName = detection.plan === 'max'
    ? 'Max ($200 flat)'
    : detection.plan === 'usage'
      ? 'Usage (pay-per-token)'
      : 'Unknown';
  const confidence = detection.confidence === 'explicit' ? '' : ` [${detection.reason}]`;
  return `${planName}${confidence}`;
}

/**
 * Fetch with timeout to prevent hanging when services are down
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  // Use provider-aware pricing
  const provider = detectProviderFromModel(model);
  return calcProviderCost(provider, model, inputTokens, outputTokens);
}

/**
 * Fetch cost summary from Squads Bridge (postgres)
 */
async function fetchFromBridge(period: 'day' | 'week' | 'month' = 'day'): Promise<CostSummary | null> {
  try {
    const response = await fetchWithTimeout(`${BRIDGE_URL}/api/cost/summary?period=${period}`, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as { totals?: { cost_usd?: number }; by_squad?: Record<string, unknown>[] };
    const dailyBudget = parseFloat(process.env.SQUADS_DAILY_BUDGET || '') || DEFAULT_DAILY_BUDGET;
    const totalCost = data.totals?.cost_usd || 0;

    const bySquad: SquadCosts[] = (data.by_squad || []).map((s: Record<string, unknown>) => ({
      squad: s.squad as string,
      calls: (s.generations as number) || 0,
      inputTokens: (s.input_tokens as number) || 0,
      outputTokens: (s.output_tokens as number) || 0,
      cachedTokens: (s.cached_tokens as number) || 0,
      cost: (s.cost_usd as number) || 0,
      models: {},
    }));

    const totalCalls = bySquad.reduce((sum, s) => sum + s.calls, 0);
    const dailyCallLimit = parseFloat(process.env.SQUADS_DAILY_CALL_LIMIT || '') || DEFAULT_DAILY_CALL_LIMIT;
    const totalCachedTokens = bySquad.reduce((sum, s) => sum + s.cachedTokens, 0);
    const totalInputTokens = bySquad.reduce((sum, s) => sum + s.inputTokens, 0);
    const totalAllInput = totalInputTokens + totalCachedTokens;
    const cacheHitRate = totalAllInput > 0 ? (totalCachedTokens / totalAllInput) * 100 : 0;

    // Build provider summary from detected providers in env
    const detectedProviders = detectProvidersFromEnv();
    const byProvider: ProviderCosts[] = detectedProviders.map((p) => ({
      provider: p.provider,
      displayName: getProviderDisplayName(p.provider),
      calls: 0, // Bridge doesn't track by provider yet
      inputTokens: 0,
      outputTokens: 0,
      cost: p.provider === 'anthropic' ? totalCost : 0, // Assume all cost is Anthropic for now
      plan: p.plan,
      confidence: p.confidence,
      reason: p.reason,
    }));

    return {
      totalCost,
      dailyBudget,
      usedPercent: (totalCost / dailyBudget) * 100,
      idleBudget: dailyBudget - totalCost,
      totalCalls,
      dailyCallLimit,
      callsPercent: (totalCalls / dailyCallLimit) * 100,
      totalCachedTokens,
      totalInputTokens,
      cacheHitRate,
      bySquad,
      byProvider,
      source: 'postgres',
    };
  } catch {
    return null;
  }
}

/**
 * Fetch cost summary from Langfuse API (fallback)
 */
async function fetchFromLangfuse(limit = 100): Promise<CostSummary | null> {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const host = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || 'https://us.cloud.langfuse.com';

  if (!publicKey || !secretKey) {
    return null;
  }

  try {
    const auth = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
    const url = `${host}/api/public/observations?limit=${limit}`;

    const response = await fetchWithTimeout(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    interface LangfuseObs {
      type?: string;
      model?: string;
      metadata?: { squad?: string };
      usage?: { input?: number; output?: number };
    }
    const data = await response.json() as { data?: LangfuseObs[] };
    const observations = data.data || [];

    // Group by squad
    const bySquad: Record<string, SquadCosts> = {};

    for (const obs of observations) {
      if (obs.type !== 'GENERATION') continue;

      const metadata = obs.metadata || {};
      const squad = metadata.squad || 'unknown';
      const model = obs.model || 'unknown';
      const usage = obs.usage || {};

      const inputTokens = usage.input || 0;
      const outputTokens = usage.output || 0;
      const cost = calcCost(model, inputTokens, outputTokens);

      if (!bySquad[squad]) {
        bySquad[squad] = {
          squad,
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          cost: 0,
          models: {},
        };
      }

      bySquad[squad].calls += 1;
      bySquad[squad].inputTokens += inputTokens;
      bySquad[squad].outputTokens += outputTokens;
      bySquad[squad].cost += cost;
      bySquad[squad].models[model] = (bySquad[squad].models[model] || 0) + 1;
    }

    const squadList = Object.values(bySquad).sort((a, b) => b.cost - a.cost);
    const totalCost = squadList.reduce((sum, s) => sum + s.cost, 0);
    const dailyBudget = parseFloat(process.env.SQUADS_DAILY_BUDGET || '') || DEFAULT_DAILY_BUDGET;

    const totalCalls = squadList.reduce((sum, s) => sum + s.calls, 0);
    const dailyCallLimit = parseFloat(process.env.SQUADS_DAILY_CALL_LIMIT || '') || DEFAULT_DAILY_CALL_LIMIT;
    const totalCachedTokens = squadList.reduce((sum, s) => sum + s.cachedTokens, 0);
    const totalInputTokens = squadList.reduce((sum, s) => sum + s.inputTokens, 0);
    const totalAllInput = totalInputTokens + totalCachedTokens;
    const cacheHitRate = totalAllInput > 0 ? (totalCachedTokens / totalAllInput) * 100 : 0;

    // Build provider summary - Langfuse can track by model, so group by provider
    const providerMap: Record<string, ProviderCosts> = {};
    for (const obs of observations) {
      if (obs.type !== 'GENERATION') continue;
      const model = obs.model || 'unknown';
      const provider = detectProviderFromModel(model);
      const usage = obs.usage || {};
      const inputTokens = usage.input || 0;
      const outputTokens = usage.output || 0;
      const cost = calcCost(model, inputTokens, outputTokens);

      if (!providerMap[provider]) {
        const detection = detectProvidersFromEnv().find((p) => p.provider === provider);
        providerMap[provider] = {
          provider,
          displayName: getProviderDisplayName(provider),
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
          plan: detection?.plan,
          confidence: detection?.confidence,
          reason: detection?.reason,
        };
      }
      providerMap[provider].calls += 1;
      providerMap[provider].inputTokens += inputTokens;
      providerMap[provider].outputTokens += outputTokens;
      providerMap[provider].cost += cost;
    }
    const byProvider = Object.values(providerMap).sort((a, b) => b.cost - a.cost);

    return {
      totalCost,
      dailyBudget,
      usedPercent: (totalCost / dailyBudget) * 100,
      idleBudget: dailyBudget - totalCost,
      totalCalls,
      dailyCallLimit,
      callsPercent: (totalCalls / dailyCallLimit) * 100,
      totalCachedTokens,
      totalInputTokens,
      cacheHitRate,
      bySquad: squadList,
      byProvider,
      source: 'langfuse',
    };
  } catch {
    return null;
  }
}

/**
 * Fetch cost summary - tries postgres first, falls back to Langfuse
 */
export async function fetchCostSummary(
  limit = 100,
  period: 'day' | 'week' | 'month' = 'day'
): Promise<CostSummary | null> {
  // Try postgres (via bridge) first
  const bridgeResult = await fetchFromBridge(period);
  if (bridgeResult) {
    return bridgeResult;
  }

  // Fall back to Langfuse
  const langfuseResult = await fetchFromLangfuse(limit);
  if (langfuseResult) {
    return langfuseResult;
  }

  // No data source available - still detect providers from env
  const defaultBudget = parseFloat(process.env.SQUADS_DAILY_BUDGET || '') || DEFAULT_DAILY_BUDGET;
  const detectedProviders = detectProvidersFromEnv();
  const byProvider: ProviderCosts[] = detectedProviders.map((p) => ({
    provider: p.provider,
    displayName: getProviderDisplayName(p.provider),
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    plan: p.plan,
    confidence: p.confidence,
    reason: p.reason,
  }));

  return {
    totalCost: 0,
    dailyBudget: defaultBudget,
    usedPercent: 0,
    idleBudget: defaultBudget,
    totalCalls: 0,
    dailyCallLimit: DEFAULT_DAILY_CALL_LIMIT,
    callsPercent: 0,
    totalCachedTokens: 0,
    totalInputTokens: 0,
    cacheHitRate: 0,
    bySquad: [],
    byProvider,
    source: 'none',
  };
}

export function formatCostBar(usedPercent: number, width = 20): string {
  const filled = Math.min(Math.round((usedPercent / 100) * width), width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Bridge stats from /stats endpoint (Redis real-time or Postgres fallback)
 */
export interface BridgeStats {
  status: string;
  source: 'redis' | 'postgres' | 'none';
  today: {
    generations: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  week?: {
    generations: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    byModel?: Array<{
      model: string;
      generations: number;
      costUsd: number;
    }>;
  };
  budget: {
    daily: number;
    used: number;
    remaining: number;
    usedPct: number;
  };
  bySquad: Array<{
    squad: string;
    costUsd: number;
    generations: number;
  }>;
  byModel?: Array<{
    model: string;
    generations: number;
    costUsd: number;
  }>;
  health: {
    postgres: string;
    redis: string;
    langfuse: string;
  };
}

/**
 * Fetch real-time stats from Squads Bridge
 * All HTTP calls are made in parallel for optimal performance
 */
export async function fetchBridgeStats(): Promise<BridgeStats | null> {
  try {
    interface StatsData {
      status?: string;
      source?: string;
      today?: {
        generations?: number;
        input_tokens?: number;
        output_tokens?: number;
        cost_usd?: number;
      };
      budget?: {
        daily?: number;
        used?: number;
        remaining?: number;
        used_pct?: number;
      };
      by_squad?: Array<{
        squad?: string;
        cost_usd?: number;
        generations?: number;
      }>;
    }

    interface HealthData {
      postgres?: string;
      redis?: string;
      langfuse?: string;
    }

    interface CostData {
      totals?: {
        generations?: number;
        input_tokens?: number;
        output_tokens?: number;
        cost_usd?: number;
      };
      by_model?: Array<{
        model?: string;
        generations?: number;
        cost_usd?: number;
      }>;
    }

    // Fetch ALL endpoints in parallel (4 requests -> 1 round trip)
    const [statsResponse, healthResponse, costResponse, weekResponse] = await Promise.all([
      fetchWithTimeout(`${BRIDGE_URL}/stats`, {
        headers: { 'Content-Type': 'application/json' },
      }),
      fetchWithTimeout(`${BRIDGE_URL}/health`, {
        headers: { 'Content-Type': 'application/json' },
      }),
      fetchWithTimeout(`${BRIDGE_URL}/api/cost/summary?period=day`, {
        headers: { 'Content-Type': 'application/json' },
      }),
      fetchWithTimeout(`${BRIDGE_URL}/api/cost/summary?period=week`, {
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    if (!statsResponse.ok) {
      return null;
    }

    // Parse all responses in parallel
    const [stats, health, costData, weekData] = await Promise.all([
      statsResponse.json() as Promise<StatsData>,
      healthResponse.ok ? healthResponse.json() as Promise<HealthData> : Promise.resolve({} as HealthData),
      costResponse.ok ? costResponse.json() as Promise<CostData> : Promise.resolve({} as CostData),
      weekResponse.ok ? weekResponse.json() as Promise<CostData> : Promise.resolve({} as CostData),
    ]);

    return {
      status: stats.status || 'unknown',
      source: (stats.source as 'redis' | 'postgres' | 'none') || 'none',
      today: {
        generations: stats.today?.generations || 0,
        inputTokens: stats.today?.input_tokens || 0,
        outputTokens: stats.today?.output_tokens || 0,
        costUsd: stats.today?.cost_usd || 0,
      },
      week: weekData.totals ? {
        generations: weekData.totals.generations || 0,
        inputTokens: weekData.totals.input_tokens || 0,
        outputTokens: weekData.totals.output_tokens || 0,
        costUsd: weekData.totals.cost_usd || 0,
        byModel: (weekData.by_model || []).map(m => ({
          model: m.model || 'unknown',
          generations: m.generations || 0,
          costUsd: m.cost_usd || 0,
        })),
      } : undefined,
      budget: {
        daily: stats.budget?.daily || DEFAULT_DAILY_BUDGET,
        used: stats.budget?.used || 0,
        remaining: stats.budget?.remaining || DEFAULT_DAILY_BUDGET,
        usedPct: stats.budget?.used_pct || 0,
      },
      bySquad: (stats.by_squad || []).map(s => ({
        squad: s.squad || 'unknown',
        costUsd: s.cost_usd || 0,
        generations: s.generations || 0,
      })),
      byModel: (costData.by_model || []).map(m => ({
        model: m.model || 'unknown',
        generations: m.generations || 0,
        costUsd: m.cost_usd || 0,
      })),
      health: {
        postgres: health.postgres || 'unknown',
        redis: health.redis || 'unknown',
        langfuse: health.langfuse || 'unknown',
      },
    };
  } catch {
    return null;
  }
}

/**
 * Monthly quota/autonomy data from bridge
 */
export interface QuotaInfo {
  monthlyUsed: number;
  monthlyQuota: number;
  quotaPct: number;
  autonomyScore: number;
  confidenceLevel: string;
  learningCount: number;
}

export async function fetchQuotaInfo(): Promise<QuotaInfo | null> {
  const bridgeUrl = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';

  try {
    const response = await fetch(`${bridgeUrl}/api/autonomy/score`);
    if (!response.ok) return null;

    const data = await response.json() as {
      overall_score: number;
      confidence_level: string;
      execution_stats: {
        monthly_used: number;
        monthly_quota: number;
        quota_pct: number;
        learning_count: number;
      };
    };

    return {
      monthlyUsed: data.execution_stats.monthly_used,
      monthlyQuota: data.execution_stats.monthly_quota,
      quotaPct: data.execution_stats.quota_pct,
      autonomyScore: data.overall_score,
      confidenceLevel: data.confidence_level,
      learningCount: data.execution_stats.learning_count,
    };
  } catch {
    return null;
  }
}

/**
 * Rate limit data from Anthropic API headers
 */
export interface RateLimitInfo {
  model: string;
  requestsLimit: number;
  requestsRemaining: number;
  requestsReset?: string;
  tokensLimit: number;
  tokensRemaining: number;
  tokensReset?: string;
  inputTokensLimit?: number;
  inputTokensRemaining?: number;
  outputTokensLimit?: number;
  outputTokensRemaining?: number;
  capturedAt: string;
}

export interface RateLimits {
  limits: Record<string, RateLimitInfo>;
  source: 'proxy' | 'none';
}

/**
 * Fetch real rate limits from the Anthropic proxy (via bridge)
 */
export async function fetchRateLimits(): Promise<RateLimits> {
  try {
    const response = await fetchWithTimeout(`${BRIDGE_URL}/api/rate-limits`, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return { limits: {}, source: 'none' };
    }

    interface RateLimitResponse {
      rate_limits?: Record<string, {
        model?: string;
        requests_limit?: number;
        requests_remaining?: number;
        requests_reset?: string;
        tokens_limit?: number;
        tokens_remaining?: number;
        tokens_reset?: string;
        input_tokens_limit?: number;
        input_tokens_remaining?: number;
        output_tokens_limit?: number;
        output_tokens_remaining?: number;
        captured_at?: string;
      }>;
    }

    const data = await response.json() as RateLimitResponse;
    const rateLimits = data.rate_limits || {};

    const limits: Record<string, RateLimitInfo> = {};
    for (const [key, value] of Object.entries(rateLimits)) {
      limits[key] = {
        model: value.model || key,
        requestsLimit: value.requests_limit || 0,
        requestsRemaining: value.requests_remaining || 0,
        requestsReset: value.requests_reset,
        tokensLimit: value.tokens_limit || 0,
        tokensRemaining: value.tokens_remaining || 0,
        tokensReset: value.tokens_reset,
        inputTokensLimit: value.input_tokens_limit,
        inputTokensRemaining: value.input_tokens_remaining,
        outputTokensLimit: value.output_tokens_limit,
        outputTokensRemaining: value.output_tokens_remaining,
        capturedAt: value.captured_at || new Date().toISOString(),
      };
    }

    return { limits, source: 'proxy' };
  } catch {
    return { limits: {}, source: 'none' };
  }
}

/**
 * Task and quality insights
 */
export interface TaskMetrics {
  squad: string;
  tasksTotal: number;
  tasksCompleted: number;
  tasksFailed: number;
  successRate: number;
  totalRetries: number;
  tasksWithRetries: number;
  avgRetries: number;
  avgDurationMs: number;
  avgTokens: number;
  avgCost: number;
  avgContextPct: number;
  maxContextTokens: number;
}

export interface ToolMetrics {
  toolName: string;
  usageCount: number;
  successRate: number;
  avgDurationMs: number;
}

export interface QualityMetrics {
  squad: string;
  feedbackCount: number;
  avgQuality: number;
  helpfulPct: number;
  fixRequiredPct: number;
}

export interface Insights {
  period: string;
  days: number;
  taskMetrics: TaskMetrics[];
  qualityMetrics: QualityMetrics[];
  topTools: ToolMetrics[];
  toolFailureRate: number;
  source: 'bridge' | 'none';
}

/**
 * Fetch insights from the bridge
 */
export async function fetchInsights(period: 'day' | 'week' | 'month' = 'week'): Promise<Insights> {
  try {
    const response = await fetchWithTimeout(`${BRIDGE_URL}/api/insights?period=${period}`, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      return {
        period,
        days: period === 'day' ? 1 : period === 'week' ? 7 : 30,
        taskMetrics: [],
        qualityMetrics: [],
        topTools: [],
        toolFailureRate: 0,
        source: 'none',
      };
    }

    interface InsightsResponse {
      period: string;
      days: number;
      task_metrics?: Array<{
        squad: string;
        tasks_total: number;
        tasks_completed: number;
        tasks_failed: number;
        success_rate: number;
        total_retries: number;
        tasks_with_retries: number;
        avg_retries: number;
        avg_duration_ms: number;
        avg_tokens: number;
        avg_cost: number;
        avg_context_pct: number;
        max_context_tokens: number;
      }>;
      quality_metrics?: Array<{
        squad: string;
        feedback_count: number;
        avg_quality: number;
        helpful_pct: number;
        fix_required_pct: number;
      }>;
      top_tools?: Array<{
        tool_name: string;
        usage_count: number;
        success_rate: number;
        avg_duration_ms: number;
      }>;
      tool_failure_rate?: number;
    }

    const data = await response.json() as InsightsResponse;

    return {
      period: data.period || period,
      days: data.days || 7,
      taskMetrics: (data.task_metrics || []).map(t => ({
        squad: t.squad,
        tasksTotal: t.tasks_total || 0,
        tasksCompleted: t.tasks_completed || 0,
        tasksFailed: t.tasks_failed || 0,
        successRate: t.success_rate || 0,
        totalRetries: t.total_retries || 0,
        tasksWithRetries: t.tasks_with_retries || 0,
        avgRetries: t.avg_retries || 0,
        avgDurationMs: t.avg_duration_ms || 0,
        avgTokens: t.avg_tokens || 0,
        avgCost: t.avg_cost || 0,
        avgContextPct: t.avg_context_pct || 0,
        maxContextTokens: t.max_context_tokens || 0,
      })),
      qualityMetrics: (data.quality_metrics || []).map(q => ({
        squad: q.squad,
        feedbackCount: q.feedback_count || 0,
        avgQuality: q.avg_quality || 0,
        helpfulPct: q.helpful_pct || 0,
        fixRequiredPct: q.fix_required_pct || 0,
      })),
      topTools: (data.top_tools || []).map(t => ({
        toolName: t.tool_name,
        usageCount: t.usage_count || 0,
        successRate: t.success_rate || 0,
        avgDurationMs: t.avg_duration_ms || 0,
      })),
      toolFailureRate: data.tool_failure_rate || 0,
      source: 'bridge',
    };
  } catch {
    return {
      period,
      days: period === 'day' ? 1 : period === 'week' ? 7 : 30,
      taskMetrics: [],
      qualityMetrics: [],
      topTools: [],
      toolFailureRate: 0,
      source: 'none',
    };
  }
}

// === NPM Stats for Acquisition Tracking ===

export interface NpmStats {
  package: string;
  downloads: {
    lastDay: number;
    lastWeek: number;
    lastMonth: number;
  };
  weekOverWeek: number; // percentage change
}

export async function fetchNpmStats(packageName: string = process.env.SQUADS_NPM_PACKAGE || 'squads-cli'): Promise<NpmStats | null> {
  try {
    const [dayRes, weekRes, monthRes] = await Promise.all([
      fetch(`https://api.npmjs.org/downloads/point/last-day/${packageName}`),
      fetch(`https://api.npmjs.org/downloads/point/last-week/${packageName}`),
      fetch(`https://api.npmjs.org/downloads/point/last-month/${packageName}`),
    ]);

    if (!dayRes.ok || !weekRes.ok || !monthRes.ok) return null;

    const [dayData, weekData, monthData] = await Promise.all([
      dayRes.json() as Promise<{ downloads: number }>,
      weekRes.json() as Promise<{ downloads: number }>,
      monthRes.json() as Promise<{ downloads: number }>,
    ]);

    // Calculate week-over-week growth (rough estimate: this week vs avg of month)
    const avgWeeklyFromMonth = monthData.downloads / 4;
    const weekOverWeek = avgWeeklyFromMonth > 0
      ? Math.round(((weekData.downloads - avgWeeklyFromMonth) / avgWeeklyFromMonth) * 100)
      : 0;

    return {
      package: packageName,
      downloads: {
        lastDay: dayData.downloads,
        lastWeek: weekData.downloads,
        lastMonth: monthData.downloads,
      },
      weekOverWeek,
    };
  } catch {
    return null;
  }
}

/**
 * Claude Code subscription capacity data
 * Read from ~/.claude/stats-cache.json
 */
export interface ClaudeCodeCapacity {
  // Weekly capacity (from stats-cache.json token data)
  weeklyTokensUsed: number;
  weeklyTokensLimit: number;
  weeklyCapacityPct: number;
  // Session capacity (estimated from current session)
  sessionTokensUsed: number;
  sessionTokensLimit: number;
  sessionCapacityPct: number;
  // By model breakdown
  opusTokensUsed: number;
  sonnetTokensUsed: number;
  haikuTokensUsed: number;
  // Reset info
  weeklyResetDate: string;
  sessionResetTime: string;
}

// Claude Code subscription capacity estimation
// The actual limits use "usage units" not raw tokens
// Opus costs ~5x more usage units than Sonnet/Haiku
// Based on user reports: Max 20x gives ~24-40 hours Opus/week
// Conservative estimate: ~4M "weighted tokens" per week for Max 20x
const OPUS_WEIGHT = 5;      // Opus costs ~5x more against limit
const SONNET_WEIGHT = 1;    // Sonnet is the baseline
const HAIKU_WEIGHT = 0.25;  // Haiku is cheaper

// Effective weekly limit in weighted tokens (conservative for Max 20x)
// Adjust via SQUADS_WEEKLY_LIMIT env var if your plan differs
const DEFAULT_WEEKLY_WEIGHTED_LIMIT = 4_000_000;
const MAX5_SESSION_TOKEN_LIMIT = 2_000_000; // ~2M tokens/session (raw)

/**
 * Fetch Claude Code capacity from stats-cache.json
 */
export async function fetchClaudeCodeCapacity(): Promise<ClaudeCodeCapacity | null> {
  const { readFile } = await import('fs/promises');
  const { homedir } = await import('os');
  const { join } = await import('path');

  try {
    const cacheFile = join(homedir(), '.claude', 'stats-cache.json');
    const content = await readFile(cacheFile, 'utf-8');
    const data = JSON.parse(content) as {
      dailyModelTokens?: Array<{
        date: string;
        tokensByModel: Record<string, number>;
      }>;
      modelUsage?: Record<string, {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      }>;
    };

    // Calculate weekly token usage (last 7 days)
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const weekStart = weekAgo.toISOString().split('T')[0];

    let weeklyOpus = 0;

    if (data.dailyModelTokens) {
      for (const day of data.dailyModelTokens) {
        if (day.date >= weekStart) {
          for (const [model, tokens] of Object.entries(day.tokensByModel)) {
            if (model.includes('opus')) {
              weeklyOpus += tokens;
            }
          }
        }
      }
    }

    // Calculate weighted usage (Opus costs 5x more against limit)
    // This better reflects actual subscription capacity consumption
    const weeklyLimit = parseInt(process.env.SQUADS_WEEKLY_LIMIT || '', 10) || DEFAULT_WEEKLY_WEIGHTED_LIMIT;

    // Calculate session usage (today's tokens as proxy)
    const today = now.toISOString().split('T')[0];
    let sessionTokens = 0;
    if (data.dailyModelTokens) {
      const todayData = data.dailyModelTokens.find(d => d.date === today);
      if (todayData) {
        sessionTokens = Object.values(todayData.tokensByModel).reduce((a, b) => a + b, 0);
      }
    }

    // Calculate weekly reset (next Sunday 9:59pm in local timezone)
    const daysUntilSunday = (7 - now.getDay()) % 7 || 7;
    const nextSunday = new Date(now);
    nextSunday.setDate(now.getDate() + daysUntilSunday);
    nextSunday.setHours(21, 59, 0, 0);

    // Session reset (end of current session - approximate as end of day)
    const sessionReset = new Date(now);
    sessionReset.setHours(18, 59, 0, 0);
    if (sessionReset < now) {
      sessionReset.setDate(sessionReset.getDate() + 1);
    }

    // Calculate Sonnet/Haiku usage
    let sonnetTokens = 0;
    let haikuTokens = 0;
    if (data.dailyModelTokens) {
      for (const day of data.dailyModelTokens) {
        if (day.date >= weekStart) {
          for (const [model, tokens] of Object.entries(day.tokensByModel)) {
            if (model.includes('sonnet')) {
              sonnetTokens += tokens;
            } else if (model.includes('haiku')) {
              haikuTokens += tokens;
            }
          }
        }
      }
    }

    // Calculate weighted weekly usage
    const weeklyWeighted = Math.round(
      (weeklyOpus * OPUS_WEIGHT) +
      (sonnetTokens * SONNET_WEIGHT) +
      (haikuTokens * HAIKU_WEIGHT)
    );

    return {
      weeklyTokensUsed: weeklyWeighted, // Now weighted, not raw
      weeklyTokensLimit: weeklyLimit,
      weeklyCapacityPct: Math.round((weeklyWeighted / weeklyLimit) * 100),
      sessionTokensUsed: sessionTokens,
      sessionTokensLimit: MAX5_SESSION_TOKEN_LIMIT,
      sessionCapacityPct: Math.round((sessionTokens / MAX5_SESSION_TOKEN_LIMIT) * 100),
      opusTokensUsed: weeklyOpus,
      sonnetTokensUsed: sonnetTokens,
      haikuTokensUsed: haikuTokens,
      weeklyResetDate: nextSunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      sessionResetTime: sessionReset.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    };
  } catch {
    return null;
  }
}

// === ROI and Cost Projection Types ===

/**
 * ROI metrics for measuring value delivered vs cost
 */
export interface ROIMetrics {
  totalCostUsd: number;
  costPerGoal: number;
  costPerCommit: number;
  costPerPR: number;
  estimatedValueUsd: number;
  roiMultiplier: number;
  dailyProjectedCost: number;
  weeklyProjectedCost: number;
  monthlyProjectedCost: number;
  hoursTracked: number;
  costPerHour: number;
}

/**
 * Before/after comparison for a period
 */
export interface BeforeAfterMetrics {
  periodStart: string;
  periodEnd: string;
  baselineCostUsd: number;
  baselineGoals: number;
  baselineCommits: number;
  baselinePRs: number;
  baselineTokens: number;
  currentCostUsd: number;
  currentGoals: number;
  currentCommits: number;
  currentPRs: number;
  currentTokens: number;
  costDelta: number;
  goalsDelta: number;
  commitsDelta: number;
  prsDelta: number;
  tokensDelta: number;
  costPerGoalBefore: number;
  costPerGoalAfter: number;
  efficiencyImprovement: number;
}

/**
 * Squad-level cost projection
 */
export interface SquadCostProjection {
  squad: string;
  currentDailyCost: number;
  projectedDailyCost: number;
  projectedWeeklyCost: number;
  projectedMonthlyCost: number;
  costTrend: 'increasing' | 'stable' | 'decreasing';
  trendPct: number;
}

/**
 * Calculate ROI metrics from cost and activity data
 */
export function calculateROIMetrics(
  costs: CostSummary | null,
  goalsCompleted: number,
  commits: number,
  prsMerged: number,
  hoursTracked: number = 0
): ROIMetrics {
  const totalCost = costs?.totalCost || 0;
  const costPerGoal = goalsCompleted > 0 ? totalCost / goalsCompleted : 0;
  const costPerCommit = commits > 0 ? totalCost / commits : 0;
  const costPerPR = prsMerged > 0 ? totalCost / prsMerged : 0;

  const GOAL_VALUE = parseFloat(process.env.SQUADS_GOAL_VALUE || '100');
  const PR_VALUE = parseFloat(process.env.SQUADS_PR_VALUE || '200');
  const COMMIT_VALUE = parseFloat(process.env.SQUADS_COMMIT_VALUE || '25');

  const estimatedValue = (goalsCompleted * GOAL_VALUE) + (prsMerged * PR_VALUE) + (commits * COMMIT_VALUE);
  const roiMultiplier = totalCost > 0 ? estimatedValue / totalCost : 0;

  const now = new Date();
  const hoursElapsed = hoursTracked > 0 ? hoursTracked : Math.max(now.getHours() + now.getMinutes() / 60, 1);
  const costPerHour = totalCost / hoursElapsed;

  return {
    totalCostUsd: totalCost,
    costPerGoal,
    costPerCommit,
    costPerPR,
    estimatedValueUsd: estimatedValue,
    roiMultiplier,
    dailyProjectedCost: costPerHour * 24,
    weeklyProjectedCost: costPerHour * 24 * 7,
    monthlyProjectedCost: costPerHour * 24 * 30,
    hoursTracked: hoursElapsed,
    costPerHour,
  };
}

/**
 * Calculate cost projections per squad
 */
export function calculateSquadCostProjections(
  bridgeStats: BridgeStats | null,
  _history: Array<{ squad: string; costUsd: number }[]> | null
): SquadCostProjection[] {
  if (!bridgeStats || bridgeStats.bySquad.length === 0) {
    return [];
  }

  const now = new Date();
  const hoursElapsed = Math.max(now.getHours() + now.getMinutes() / 60, 1);

  return bridgeStats.bySquad.map(squad => {
    const hourlyRate = squad.costUsd / hoursElapsed;
    return {
      squad: squad.squad,
      currentDailyCost: squad.costUsd,
      projectedDailyCost: hourlyRate * 24,
      projectedWeeklyCost: hourlyRate * 24 * 7,
      projectedMonthlyCost: hourlyRate * 24 * 30,
      costTrend: 'stable' as const,
      trendPct: 0,
    };
  });
}
