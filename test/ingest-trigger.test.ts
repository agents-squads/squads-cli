/**
 * Tests for the post-run ingest trigger ping in observability.ts.
 *
 * Verifies that:
 * 1. pingIngestTrigger fires AFTER the JSONL record is appended (via logObservability)
 * 2. The correct URL, headers, and body are sent
 * 3. Missing SQUADS_API_URL → no fetch call (silent)
 * 4. Missing SCHEDULER_API_KEY → no fetch call (silent)
 * 5. fetch failure → caught, no throw (run path unaffected)
 * 6. JSONL is always written even when fetch fails
 *
 * logObservability is tested indirectly: we call it and assert fetch was
 * called (or not), which proves the ping fires after append.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Fixtures ─────────────────────────────────────────────────────────

const TEST_ROOT = join(tmpdir(), `squads-obs-test-${Date.now()}`);
const OBS_DIR = join(TEST_ROOT, '.agents', 'observability');
const JSONL_PATH = join(OBS_DIR, 'executions.jsonl');

const API_URL = 'http://localhost:8090';
const API_KEY = 'test-scheduler-key';

// Mock squad-parser so findProjectRoot returns our temp dir
vi.mock('../src/lib/squad-parser.js', () => ({
  findProjectRoot: vi.fn(() => TEST_ROOT),
  loadSquad: vi.fn(),
  listSquads: vi.fn(() => []),
}));

// Mock tier-detect so pushToApi (Tier 2 path) doesn't fire
vi.mock('../src/lib/tier-detect.js', () => ({
  isTier2: vi.fn(() => false),
  getTierSync: vi.fn(() => ({ tier: 1, urls: { api: '' } })),
}));

// Mock env-config so pushToBridge (Bridge path) is skipped
vi.mock('../src/lib/env-config.js', () => ({
  getApiUrl: vi.fn(() => ''),
  getBridgeUrl: vi.fn(() => ''),
  getEnv: vi.fn(() => ({ api_url: '', bridge_url: '' })),
}));

import { logObservability, type ObservabilityRecord } from '../src/lib/observability.js';

function makeRecord(overrides: Partial<ObservabilityRecord> = {}): ObservabilityRecord {
  return {
    ts: new Date().toISOString(),
    id: 'exec-test-001',
    squad: 'cli',
    agent: 'test-agent',
    provider: 'anthropic',
    model: 'claude-haiku',
    trigger: 'manual',
    status: 'completed',
    duration_ms: 1000,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0.001,
    ...overrides,
  };
}

// ── Setup / teardown ─────────────────────────────────────────────────

const originalEnv = { ...process.env };

beforeEach(() => {
  mkdirSync(OBS_DIR, { recursive: true });
  process.env.SQUADS_API_URL = API_URL;
  process.env.SCHEDULER_API_KEY = API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  // Restore env
  for (const key of ['SQUADS_API_URL', 'SCHEDULER_API_KEY']) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true, force: true });
});

// ── Tests ────────────────────────────────────────────────────────────

describe('ingest trigger ping (via logObservability)', () => {
  it('fires fetch AFTER the JSONL record is appended', async () => {
    let jsonlWrittenAtFetchTime = false;

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/ingest/trigger')) {
        // By the time fetch is called, the JSONL must already be written
        jsonlWrittenAtFetchTime = existsSync(JSONL_PATH);
      }
      return { ok: true, status: 202 };
    });
    vi.stubGlobal('fetch', mockFetch);

    logObservability(makeRecord());

    // Allow microtasks / the fire-and-forget promises to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    // JSONL was present when fetch fired
    expect(jsonlWrittenAtFetchTime).toBe(true);

    // fetch was called with the correct ingest trigger URL + headers + body
    const ingestCall = mockFetch.mock.calls.find(
      ([url]: [string]) => typeof url === 'string' && url.includes('/ingest/trigger'),
    );
    expect(ingestCall).toBeDefined();
    const [url, opts] = ingestCall as [string, RequestInit];
    expect(url).toBe(`${API_URL}/ingest/trigger`);
    expect((opts.headers as Record<string, string>)['X-API-Key']).toBe(API_KEY);
    expect((opts.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body as string)).toMatchObject({ source: 'squads-cli' });
    expect(opts.method).toBe('POST');
  });

  it('does NOT call fetch when SQUADS_API_URL is unset', async () => {
    delete process.env.SQUADS_API_URL;

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    logObservability(makeRecord());
    await new Promise(resolve => setTimeout(resolve, 50));

    const ingestCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('/ingest/trigger'),
    );
    expect(ingestCalls).toHaveLength(0);
  });

  it('does NOT call fetch when SCHEDULER_API_KEY is unset', async () => {
    delete process.env.SCHEDULER_API_KEY;

    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    logObservability(makeRecord());
    await new Promise(resolve => setTimeout(resolve, 50));

    const ingestCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('/ingest/trigger'),
    );
    expect(ingestCalls).toHaveLength(0);
  });

  it('swallows fetch errors — run path is unaffected', async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/ingest/trigger')) throw new Error('ECONNREFUSED');
      return { ok: true };
    });
    vi.stubGlobal('fetch', mockFetch);

    // Must NOT throw
    expect(() => logObservability(makeRecord())).not.toThrow();

    // Also wait for the async promise to settle — still no unhandled rejection
    await expect(
      new Promise(resolve => setTimeout(resolve, 50)),
    ).resolves.toBeUndefined();
  });

  it('JSONL record is always written even when fetch fails', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', mockFetch);

    logObservability(makeRecord({ id: 'exec-always-written' }));
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(existsSync(JSONL_PATH)).toBe(true);
    const content = readFileSync(JSONL_PATH, 'utf-8');
    expect(content).toContain('exec-always-written');
  });
});
