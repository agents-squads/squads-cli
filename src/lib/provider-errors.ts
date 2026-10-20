/**
 * Typed provider errors (#1298 part 1).
 *
 * A provider can fail on account state — plan expired, balance gone, bad key —
 * and that used to surface only as `detached run exited with code 1` (or, worse,
 * a "rate limit" retried ten times). `classifyProviderError` is the one place a
 * failure becomes a class; harness boundaries (spool reconcile, foreground
 * close, the conversation turn) call it and carry the result on the run record
 * and the `error` exec-event.
 *
 * Pure: no I/O, no env, no clock. Order matters and is the whole point —
 * structured codes are read from the raw body BEFORE the HTTP status, because
 * a 429 is often an account cap, not a throttle (Moonshot returns 429 with
 * `exceeded_current_quota_error`; z.ai returns 429 with code 1309 "package has
 * expired"). Design after opencode's provider-error classifier.
 */

export type ProviderErrorType =
  | 'plan_expired'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'rate_limited'
  | 'overloaded'
  | 'bad_request'
  | 'network'
  | 'unknown';

export interface ProviderError {
  type: ProviderErrorType;
  /** Backoff-and-retry can help. False for account state and malformed requests. */
  retryable: boolean;
  /** Key-redacted, ≤500 chars. */
  message: string;
  provider?: string;
  status?: number;
  /** The provider's own code (`1309`, `exceeded_current_quota_error`, …) when the body carried one. */
  providerCode?: string;
}

const RETRYABLE: ReadonlySet<ProviderErrorType> = new Set(['rate_limited', 'overloaded', 'network']);

export function isRetryableErrorType(type: ProviderErrorType): boolean {
  return RETRYABLE.has(type);
}

const MESSAGE_MAX_CHARS = 500;

/** Strip credentials from a message before it reaches a ledger, event file or console. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted-key]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[redacted-key]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted-key]')
    .replace(/\b(api[-_ ]?key|x-api-key|authorization)(["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{12,}/gi, '$1$2[redacted-key]');
}

// z.ai (GLM coding plan) business codes — neither opencode nor Kimi map these.
const ZAI_PLAN_EXPIRED = new Set(['1309', '1314']);
const ZAI_NO_BALANCE = new Set(['1113']);
const ZAI_RATE_LIMIT = new Set(['1302', '1305', '1308', '1310', '1316', '1317', '1318', '1319', '1320', '1321']);
const ZAI_BAD_REQUEST = new Set(['1311']); // model not in plan

const QUOTA_CODES = new Set(['insufficient_quota', 'exceeded_current_quota_error', 'billing_error']);
const AUTH_CODES = new Set(['authentication_error', 'invalid_api_key', 'permission_denied', 'permission_error', 'invalid_authentication_error']);
const RATE_CODES = new Set(['rate_limit_error', 'rate_limit_exceeded', 'rate_limited', 'too_many_requests']);
const OVERLOADED_CODES = new Set(['overloaded_error', 'overloaded', 'service_unavailable']);
const BAD_REQUEST_CODES = new Set(['invalid_request_error', 'bad_request', 'not_found_error', 'invalid_parameter']);

/**
 * Billing-anchored text fallback. Never a bare /quota/ — that also matches
 * tokens-per-minute throttles, which are retryable.
 */
const PLAN_EXPIRED_TEXT = /package has expired|plan (?:has )?expired|subscription (?:has )?expired|coding plan.*expired/i;
const NO_BALANCE_TEXT = /insufficient (?:balance|funds|credit)|credit balance is too low|please recharge|exceeded your current quota|out of credits?|suspended due to insufficient/i;
const AUTH_TEXT = /invalid api key|incorrect api key|invalid credential|authentication (?:failed|error)|not logged in|unauthorized/i;
const NETWORK_TEXT = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|connection (?:closed|error|reset)|fetch failed/i;
const OVERLOADED_TEXT = /\boverloaded\b/i;

interface ParsedBody {
  codes: string[];
  message: string;
}

function collectCodes(value: unknown, out: string[]): void {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value).toLowerCase());
}

function parseBody(body: string): ParsedBody {
  const codes: string[] = [];
  let message = '';
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { json = JSON.parse(body.slice(start, end + 1)); } catch { /* not JSON */ }
    }
  }
  if (json && typeof json === 'object') {
    const root = json as Record<string, unknown>;
    const err = (root.error && typeof root.error === 'object' ? root.error : undefined) as Record<string, unknown> | undefined;
    collectCodes(root.code, codes);
    collectCodes(root.type, codes);
    if (err) {
      collectCodes(err.code, codes);
      collectCodes(err.type, codes);
    }
    const details = (err?.details ?? root.details) as unknown;
    if (Array.isArray(details)) {
      for (const d of details) {
        if (d && typeof d === 'object') collectCodes((d as Record<string, unknown>).reason, codes);
      }
    }
    const msg = err?.message ?? root.message ?? (typeof root.error === 'string' ? root.error : undefined);
    if (typeof msg === 'string') message = msg;
  }
  return { codes, message: message || body };
}

