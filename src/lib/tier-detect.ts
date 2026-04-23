/**
 * Tier detection — determines which infrastructure tier is active.
 *
 * Tier 1: File-based only (JSONL, markdown, git). Zero dependencies.
 * Tier 2: Local services (Postgres, Redis, API, Bridge via Docker).
 *
 * Cached per process. First call probes services (async), subsequent
 * calls return cached result (sync).
 */

import { getApiUrl, getBridgeUrl } from './env-config.js';

export interface TierInfo {
  tier: 1 | 2;
  services: {
    api: boolean;
    bridge: boolean;
    postgres: boolean;
    redis: boolean;
  };
  urls: {
    api: string | null;
    bridge: string | null;
  };
}

const PROBE_TIMEOUT_MS = 1500;

let cached: TierInfo | null = null;

/** Probe a URL for health (returns true if 2xx) */
async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Detect the active tier. First call probes services (async).
 * Subsequent calls return cached result.
 */
export async function detectTier(): Promise<TierInfo> {
  if (cached) return cached;

  const apiUrl = getApiUrl();
  const bridgeUrl = getBridgeUrl();

  // Probe API and Bridge in parallel
  const [apiOk, bridgeOk] = await Promise.all([
    apiUrl ? probe(apiUrl) : Promise.resolve(false),
    bridgeUrl ? probe(bridgeUrl) : Promise.resolve(false),
  ]);

  // Tier 2 requires at least the API to be healthy
  const tier = apiOk ? 2 : 1;

  cached = {
    tier,
    services: {
      api: apiOk,
      bridge: bridgeOk,
      postgres: apiOk, // If API is up, Postgres is up (API depends on it)
      redis: apiOk,    // If API is up, Redis is up (API depends on it)
    },
    urls: {
      api: apiOk ? apiUrl : null,
      bridge: bridgeOk ? bridgeUrl : null,
    },
  };

  return cached;
}

/**
 * Get cached tier info synchronously. Returns Tier 1 if not yet detected.
 * Use this in hot paths where async is not possible.
 */
export function getTierSync(): TierInfo {
  return cached || {
    tier: 1,
    services: { api: false, bridge: false, postgres: false, redis: false },
    urls: { api: null, bridge: null },
  };
}

/** Check if Tier 2 services are available */
export function isTier2(): boolean {
  return getTierSync().tier === 2;
}

/** Reset cache (for testing) */
export function resetTierCache(): void {
  cached = null;
}
