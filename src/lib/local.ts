/**
 * Local stack detection and configuration
 * Checks if Postgres/Langfuse/Redis are running locally
 */

import { existsSync } from 'fs';
import { join } from 'path';

interface LocalService {
  name: string;
  port: number;
  healthUrl: string;
  running: boolean;
}

interface LocalStackStatus {
  running: boolean;
  services: LocalService[];
  configPath: string | null;
}

const LOCAL_SERVICES = [
  { name: 'postgres', port: 5433, healthUrl: '' },
  { name: 'langfuse', port: 3100, healthUrl: 'http://localhost:3100/api/public/health' },
  { name: 'redis', port: 6379, healthUrl: '' },
];

/**
 * Check if a port is open (service running) via TCP socket
 */
async function isPortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = new net.Socket();

    socket.setTimeout(1000);
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
 * Check status of all local services
 */
export async function getLocalStackStatus(): Promise<LocalStackStatus> {
  const services: LocalService[] = [];

  for (const service of LOCAL_SERVICES) {
    let running = false;

    if (service.healthUrl) {
      running = await checkHealth(service.healthUrl);
    } else {
      running = await isPortOpen(service.port);
    }

    services.push({
      ...service,
      running,
    });
  }

  // Find docker-compose.yml location
  const possiblePaths = [
    join(process.cwd(), 'docker', 'docker-compose.yml'),
    join(process.cwd(), 'docker-compose.yml'),
    join(__dirname, '..', '..', 'docker', 'docker-compose.yml'),
  ];

  const configPath = possiblePaths.find((p) => existsSync(p)) || null;

  return {
    running: services.some((s) => s.running),
    services,
    configPath,
  };
}

/**
 * Check if Langfuse is available locally
 */
export async function isLangfuseLocal(): Promise<boolean> {
  const host = process.env.LANGFUSE_HOST || process.env.LANGFUSE_BASE_URL;
  if (host && host.includes('localhost')) {
    return await checkHealth(`${host}/api/public/health`);
  }
  return false;
}

/**
 * Get recommended environment variables for local stack
 */
export function getLocalEnvVars(): Record<string, string> {
  return {
    LANGFUSE_HOST: 'http://localhost:3100',
    LANGFUSE_PUBLIC_KEY: '(create in Langfuse UI)',
    LANGFUSE_SECRET_KEY: '(create in Langfuse UI)',
    SQUADS_DATABASE_URL: 'postgresql://squads:squads_local_dev@localhost:5433/squads',
    REDIS_URL: 'redis://localhost:6379',
  };
}

/**
 * Format status for CLI output
 */
export function formatLocalStatus(status: LocalStackStatus): string {
  const lines: string[] = [];

  lines.push('Local Stack Status:');
  lines.push('');

  for (const service of status.services) {
    const icon = service.running ? '●' : '○';
    const state = service.running ? 'running' : 'stopped';
    lines.push(`  ${icon} ${service.name.padEnd(10)} :${service.port}  ${state}`);
  }

  lines.push('');

  if (!status.running) {
    lines.push('Start with: cd docker && docker-compose up -d');
  } else if (!status.services.find((s) => s.name === 'langfuse')?.running) {
    lines.push('Langfuse not running. Start with: docker-compose up -d langfuse');
  }

  return lines.join('\n');
}
