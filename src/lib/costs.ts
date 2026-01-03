/**
 * Cost tracking via Squads Bridge (postgres) or Langfuse
 * Primary: Squads Bridge API → PostgreSQL
 * Fallback: Langfuse API (if bridge unavailable)
 */

interface SquadCosts {
  squad: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
  models: Record<string, number>;
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
  source: 'postgres' | 'langfuse' | 'none';
}

// Model pricing (per 1M tokens)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
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
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.default;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
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

  // No data source available
  const defaultBudget = parseFloat(process.env.SQUADS_DAILY_BUDGET || '') || DEFAULT_DAILY_BUDGET;
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
 */
export async function fetchBridgeStats(): Promise<BridgeStats | null> {
  try {
    // Fetch /stats for real-time data
    const statsResponse = await fetchWithTimeout(`${BRIDGE_URL}/stats`, {
      headers: { 'Content-Type': 'application/json' },
    });

    if (!statsResponse.ok) {
      return null;
    }

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

    const stats = await statsResponse.json() as StatsData;

    // Fetch /health for connection statuses
    const healthResponse = await fetchWithTimeout(`${BRIDGE_URL}/health`, {
      headers: { 'Content-Type': 'application/json' },
    });

    interface HealthData {
      postgres?: string;
      redis?: string;
      langfuse?: string;
    }

    const health = healthResponse.ok ? await healthResponse.json() as HealthData : {};

    // Fetch cost summaries for model breakdown (day and week in parallel)
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

    const [costResponse, weekResponse] = await Promise.all([
      fetchWithTimeout(`${BRIDGE_URL}/api/cost/summary?period=day`, {
        headers: { 'Content-Type': 'application/json' },
      }),
      fetchWithTimeout(`${BRIDGE_URL}/api/cost/summary?period=week`, {
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    const costData = costResponse.ok ? await costResponse.json() as CostData : {};
    const weekData = weekResponse.ok ? await weekResponse.json() as CostData : {};

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
