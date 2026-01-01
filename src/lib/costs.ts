/**
 * Cost tracking via Langfuse API
 * Fetches token usage and calculates costs by squad
 */

interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host: string;
}

interface SquadCosts {
  squad: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  models: Record<string, number>;
}

interface CostSummary {
  totalCost: number;
  dailyBudget: number;
  usedPercent: number;
  idleBudget: number;
  bySquad: SquadCosts[];
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

function getLangfuseConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const host = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL || 'https://us.cloud.langfuse.com';

  if (!publicKey || !secretKey) {
    return null;
  }

  return { publicKey, secretKey, host };
}

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING.default;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export async function fetchCostSummary(limit = 100): Promise<CostSummary | null> {
  const config = getLangfuseConfig();
  if (!config) {
    return null;
  }

  try {
    const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString('base64');
    const url = `${config.host}/api/public/observations?limit=${limit}`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
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

    return {
      totalCost,
      dailyBudget,
      usedPercent: (totalCost / dailyBudget) * 100,
      idleBudget: dailyBudget - totalCost,
      bySquad: squadList,
    };
  } catch {
    return null;
  }
}

export function formatCostBar(usedPercent: number, width = 20): string {
  const filled = Math.min(Math.round((usedPercent / 100) * width), width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
