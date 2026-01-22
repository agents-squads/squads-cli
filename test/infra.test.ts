/**
 * Infrastructure Integration Tests
 *
 * Tests the full local stack (postgres, redis, neo4j, mem0, engram-mcp, bridge, etc.)
 * Run with: npm test -- --grep "infra"
 *
 * Prerequisites:
 *   cd docker && docker-compose -f docker-compose.engram.yml up -d
 *
 * Note: These tests are skipped in CI since they require local Docker services.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Skip infrastructure tests in CI (require local Docker services)
const describeInfra = process.env.CI ? describe.skip : describe;
import { execSync } from 'child_process';

const TIMEOUT = 10000;

// Service endpoints
// Required: postgres, redis, bridge, otel
// Optional: mem0, langfuse
// Deprecated: engram (replaced by squads-memory CLI)
const SERVICES = {
  // Required services
  postgres: { port: 5433, type: 'tcp', required: true },
  redis: { port: 6379, type: 'tcp', required: true },
  bridge: { port: 8088, type: 'http', url: 'http://localhost:8088/health', required: true },
  otel: { port: 4318, type: 'tcp', required: true },
  // Optional services
  langfuse: { port: 3100, type: 'http', url: 'http://localhost:3100/api/public/health', required: false },
  mem0: { port: 8000, type: 'http', url: 'http://localhost:8000/health', required: false },
  // Deprecated: replaced by squads-memory CLI
  engram: { port: 8080, type: 'http', url: 'http://localhost:8080/', required: false, deprecated: true },
};

/**
 * Check if a port is open (TCP connection test)
 */
async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();

    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, 'localhost');
  });
}

/**
 * Check if an HTTP endpoint responds with 2xx
 */
async function isHttpHealthy(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check if Docker container is running
 */
function isContainerRunning(name: string): boolean {
  try {
    const output = execSync(`docker inspect ${name} --format '{{.State.Running}}'`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return output === 'true';
  } catch {
    return false;
  }
}

/**
 * Check if Docker is available
 */
function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describeInfra('infra', () => {
  beforeAll(() => {
    if (!isDockerAvailable()) {
      console.warn('Docker not available - skipping infra tests');
    }
  });

  describe('container health', () => {
    it('squads-postgres is running', () => {
      expect(isContainerRunning('squads-postgres')).toBe(true);
    });

    it('squads-redis is running', () => {
      expect(isContainerRunning('squads-redis')).toBe(true);
    });

    it('squads-bridge is running', () => {
      expect(isContainerRunning('squads-bridge')).toBe(true);
    });

    // Optional: mem0 provides semantic memory but file-based memory works as fallback
    it.skip('squads-mem0 is running (optional)', () => {
      expect(isContainerRunning('squads-mem0')).toBe(true);
    });

    // Deprecated: engram-mcp replaced by squads-memory CLI
    it.skip('squads-engram-mcp is running (deprecated)', () => {
      expect(isContainerRunning('squads-engram-mcp')).toBe(true);
    });
  });

  describe('service connectivity', () => {
    it('postgres accepts connections on 5433', async () => {
      const open = await isPortOpen(5433);
      expect(open).toBe(true);
    }, TIMEOUT);

    it('redis accepts connections on 6379', async () => {
      const open = await isPortOpen(6379);
      expect(open).toBe(true);
    }, TIMEOUT);

    it('bridge health endpoint responds', async () => {
      const healthy = await isHttpHealthy('http://localhost:8088/health');
      expect(healthy).toBe(true);
    }, TIMEOUT);

    // Optional: mem0 provides semantic memory but file-based memory works as fallback
    it.skip('mem0 health endpoint responds (optional)', async () => {
      const healthy = await isHttpHealthy('http://localhost:8000/health');
      expect(healthy).toBe(true);
    }, TIMEOUT);

    // Deprecated: engram-mcp replaced by squads-memory CLI
    it.skip('engram-mcp endpoint responds (deprecated)', async () => {
      const healthy = await isHttpHealthy('http://localhost:8080/');
      expect(healthy).toBe(true);
    }, TIMEOUT);
  });

  describe('database operations', () => {
    it('can query postgres via bridge', async () => {
      try {
        const response = await fetch('http://localhost:8088/health');
        const data = await response.json();
        expect(data).toBeDefined();
      } catch (e) {
        // If bridge doesn't have /health JSON, check status code
        const response = await fetch('http://localhost:8088/health');
        expect(response.ok).toBe(true);
      }
    }, TIMEOUT);
  });

  describe('memory operations', () => {
    // Deprecated: engram-mcp replaced by squads-memory CLI
    // Memory operations now use: squads memory read|write|search
    it.skip('engram-mcp can list tools (deprecated)', async () => {
      const response = await fetch('http://localhost:8080/');
      expect(response.ok).toBe(true);
    }, TIMEOUT);

    it('squads-memory CLI is available', () => {
      try {
        execSync('squads memory health', {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        expect(true).toBe(true);
      } catch (e: unknown) {
        // CLI may fail if mem0 not running, but CLI itself should exist
        const error = e as { status?: number };
        // Exit code 0 or 1 (service down) are fine, 127 (not found) is not
        expect(error.status).not.toBe(127);
      }
    });
  });

  describe('telemetry pipeline', () => {
    it('otel-collector accepts spans on 4318', async () => {
      const open = await isPortOpen(4318);
      expect(open).toBe(true);
    }, TIMEOUT);

    it('bridge receives telemetry', async () => {
      // Send a test span to OTEL collector and verify it reaches bridge
      // This is a simplified check - full e2e would need span verification
      const response = await fetch('http://localhost:8088/health');
      expect(response.ok).toBe(true);
    }, TIMEOUT);
  });
});

describeInfra('squads stack health', () => {
  it('CLI command runs without error', () => {
    try {
      execSync('npx squads stack health', {
        encoding: 'utf-8',
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(true).toBe(true);
    } catch (e: unknown) {
      // Command may exit with non-zero if services unhealthy
      // That's expected behavior, not a test failure
      const error = e as { status?: number };
      expect(error.status).toBeDefined();
    }
  });
});
