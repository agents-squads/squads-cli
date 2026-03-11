import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  getLocalStackStatus,
  isLangfuseLocal,
  getLocalEnvVars,
  formatLocalStatus,
} from '../src/lib/local.js';

describe('local', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe('getLocalEnvVars', () => {
    it('returns expected environment variables', () => {
      const vars = getLocalEnvVars();

      expect(vars).toHaveProperty('LANGFUSE_HOST');
      expect(vars).toHaveProperty('LANGFUSE_PUBLIC_KEY');
      expect(vars).toHaveProperty('LANGFUSE_SECRET_KEY');
      expect(vars).toHaveProperty('SQUADS_DATABASE_URL');
      expect(vars).toHaveProperty('REDIS_URL');
    });

    it('returns squads login guidance instead of hardcoded URLs', () => {
      const vars = getLocalEnvVars();

      expect(vars.LANGFUSE_HOST).toContain('squads login');
      expect(vars.SQUADS_DATABASE_URL).toContain('squads login');
      expect(vars.REDIS_URL).toContain('squads login');
    });
  });

  describe('formatLocalStatus', () => {
    it('formats running services correctly', () => {
      const status = {
        running: true,
        services: [
          { name: 'API', url: 'http://localhost:8088/health', running: true },
          { name: 'Traces', url: 'http://localhost:3100/api/public/health', running: true },
        ],
      };

      const output = formatLocalStatus(status);
      expect(output).toContain('Service Status');
      expect(output).toContain('●');
      expect(output).toContain('API');
      expect(output).toContain('running');
    });

    it('formats unavailable services correctly', () => {
      const status = {
        running: false,
        services: [
          { name: 'API', url: '', running: false },
          { name: 'Traces', url: '', running: false },
        ],
      };

      const output = formatLocalStatus(status);
      expect(output).toContain('○');
      expect(output).toContain('unavailable');
      expect(output).toContain('squads login');
    });
  });

  describe('isLangfuseLocal', () => {
    it('returns false when no LANGFUSE env vars set', async () => {
      delete process.env.LANGFUSE_HOST;
      delete process.env.LANGFUSE_BASE_URL;

      const result = await isLangfuseLocal();
      expect(result).toBe(false);
    });

    it('checks health when LANGFUSE_HOST is set', async () => {
      process.env.LANGFUSE_HOST = 'http://localhost:3100';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Connection refused'));

      const result = await isLangfuseLocal();
      expect(result).toBe(false);

      globalThis.fetch = originalFetch;
    });

    it('returns true when LANGFUSE_HOST health check passes', async () => {
      process.env.LANGFUSE_HOST = 'http://localhost:3100';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true } as Response);

      const result = await isLangfuseLocal();
      expect(result).toBe(true);

      globalThis.fetch = originalFetch;
    });

    it('uses LANGFUSE_BASE_URL as fallback', async () => {
      delete process.env.LANGFUSE_HOST;
      process.env.LANGFUSE_BASE_URL = 'http://localhost:3100';

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true } as Response);

      const result = await isLangfuseLocal();
      expect(result).toBe(true);

      globalThis.fetch = originalFetch;
    });
  });

  describe('getLocalStackStatus', () => {
    it('returns status with services array', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const status = await getLocalStackStatus();

      expect(status).toHaveProperty('running');
      expect(status).toHaveProperty('services');
      expect(status.services.length).toBeGreaterThan(0);

      globalThis.fetch = originalFetch;
    });

    it('each service has name, url, and running properties', async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      const status = await getLocalStackStatus();
      for (const service of status.services) {
        expect(service).toHaveProperty('name');
        expect(service).toHaveProperty('url');
        expect(service).toHaveProperty('running');
      }

      globalThis.fetch = originalFetch;
    });
  });
});
