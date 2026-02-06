/**
 * Service availability checking utilities
 * Extracted from stack.ts for use across commands
 */

import { execSync } from 'child_process';
import {
  colors,
  bold,
  RESET,
  icons,
  writeLine,
} from './terminal.js';

interface ContainerStatus {
  name: string;
  running: boolean;
  healthy: boolean;
  port?: string;
}

interface ServiceInfo {
  name: string;
  description: string;
  required: boolean;
  healthUrl?: string;
  envVars: string[];
  setupGuide: string[];
}

const SERVICES: Record<string, ServiceInfo> = {
  bridge: {
    name: 'Bridge API',
    description: 'Captures conversations and telemetry',
    required: true,
    healthUrl: 'http://localhost:8088/health',
    envVars: ['SQUADS_BRIDGE_URL'],
    setupGuide: [
      'Run: squads stack up',
      'Or manually: docker compose up -d bridge',
    ],
  },
  postgres: {
    name: 'PostgreSQL',
    description: 'Stores conversations and telemetry data',
    required: true,
    envVars: ['SQUADS_DATABASE_URL'],
    setupGuide: [
      'Run: squads stack up',
      'Or manually: docker compose up -d postgres',
    ],
  },
  mem0: {
    name: 'Mem0',
    description: 'Memory extraction and search',
    required: false,
    healthUrl: 'http://localhost:8000/health',
    envVars: ['MEM0_API_URL'],
    setupGuide: [
      'Run: squads stack up',
      'Or manually: docker compose -f docker-compose.engram.yml up -d mem0',
      '',
      'Mem0 requires an LLM provider. Configure in docker/.env:',
      '  LLM_PROVIDER=ollama   # For local (free)',
      '  LLM_PROVIDER=openai   # Requires OPENAI_API_KEY',
    ],
  },
  scheduler: {
    name: 'Scheduler API',
    description: 'Trigger evaluation and agent execution',
    required: false,
    healthUrl: 'http://localhost:8090/health',
    envVars: [],
    setupGuide: [
      'Run: docker compose -f docker-compose.engram.yml up -d scheduler-api scheduler-worker',
      '',
      'Scheduler runs agents on triggers defined in SQUAD.md',
    ],
  },
  langfuse: {
    name: 'Langfuse',
    description: 'Telemetry dashboard and cost tracking',
    required: false,
    healthUrl: 'http://localhost:3100/api/public/health',
    envVars: ['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'],
    setupGuide: [
      'Run: squads stack up',
      'Then get API keys from: http://localhost:3100',
      '  1. Create account / login',
      '  2. Create project',
      '  3. Copy API keys to docker/.env',
    ],
  },
  redis: {
    name: 'Redis',
    description: 'Caching and rate limiting',
    required: false,
    envVars: ['REDIS_URL'],
    setupGuide: [
      'Run: squads stack up',
    ],
  },
};

function getContainerStatus(name: string): ContainerStatus {
  try {
    const runningOutput = execSync(
      `docker inspect ${name} --format '{{.State.Running}}'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    ).trim();

    const running = runningOutput === 'true';

    if (!running) {
      return { name, running: false, healthy: false };
    }

    let port: string | undefined;
    try {
      const portOutput = execSync(
        `docker inspect ${name} --format '{{range .NetworkSettings.Ports}}{{range .}}{{.HostPort}}{{end}}{{end}}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();
      port = portOutput || undefined;
    } catch {
      // Ignore port errors
    }

    let healthy = true;
    try {
      const healthOutput = execSync(
        `docker inspect ${name} --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();

      if (healthOutput === 'healthy' || healthOutput === 'none') {
        healthy = true;
      } else if (healthOutput === 'starting') {
        healthy = false;
      } else {
        healthy = false;
      }
    } catch {
      healthy = true;
    }

    return { name, running, healthy, port };
  } catch {
    return { name, running: false, healthy: false };
  }
}

async function checkService(url: string, timeout = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Check if a service is available and show guidance if not
 */
export async function checkServiceAvailable(
  serviceName: keyof typeof SERVICES,
  showGuidance = true
): Promise<boolean> {
  const service = SERVICES[serviceName];
  if (!service) return false;

  const containerName = `squads-${serviceName === 'mem0' ? 'mem0' : serviceName}`;
  const status = getContainerStatus(containerName);

  if (!status.running) {
    if (showGuidance) {
      showServiceSetupGuide(serviceName, 'not running');
    }
    return false;
  }

  if (service.healthUrl) {
    const healthy = await checkService(service.healthUrl);
    if (!healthy) {
      if (showGuidance) {
        showServiceSetupGuide(serviceName, 'not responding');
      }
      return false;
    }
  }

  return true;
}

/**
 * Show setup guide for a service
 */
export function showServiceSetupGuide(
  serviceName: keyof typeof SERVICES,
  issue: string
): void {
  const service = SERVICES[serviceName];
  if (!service) return;

  writeLine();
  writeLine(`  ${colors.yellow}${icons.warning}${RESET} ${bold}${service.name}${RESET} is ${issue}`);
  writeLine(`  ${colors.dim}${service.description}${RESET}`);
  writeLine();

  writeLine(`  ${bold}To fix:${RESET}`);
  for (const step of service.setupGuide) {
    if (step === '') {
      writeLine();
    } else {
      writeLine(`  ${colors.dim}${step}${RESET}`);
    }
  }

  if (service.envVars.length > 0) {
    writeLine();
    writeLine(`  ${bold}Environment variables:${RESET}`);
    for (const envVar of service.envVars) {
      const value = process.env[envVar];
      const status = value ? `${colors.green}✓${RESET}` : `${colors.red}✗${RESET}`;
      writeLine(`  ${status} ${colors.cyan}${envVar}${RESET}${value ? ` = ${colors.dim}${value}${RESET}` : ''}`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}Full setup: squads health${RESET}`);
  writeLine();
}