function build(
  type: ProviderErrorType,
  provider: string | undefined,
  status: number | undefined,
  providerCode: string | undefined,
  message: string,
): ProviderError {
  return {
    type,
    retryable: isRetryableErrorType(type),
    message: redactSecrets(message.replace(/\s+/g, ' ').trim()).slice(0, MESSAGE_MAX_CHARS),
    ...(provider ? { provider } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(providerCode ? { providerCode } : {}),
  };
}

/**
 * Classify one provider failure. `body` is the raw response body (JSON or text);
 * `status` the HTTP status when the harness surfaced one.
 */
export function classifyProviderError(provider: string | undefined, status: number | undefined, body: string): ProviderError {
  const { codes, message } = parseBody(body);
  const mk = (type: ProviderErrorType, code?: string) => build(type, provider, status, code ?? codes[0], message);
  const find = (set: ReadonlySet<string>) => codes.find((c) => set.has(c));

  // 1. z.ai numeric business codes.
  let hit = find(ZAI_PLAN_EXPIRED);
  if (hit) return mk('plan_expired', hit);
  hit = find(ZAI_NO_BALANCE);
  if (hit) return mk('quota_exhausted', hit);
  hit = find(ZAI_RATE_LIMIT);
  if (hit) return mk('rate_limited', hit);
  hit = find(ZAI_BAD_REQUEST);
  if (hit) return mk('bad_request', hit);

  // 2. Structured codes — quota before auth before throttles.
  hit = find(QUOTA_CODES);
  if (hit) return mk('quota_exhausted', hit);
  hit = find(AUTH_CODES);
  if (hit) return mk('auth_invalid', hit);

  // 3. Billing-anchored text. Before the status: Anthropic reports "credit
  //    balance is too low" as a 400 invalid_request_error.
  if (PLAN_EXPIRED_TEXT.test(message)) return mk('plan_expired');
  if (NO_BALANCE_TEXT.test(message)) return mk('quota_exhausted');

  // 4. Remaining structured throttle / overload codes.
  hit = find(OVERLOADED_CODES);
  if (hit) return mk('overloaded', hit);
  hit = find(RATE_CODES);
  if (hit) return mk('rate_limited', hit);

  // 5. HTTP status. Quota already ruled out, so a bare 429 is a throttle.
  if (status !== undefined) {
    if (status === 402) return mk('quota_exhausted');
    if (status === 401 || status === 403) return mk('auth_invalid');
    if (status === 429) return mk('rate_limited');
    if (status === 529 || status === 503 || status === 502 || status === 500 || status === 504) return mk('overloaded');
    if (status === 408) return mk('network');
    if (status === 400 || status === 404 || status === 413 || status === 422) return mk('bad_request');
  }

  // 6. Weak signals.
  hit = find(BAD_REQUEST_CODES);
  if (hit) return mk('bad_request', hit);
  if (AUTH_TEXT.test(message)) return mk('auth_invalid');
  if (OVERLOADED_TEXT.test(message)) return mk('overloaded');
  if (NETWORK_TEXT.test(message)) return mk('network');
  return mk('unknown');
}

const STATUS_PATTERNS = [
  /API Error:?\s*(\d{3})\b/i,
  /\b(?:HTTP|status(?: code)?)[ :=]+(\d{3})\b/i,
  /\b(?:error|Error) (\d{3})\b/,
];

/**
 * Find a provider failure inside free text — a `result` event's text, a log
 * tail, a turn's response. Returns null when the text carries no recognisable
 * provider error (type `unknown` is treated as "nothing here"), so a healthy
 * log never gains an error. Call it only on runs already known to have failed:
 * agent prose that merely discusses rate limits must not become a finding.
 */
export function extractProviderError(provider: string | undefined, text: string): ProviderError | null {
  if (!text) return null;
  let status: number | undefined;
  for (const re of STATUS_PATTERNS) {
    const m = text.match(re);
    if (m) { status = Number(m[1]); break; }
  }
  const result = classifyProviderError(provider, status, text);
  return result.type === 'unknown' ? null : result;
}

/** Sentinel the conversation loop uses to carry a non-retryable class through turn text. */
const SENTINEL = /^\[PROVIDER_ERROR:([a-z_]+)\]/;

export function providerErrorSentinel(err: ProviderError, agentName: string): string {
  return `[PROVIDER_ERROR:${err.type}] ${agentName}: ${err.message}`;
}

export function parseProviderErrorSentinel(text: string): ProviderErrorType | null {
  const m = text.match(SENTINEL);
  return m ? (m[1] as ProviderErrorType) : null;
}

/** Operator-facing one-liner: what happened and what to do. */
export function describeProviderError(err: ProviderError): string {
  const who = err.provider ? `${err.provider}: ` : '';
  switch (err.type) {
    case 'plan_expired': return `${who}plan expired — renew the plan, then re-dispatch`;
    case 'quota_exhausted': return `${who}no balance / quota exhausted — top up, then re-dispatch`;
    case 'auth_invalid': return `${who}credentials rejected — fix the key or login, then re-dispatch`;
    case 'bad_request': return `${who}request rejected as invalid — retrying will not help`;
    case 'rate_limited': return `${who}rate limited — retry with backoff`;
    case 'overloaded': return `${who}provider overloaded — retry with backoff`;
    case 'network': return `${who}network failure — retry with backoff`;
    default: return `${who}unclassified provider error`;
  }
}
