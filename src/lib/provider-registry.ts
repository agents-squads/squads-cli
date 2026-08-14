/**
 * Provider registry — a provider is DATA, not code.
 *
 * Spec: .agents/specs/provider-registry-2026-08-13.md (hq)
 * Implements #1156 (registry as config) and the declaration half of #1155
 * (credential contract).
 *
 * Before this, adding a model meant editing the 425-line `CLIConfig` table in
 * llm-clis.ts and shipping the CLI. Now an Anthropic-compatible provider is a
 * few lines of YAML in `~/.squads/providers.yaml` and it runs — zero
 * TypeScript, which is the whole point of #1156.
 *
 * `harness: native` is in the schema from the start, deliberately. A registry
 * whose only harness kind shells out to a third-party binary is a config file,
 * not a runtime boundary — and 88.5% of our logged runs currently go through
 * one binary we do not own. The native runtime lands in a follow-up; declaring
 * it here costs one enum value now instead of a schema migration later.
 */
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import yaml from 'js-yaml';

/**
 * How a provider is executed.
 * - an external CLI name: we spawn that binary (today's behaviour)
 * - `native`: WE own the loop, talking to the provider's HTTP API directly
 */
export type HarnessKind =
  | 'claude' | 'gemini' | 'codex' | 'aider' | 'opencode' | 'ollama'
  | 'native';

export const EXTERNAL_HARNESSES: readonly HarnessKind[] =
  ['claude', 'gemini', 'codex', 'aider', 'opencode', 'ollama'] as const;

/** Wire protocol for a `native` provider. */
export type WireApi = 'anthropic-messages' | 'openai-chat';

export interface ProviderEntry {
  /** Registry key, e.g. `deepseek`. */
  name: string;
  harness: HarnessKind;
  /** Human label for UI. Defaults to `name`. */
  display_name?: string;
  /** Endpoint override — Anthropic-compatible providers point here. */
  base_url?: string;
  /** Wire protocol (native harness only). */
  api?: WireApi;
  /** Filename under ~/.squads/secrets/ holding the credential. */
  key_ref?: string;
  /** Env vars the lane requires. Strict-require, fail loud — no silent fallback. */
  required_env?: string[];
  /** Models this provider accepts. First entry is the lane default. */
  models?: string[];
  /** Tool surface for a native lane. Bounded on purpose — tools are the cost centre. */
  tools?: string[];
}

export interface RegistryLoadResult {
  providers: Record<string, ProviderEntry>;
  /** Human-readable problems. Never thrown: a bad entry must not break unrelated lanes. */
  errors: string[];
  /** Path actually read, or null when no user registry exists. */
  source: string | null;
}

export function providerRegistryPath(): string {
  return process.env.SQUADS_PROVIDERS_FILE
    || join(homedir(), '.squads', 'providers.yaml');
}

export function secretsDir(): string {
  return join(homedir(), '.squads', 'secrets');
}

/**
 * Resolve a `key_ref` to its secret value. Per the secrets doctrine the
 * canonical location is one file per secret under ~/.squads/secrets/.
 * Returns null when absent — callers decide whether that is fatal, because
 * "missing" and "invalid" are different dispatch errors.
 */
export function readProviderSecret(keyRef: string): string | null {
  if (!keyRef || keyRef.includes('/') || keyRef.includes('..')) return null;
  const p = join(secretsDir(), keyRef);
  if (!existsSync(p)) return null;
  try {
    const v = readFileSync(p, 'utf-8').trim();
    return v || null;
  } catch {
    return null;
  }
}

function validateEntry(name: string, raw: unknown): { entry?: ProviderEntry; error?: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: `provider '${name}': entry must be a mapping` };
  }
  const r = raw as Record<string, unknown>;
  const harness = r.harness;
  if (typeof harness !== 'string') {
    return { error: `provider '${name}': missing 'harness'` };
  }
  const known: string[] = [...EXTERNAL_HARNESSES, 'native'];
  if (!known.includes(harness)) {
    return { error: `provider '${name}': unknown harness '${harness}' (expected one of ${known.join(', ')})` };
  }
  if (harness === 'native') {
    const api = r.api;
    if (api !== undefined && api !== 'anthropic-messages' && api !== 'openai-chat') {
      return { error: `provider '${name}': unknown api '${String(api)}'` };
    }
    if (!r.base_url) {
      return { error: `provider '${name}': harness 'native' requires 'base_url'` };
    }
  }
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;

  return {
    entry: {
      name,
      harness: harness as HarnessKind,
      display_name: typeof r.display_name === 'string' ? r.display_name : undefined,
      base_url: typeof r.base_url === 'string' ? r.base_url : undefined,
      api: typeof r.api === 'string' ? r.api as WireApi : undefined,
      key_ref: typeof r.key_ref === 'string' ? r.key_ref : undefined,
      required_env: strArray(r.required_env),
      models: strArray(r.models),
      tools: strArray(r.tools),
    },
  };
}

/**
 * Parsed registries by path. getCLIConfig() is on a hot path (every provider
 * lookup), and re-reading + re-parsing YAML each time is pure waste in a
 * short-lived CLI process. Keyed by path so tests pointing at different
 * fixtures don't collide.
 */
const registryCache = new Map<string, RegistryLoadResult>();

/** Drop the cache — for tests, and for any command that rewrites the registry. */
export function clearProviderRegistryCache(): void {
  registryCache.clear();
}

/**
 * Load the user registry. A fresh `squads init` has no such file and must work
 * anyway, so absence is not an error — it yields an empty registry and the
 * built-in providers continue to serve.
 */
