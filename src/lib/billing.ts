/**
 * Provider-correct billing for ledger rows (#1355).
 *
 * `cost_usd` has always been one list-price table applied to every provider,
 * which is wrong for flat-plan (subscription) and free models, and for
 * providers priced differently. The ledger row's `billing` field is the
 * honest figure: it names the billing KIND, a marginal `usd` (or null when
 * no price is known), and the data `source` it was computed from.
 *
 * Prices live in DATA — `provider-prices.json` — never in code. Editing a
 * price is a JSON edit, not a code change + release.
 */

import priceData from './provider-prices.json';

export type BillingKind = 'metered' | 'subscription' | 'free';

export interface Billing {
  kind: BillingKind;
  /** Marginal cost in USD. null = metered but no price entry for the model. */
  usd: number | null;
  /** Names the table + date (and provider/model) this figure came from. */
  source: string;
}

export interface BillingInput {
  provider: string;
  model?: string;
  /** Executor harness ('claude' | 'opencode' | 'kimi-code' | …), when known. */
  harness?: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

/** Per-1M-token price. Cache fields are absent where a provider doesn't price them. */
interface TokenPrice {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

interface ProviderPriceTable {
  default: TokenPrice;
  models: Record<string, TokenPrice>;
}

const TABLE = (priceData as { table: string; updated: string; providers: Record<string, ProviderPriceTable> });
const TABLE_NAME: string = TABLE.table;
const UPDATED: string = TABLE.updated;
const PROVIDERS: Record<string, ProviderPriceTable> = TABLE.providers;

/** A free model id: an opencode `*-free` gateway model, or a bare `free` segment. */
const FREE_MODEL_RE = /(^|[-_/])free([-_/]|$)/i;

/** subscription: kimi-code runs ride the Kimi For Coding flat plan (#1309). */
function isSubscription(input: BillingInput): boolean {
  const p = (input.provider || '').toLowerCase();
  const h = (input.harness || '').toLowerCase();
  return p === 'kimi-code' || h === 'kimi-code';
}

function isFreeModel(model: string | undefined): boolean {
  return !!model && FREE_MODEL_RE.test(model);
}

/**
 * The provider whose prices bill this run. opencode-hosted ids carry the real
 * provider in the model (`deepseek/deepseek-chat`, `opencode/…`); for those,
 * bill the inner provider — opencode's own `-free` models are caught by
 * `isFreeModel` before this is called.
 */
function billingProvider(input: BillingInput): string {
  const p = (input.provider || '').toLowerCase();
  const m = (input.model || '').trim();
  if (p === 'opencode') {
    const inner = m.replace(/^opencode\//i, '');
    const slash = inner.indexOf('/');
    if (slash > 0) {
      const candidate = inner.slice(0, slash).toLowerCase();
      if (PROVIDERS[candidate]) return candidate;
    }
  }
  return p;
}

/** Exact → case-insensitive → family (substring) match → provider default. */
function resolvePrice(provider: string, model: string): { price?: TokenPrice; family: string } {
  const table = PROVIDERS[provider];
  if (!table) return { family: 'default' };
  if (!model) return { price: table.default, family: 'default' };

  const lower = model.toLowerCase();
  const exact = table.models[lower];
  if (exact) return { price: exact, family: lower };

  const ciKey = Object.keys(table.models).find((k) => k.toLowerCase() === lower);
  if (ciKey) return { price: table.models[ciKey], family: ciKey };

  const partial = Object.keys(table.models).find(
    (k) => lower.includes(k.toLowerCase()) || k.toLowerCase().includes(lower),
  );
  if (partial) return { price: table.models[partial], family: partial };

  return { price: table.default, family: 'default' };
}

function tokenCost(input: BillingInput, p: TokenPrice): number {
  return (
    ((input.input_tokens || 0) / 1_000_000) * (p.input || 0) +
    ((input.output_tokens || 0) / 1_000_000) * (p.output || 0) +
    ((input.cache_read_tokens || 0) / 1_000_000) * (p.cache_read || 0) +
    ((input.cache_write_tokens || 0) / 1_000_000) * (p.cache_write || 0)
  );
}

/** Compute the ledger row's `billing` field from provider + model + tokens. */
export function computeBilling(input: BillingInput): Billing {
  if (isSubscription(input)) {
    return { kind: 'subscription', usd: 0, source: `${TABLE_NAME}@${UPDATED}: kimi-code subscription (flat plan)` };
  }
  if (isFreeModel(input.model)) {
    return { kind: 'free', usd: 0, source: `${TABLE_NAME}@${UPDATED}: ${input.model} is a free model` };
  }

  const provider = billingProvider(input);
  const { price, family } = resolvePrice(provider, input.model || '');
  if (!price) {
    return {
      kind: 'metered',
      usd: null,
      source: `${TABLE_NAME}@${UPDATED}: no price entry for ${provider || 'unknown'}${input.model ? `/${input.model}` : ''}`,
    };
  }
  return {
    kind: 'metered',
    usd: tokenCost(input, price),
    source: `${TABLE_NAME}@${UPDATED}: ${provider} ${family}`,
  };
}
