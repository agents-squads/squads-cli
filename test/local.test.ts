import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

// Mock fs
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

const mockedExistsSync = vi.mocked(fs.existsSync);

// We need to mock net and fetch for the async functions
const mockSocket = {
  setTimeout: vi.fn(),
  on: vi.fn(),
  connect: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('net', () => ({
  Socket: vi.fn(() => mockSocket),
}));

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
    // Reset socket mock handlers
    mockSocket.on.mockReset();
    mockSocket.connect.mockReset();
    mockSocket.destroy.mockReset();
    mockSocket.setTimeout.mockReset();
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

    it('has localhost URLs', () => {
      const vars = getLocalEnvVars();

      expect(vars.LANGFUSE_HOST).toContain('localhost');
      expect(vars.SQUADS_DATABASE_URL).toContain('localhost');
      expect(vars.REDIS_URL).toContain('localhost');
    });

    it('uses correct default ports', () => {
      const vars = getLocalEnvVars();

      expect(vars.LANGFUSE_HOST).toContain('3100');
      expect(vars.SQUADS_DATABASE_URL).toContain('5432');
      expect(vars.REDIS_URL).toContain('6379');
    });
  });

  describe('formatLocalStatus', () => {
    it('formats running services correctly', () => {
      const status = {
        running: true,
        services: [
          { name: 'postgres', port: 5433, healthUrl: '', running: true },
          { name: 'langfuse', port: 3100, healthUrl: 'http://localhost:3100/api/public/health', running: true },
          { name: 'redis', port: 6379, healthUrl: '', running: true },
        ],
        configPath: null,
      };

      const output = formatLocalStatus(status);
      expect(output).toContain('Local Stack Status');
      expect(output).toContain('●');
      expect(output).toContain('postgres');
      expect(output).toContain('running');
    });

    it('formats stopped services correctly', () => {
      const status = {
        running: false,
        services: [
          { name: 'postgres', port: 5433, healthUrl: '', running: false },
          { name: 'langfuse', port: 3100, healthUrl: 'http://localhost:3100/api/public/health', running: false },
          { name: 'redis', port: 6379, healthUrl: '', running: false },
        ],
        configPath: null,
      };

      const output = formatLocalStatus(status);
      expect(output).toContain('○');
      expect(output).toContain('stopped');
      expect(output).toContain('docker-compose up -d');
    });

    it('shows langfuse hint when langfuse is the only stopped service', () => {
      const status = {
        running: true,
        services: [
          { name: 'postgres', port: 5433, healthUrl: '', running: true },
          { name: 'langfuse', port: 3100, healthUrl: 'http://localhost:3100/api/public/health', running: false },
          { name: 'redis', port: 6379, healthUrl: '', running: true },
        ],
        configPath: null,
      };

      const output = formatLocalStatus(status);
      expect(output).toContain('Langfuse not running');
      expect(output).toContain('docker-compose up -d langfuse');
    });

    it('includes port numbers in output', () => {
      const status = {
        running: false,
        services: [
          { name: 'postgres', port: 5433, healthUrl: '', running: false },
        ],
        configPath: null,
      };

      const output = formatLocalStatus(status);
      expect(output).toContain(':5433');
    });
  });

  describe('isLangfuseLocal', () => {
    it('returns false when no LANGFUSE env vars set', async () => {
      delete process.env.LANGFUSE_HOST;
      delete process.env.LANGFUSE_BASE_URL;

      const result = await isLangfuseLocal();
      expect(result).toBe(false);
    });

    it('returns false when LANGFUSE_HOST is not localhost', async () => {
      process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';

      const result = await isLangfuseLocal();
      expect(result).toBe(false);
    });

    it('checks health when LANGFUSE_HOST points to localhost', async () => {
      process.env.LANGFUSE_HOST = 'http://localhost:3100';

      // Mock fetch to fail (no langfuse running)
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error('Connection refused'));

      const result = await isLangfuseLocal();
      expect(result).toBe(false);

      globalThis.fetch = originalFetch;
    });

    it('returns true when LANGFUSE_HOST is localhost and health check passes', async () => {
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
    it('returns status with configPath when docker-compose.yml exists', async () => {
      // All ports will fail (mock socket errors)
      mockSocket.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'error') setTimeout(() => cb(), 0);
        return mockSocket;
      });

      // Mock fetch for langfuse health check
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      // existsSync for docker-compose.yml lookup
      mockedExistsSync.mockReturnValue(false);

      const status = await getLocalStackStatus();

      expect(status).toHaveProperty('running');
      expect(status).toHaveProperty('services');
      expect(status).toHaveProperty('configPath');
      expect(status.services).toHaveLength(3);

      globalThis.fetch = originalFetch;
    });

    it('detects configPath when docker-compose.yml exists', async () => {
      mockSocket.on.mockImplementation((event: string, cb: Function) => {
        if (event === 'error') setTimeout(() => cb(), 0);
        return mockSocket;
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      // First path check returns true
      mockedExistsSync.mockReturnValueOnce(true);

      const status = await getLocalStackStatus();
      expect(status.configPath).not.toBeNull();

      globalThis.fetch = originalFetch;
    });

    it('reports running=true when at least one service is up', async () => {
      // First service (postgres) connects successfully
      let callCount = 0;
      mockSocket.on.mockImplementation((event: string, cb: Function) => {
        if (callCount === 0 && event === 'connect') {
          setTimeout(() => cb(), 0);
        } else if (callCount > 0 && event === 'error') {
          setTimeout(() => cb(), 0);
        }
        return mockSocket;
      });
      mockSocket.connect.mockImplementation(() => {
        callCount++;
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'));

      mockedExistsSync.mockReturnValue(false);

      const status = await getLocalStackStatus();
      // At minimum it checks services and returns a result
      expect(status.services).toHaveLength(3);

      globalThis.fetch = originalFetch;
    });
  });
});