export function loadProviderRegistry(path = providerRegistryPath()): RegistryLoadResult {
  const cached = registryCache.get(path);
  if (cached) return cached;
  const result = loadProviderRegistryUncached(path);
  registryCache.set(path, result);
  return result;
}

function loadProviderRegistryUncached(path: string): RegistryLoadResult {
  const empty: RegistryLoadResult = { providers: {}, errors: [], source: null };
  if (!existsSync(path)) return empty;

  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(path, 'utf-8'));
  } catch (e) {
    return { ...empty, source: path, errors: [`${path}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!doc || typeof doc !== 'object') return { ...empty, source: path };

  const section = (doc as Record<string, unknown>).providers;
  if (!section || typeof section !== 'object') return { ...empty, source: path };

  const providers: Record<string, ProviderEntry> = {};
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(section as Record<string, unknown>)) {
    const { entry, error } = validateEntry(name, raw);
    if (error) errors.push(error);
    else if (entry) providers[name] = entry;
  }
  return { providers, errors, source: path };
}

/**
 * Credential state for a provider, without contacting the network. The live
 * probe (#1155 step 2) belongs at dispatch; this reports only what is
 * declared and present, which is what `squads doctor` can show offline.
 */
export interface CredentialState {
  provider: string;
  keyRef: string | null;
  secretPresent: boolean;
  missingEnv: string[];
  ok: boolean;
}

export function credentialState(entry: ProviderEntry): CredentialState {
  const keyRef = entry.key_ref ?? null;
  const secretPresent = keyRef ? readProviderSecret(keyRef) !== null : false;
  const required = entry.required_env ?? [];
  const missingEnv = required.filter(v => !process.env[v]);

  // Credential-ready if EITHER source can supply it: the secrets file (the
  // canonical location) or the declared env vars already being exported, which
  // is legitimate for an operator running a lane by hand. Written as an
  // explicit either/or — the one-liner this replaced mixed && and || and read
  // as the opposite of its intent.
  const fromSecretsFile = secretPresent;
  const fromEnv = required.length > 0 && missingEnv.length === 0;
  const needsNoCredential = keyRef === null && required.length === 0;
  const ok = fromSecretsFile || fromEnv || needsNoCredential;

  return { provider: entry.name, keyRef, secretPresent, missingEnv, ok };
}

export type ProbeState = 'ok' | 'missing' | 'invalid' | 'unreachable' | 'skipped';

export interface ProbeResult {
  state: ProbeState;
  detail: string;
  /**
   * Whether this result should STOP a dispatch. Only definitive negatives do:
   * a credential we can prove is absent or rejected. `unreachable` must not
   * block — refusing to dispatch because our own network blipped would trade
   * one failure mode for a worse one (#1155 asks to prevent burning a run on a
   * dead key, not to add a new way to be unable to work).
   */
  blocking: boolean;
}

/**
 * Cheap auth probe for a registry provider (#1155 step 2 — "derived, not
 * declared": the registry declares a key exists, only this establishes that it
 * works). One request with max_tokens 1, short timeout, native fetch — no new
 * dependency.
 *
 * Runs only for Anthropic-compatible registry providers. Built-in providers
 * keep their existing checks; this is additive.
 */
export async function probeProviderCredential(
  entry: ProviderEntry,
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const cred = credentialState(entry);
  if (!cred.ok) {
    const what = cred.keyRef
      ? `no secret at ~/.squads/secrets/${cred.keyRef}`
      : `missing env: ${cred.missingEnv.join(', ') || 'none declared'}`;
    return { state: 'missing', detail: what, blocking: true };
  }
  if (!entry.base_url) {
    return { state: 'skipped', detail: 'no base_url to probe', blocking: false };
  }

  const token = (entry.key_ref && readProviderSecret(entry.key_ref))
    || (entry.required_env ?? []).map(v => process.env[v]).find(Boolean);
  if (!token) {
    return { state: 'missing', detail: 'credential resolved empty', blocking: true };
  }

  const url = `${entry.base_url.replace(/\/+$/, '')}/v1/messages`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': token,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: entry.models?.[0] ?? 'unknown',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    if (res.status === 401 || res.status === 403) {
      return { state: 'invalid', detail: `HTTP ${res.status} — credential rejected`, blocking: true };
    }
    if (res.ok) return { state: 'ok', detail: `HTTP ${res.status}`, blocking: false };
    // 400/404 etc: the credential was accepted far enough to be told the model
    // or route is wrong. That is a configuration problem, not an auth failure,
    // and it must not be reported as a bad key.
    return { state: 'unreachable', detail: `HTTP ${res.status} — endpoint/model config`, blocking: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const why = ac.signal.aborted ? `no response in ${timeoutMs}ms` : msg;
    return { state: 'unreachable', detail: why, blocking: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Environment a registry provider needs, for an Anthropic-compatible endpoint
 * driven through the `claude` harness — the proven GLM/DeepSeek pattern.
 * `undefined` values are REMOVED from the child env so an inherited variable
 * cannot shadow the injected one.
 */
export function anthropicCompatEnv(entry: ProviderEntry): Record<string, string | undefined> {
  const token = (entry.key_ref && readProviderSecret(entry.key_ref))
    || (entry.required_env ?? []).map(v => process.env[v]).find(Boolean)
    || undefined;
  return {
    ANTHROPIC_BASE_URL: entry.base_url,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_MODEL: undefined,
  };
}
