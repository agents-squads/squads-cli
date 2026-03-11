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
    LANGFUSE_HOST: '(configure via squads login)',
    LANGFUSE_PUBLIC_KEY: '(configure via squads login)',
    LANGFUSE_SECRET_KEY: '(configure via squads login)',
    SQUADS_DATABASE_URL: '(configure via squads login)',
    REDIS_URL: '(configure via squads login)',
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
    lines.push('Run `squads login` to connect to cloud services.');
  }

  return lines.join('\n');
}
