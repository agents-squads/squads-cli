/**
 * Local stack detection and configuration
 * Checks if API services are reachable
 */

import { getEnv } from './env-config.js';

interface LocalService {
  name: string;
  url: string;
  running: boolean;
}

interface LocalStackStatus {
  running: boolean;
  services: LocalService[];
}

/**
 * Check if a health endpoint responds
 */
async function checkHealth(url: string): Promise<boolean> {
  if (!url) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check status of configured services
 */
export async function getLocalStackStatus(): Promise<LocalStackStatus> {
  const env = getEnv();
  const services: LocalService[] = [];

  const checks = [
    { name: 'API', url: env.api_url ? `${env.api_url}/health` : '' },
    { name: 'Traces', url: process.env.LANGFUSE_HOST ? `${process.env.LANGFUSE_HOST}/api/public/health` : '' },
  ];

  for (const check of checks) {
    let running = false;

    if (check.url) {
      running = await checkHealth(check.url);
    }

    services.push({
      name: check.name,
      url: check.url,
      running,
    });
  }

  return {
    running: services.some((s) => s.running),
    services,
  };
}

/**
 * Check if Langfuse is available
 */
export async function isLangfuseLocal(): Promise<boolean> {
  const host = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL;
  if (host) {
    return await checkHealth(`${host}/api/public/health`);
  }
  return false;
}

/**
 * Get recommended environment variables
 */
export function getLocalEnvVars(): Record<string, string> {
  return {
    LANGFUSE_HOST: '(your Langfuse URL)',
    LANGFUSE_PUBLIC_KEY: '(your Langfuse public key)',
    LANGFUSE_SECRET_KEY: '(your Langfuse secret key)',
    SQUADS_DATABASE_URL: '(your Postgres URL)',
    REDIS_URL: '(your Redis URL)',
  };
}

/**
 * Format status for CLI output
 */
export function formatLocalStatus(status: LocalStackStatus): string {
  const lines: string[] = [];

  lines.push('Service Status:');
  lines.push('');

  for (const service of status.services) {
    const icon = service.running ? '●' : '○';
    const state = service.running ? 'running' : 'unavailable';
    lines.push(`  ${icon} ${service.name.padEnd(10)} ${state}`);
  }

  lines.push('');

  if (!status.running) {
    lines.push('Set the service URLs (SQUADS_API_URL, SQUADS_BRIDGE_URL, ...) to connect services.');
  }

  return lines.join('\n');
}
