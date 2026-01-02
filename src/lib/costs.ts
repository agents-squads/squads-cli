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

const DEFAULT_DAILY_BUDGET = 50.0;
const DEFAULT_DAILY_CALL_LIMIT = 1000; // Default API call limit per day
const BRIDGE_URL = process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088';

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.default;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/**
 * Fetch cost summary from Squads Bridge (postgres)
 */
async function fetchFromBridge(period: 'day' | 'week' | 'month' = 'day'): Promise<CostSummary | null> {
  try {
    const response = await fetch(`${BRIDGE_URL}/api/cost/summary?period=${period}`, {
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
      calls: s.generations as number,
      inputTokens: s.input_tokens as number,
      outputTokens: s.output_tokens as number,
      cost: s.cost_usd as number,
      models: {},
    }));

    const totalCalls = bySquad.reduce((sum, s) => sum + s.calls, 0);
    const dailyCallLimit = parseFloat(process.env.SQUADS_DAILY_CALL_LIMIT || '') || DEFAULT_DAILY_CALL_LIMIT;

    return {
      totalCost,
      dailyBudget,
      usedPercent: (totalCost / dailyBudget) * 100,
      idleBudget: dailyBudget - totalCost,
      totalCalls,
      dailyCallLimit,
      callsPercent: (totalCalls / dailyCallLimit) * 100,
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

    const response = await fetch(url, {
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

    return {
      totalCost,
      dailyBudget,
      usedPercent: (totalCost / dailyBudget) * 100,
      idleBudget: dailyBudget - totalCost,
      totalCalls,
      dailyCallLimit,
      callsPercent: (totalCalls / dailyCallLimit) * 100,
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
  return {
    totalCost: 0,
    dailyBudget: parseFloat(process.env.SQUADS_DAILY_BUDGET || '') || DEFAULT_DAILY_BUDGET,
    usedPercent: 0,
    idleBudget: parseFloat(process.env.SQUADS_DAILY_BUDGET || '') || DEFAULT_DAILY_BUDGET,
    bySquad: [],
    source: 'none',
  };
}

export function formatCostBar(usedPercent: number, width = 20): string {
  const filled = Math.min(Math.round((usedPercent / 100) * width), width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
