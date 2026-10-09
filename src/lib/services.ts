/**
 * Service availability checking utilities
 * Checks API reachability for optional cloud features
 */

import {
  colors,
  bold,
  RESET,
  icons,
  writeLine,
} from './terminal.js';
import { getEnv } from './env-config.js';

interface ServiceInfo {
  name: string;
  description: string;
  required: boolean;
  getHealthUrl: () => string;
  envVars: string[];
  setupGuide: string[];
}

function buildServices(): Record<string, ServiceInfo> {
  const env = getEnv();

  return {
    bridge: {
      name: 'API',
      description: 'Optional: captures conversations and telemetry',
      required: false,
      getHealthUrl: () => env.bridge_url ? `${env.bridge_url}/health` : '',
      envVars: ['SQUADS_BRIDGE_URL'],
      setupGuide: [
        'Not required for basic usage (init, run, status, eval).',
        'To enable telemetry, set SQUADS_BRIDGE_URL to your bridge.',
      ],
    },
    postgres: {
      name: 'Database',
      description: 'Optional: enables scheduling, telemetry, and persistent storage',
      required: false,
      getHealthUrl: () => '',
      envVars: ['SQUADS_DATABASE_URL'],
      setupGuide: [
        'Not required for basic usage (init, run, status, eval).',
        'To enable it, set SQUADS_DATABASE_URL.',
      ],
    },
    mem0: {
      name: 'Memory Service',
      description: 'Memory extraction and search',
      required: false,
      getHealthUrl: () => {
        const url = process.env.MEM0_API_URL;
        return url ? `${url}/health` : '';
      },
      envVars: ['MEM0_API_URL'],
      setupGuide: [
        'Memory extraction requires the memory service.',
        'To enable it, set MEM0_API_URL.',
      ],
    },
    scheduler: {
      name: 'Scheduler',
      description: 'Trigger evaluation and agent execution',
      required: false,
      getHealthUrl: () => env.api_url ? `${env.api_url}/health` : '',
      envVars: ['SQUADS_API_URL'],
      setupGuide: [
        'Scheduling requires the API.',
        'To enable it, set SQUADS_API_URL.',
      ],
    },
    langfuse: {
      name: 'Traces',
      description: 'Telemetry dashboard and cost tracking',
      required: false,
      getHealthUrl: () => {
        const host = process.env.LANGFUSE_HOST;
        return host ? `${host}/api/public/health` : '';
      },
      envVars: ['LANGFUSE_HOST', 'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY'],
      setupGuide: [
        'To enable traces, set LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.',
      ],
    },
    redis: {
      name: 'Cache',
      description: 'Caching and rate limiting',
      required: false,
      getHealthUrl: () => '',
      envVars: ['REDIS_URL'],
      setupGuide: [
        'To enable caching, set REDIS_URL.',
      ],
    },
  };
}

async function checkService(url: string, timeout = 2000): Promise<boolean> {
  if (!url) return false;

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
  serviceName: string,
  showGuidance = true
): Promise<boolean> {
  const services = buildServices();
  const service = services[serviceName];
  if (!service) return false;

  const healthUrl = service.getHealthUrl();
  if (!healthUrl) {
    if (showGuidance) {
      showServiceSetupGuide(serviceName, 'not configured');
    }
    return false;
  }

  const healthy = await checkService(healthUrl);
  if (!healthy) {
    if (showGuidance) {
      showServiceSetupGuide(serviceName, 'not responding');
    }
    return false;
  }

  return true;
}

/**
 * Show setup guide for a service
 */
export function showServiceSetupGuide(
  serviceName: string,
  issue: string
): void {
  const services = buildServices();
  const service = services[serviceName];
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
      // Never echo the value — these include secrets (API keys, database URLs with passwords).
      writeLine(`  ${status} ${colors.cyan}${envVar}${RESET} ${colors.dim}${value ? 'set' : 'not set'}${RESET}`);
    }
  }

  writeLine();
  writeLine(`  ${colors.dim}Full setup: squads health${RESET}`);
  writeLine();
}
