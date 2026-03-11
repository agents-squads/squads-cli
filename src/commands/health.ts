/**
 * squads health - Quick infrastructure health check
 *
 * Lightweight check that pings configured service endpoints
 */

import {
  colors,
  RESET,
  gradient,
  icons,
  writeLine,
  padEnd,
} from '../lib/terminal.js';
import { getEnv } from '../lib/env-config.js';

const FETCH_TIMEOUT_MS = 2000;

interface ServiceCheck {
  name: string;
  url: string;
  optional?: boolean;
  fix?: string;
}

interface ServiceResult {
  name: string;
  status: 'healthy' | 'down' | 'degraded';
  latencyMs?: number;
  error?: string;
  optional?: boolean;
  fix?: string;
}

interface TriggerStats {
  active: number;
  disabled: number;
  lastFire?: {
    name: string;
    ago: string;
  };
}

function getServiceChecks(): ServiceCheck[] {
  const env = getEnv();

  const checks: ServiceCheck[] = [];

  if (env.api_url) {
    checks.push({
      name: 'API',
      url: `${env.api_url}/health`,
      optional: true,
      fix: 'squads login',
    });
  }

  if (env.bridge_url) {
    checks.push({
      name: 'Bridge',
      url: `${env.bridge_url}/health`,
      optional: true,
      fix: 'squads login',
    });
  }

  if (process.env.LANGFUSE_HOST) {
    checks.push({
      name: 'Traces',
      url: `${process.env.LANGFUSE_HOST}/api/public/health`,
      optional: true,
      fix: 'squads login',
    });
  }

  return checks;
}

/**
 * Fetch with timeout
 */
async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch {
    clearTimeout(timeoutId);
    throw new Error('timeout');
  }
}

/**
 * Check a single service
 */
async function checkService(service: ServiceCheck): Promise<ServiceResult> {
  const start = Date.now();

  try {
    const response = await fetchWithTimeout(service.url);
    const latencyMs = Date.now() - start;

    if (response.ok) {
      return {
        name: service.name,
        status: 'healthy',
        latencyMs,
        optional: service.optional,
      };
    }

    return {
      name: service.name,
      status: 'degraded',
      latencyMs,
      error: `HTTP ${response.status}`,
      optional: service.optional,
      fix: service.fix,
    };
  } catch (error) {
    return {
      name: service.name,
      status: 'down',
      error: error instanceof Error ? error.message : 'unknown',
      optional: service.optional,
      fix: service.fix,
    };
  }
}

/**
 * Get trigger stats from API
 */
async function getTriggerStats(): Promise<TriggerStats | null> {
  try {
    const env = getEnv();
    const apiUrl = env.api_url;
    if (!apiUrl) return null;

    const response = await fetchWithTimeout(`${apiUrl}/api/triggers/stats`);

    if (!response.ok) return null;

    interface StatsResponse {
      active?: number;
      disabled?: number;
      last_fire?: {
        name?: string;
        fired_at?: string;
      };
    }

    const data = await response.json() as StatsResponse;
    return {
      active: data.active || 0,
      disabled: data.disabled || 0,
      lastFire: data.last_fire ? {
        name: data.last_fire.name || 'unknown',
        ago: formatTimeAgo(new Date(data.last_fire.fired_at || Date.now())),
      } : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Format time ago
 */
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/**
 * Format latency
 */
function formatLatency(ms?: number): string {
  if (!ms) return '—';
  return `${ms}ms`;
}

export interface HealthOptions {
  verbose?: boolean;
}

export async function healthCommand(_options: HealthOptions = {}): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}health${RESET}`);
  writeLine();

  const SERVICES = getServiceChecks();

  if (SERVICES.length === 0) {
    writeLine(`  ${colors.yellow}${icons.warning} No services configured${RESET}`);
    writeLine(`  ${colors.dim}Run ${RESET}${colors.cyan}squads login${RESET}${colors.dim} to connect to cloud services${RESET}`);
    writeLine();
    writeLine(`  ${colors.cyan}${icons.progress}${RESET} Running in local mode ${colors.dim}(no cloud services required)${RESET}`);
    writeLine(`    Core commands work without cloud services: ${colors.cyan}init${RESET}, ${colors.cyan}run${RESET}, ${colors.cyan}status${RESET}, ${colors.cyan}eval${RESET}`);
    writeLine(`    Memory uses local ${colors.dim}.agents/memory/${RESET} files.`);
    writeLine();
    return;
  }

  // Check all services in parallel
  const results = await Promise.all(SERVICES.map(checkService));

  // Display table
  writeLine(`  ${colors.purple}┌${'─'.repeat(48)}┐${RESET}`);
  writeLine(`  ${colors.purple}│${RESET} ${padEnd('SERVICE', 18)}${padEnd('STATUS', 14)}${padEnd('LATENCY', 12)}${colors.purple}│${RESET}`);
  writeLine(`  ${colors.purple}├${'─'.repeat(48)}┤${RESET}`);

  const issues: ServiceResult[] = [];
  const optionalDown: ServiceResult[] = [];

  for (const result of results) {
    let statusIcon: string;
    let statusColor: string;
    let statusText: string;

    switch (result.status) {
      case 'healthy':
        statusIcon = icons.success;
        statusColor = colors.green;
        statusText = 'healthy';
        break;
      case 'degraded':
        statusIcon = icons.warning;
        statusColor = colors.yellow;
        statusText = 'degraded';
        issues.push(result);
        break;
      case 'down':
        statusIcon = icons.error;
        statusColor = colors.red;
        statusText = 'down';
        if (!result.optional) {
          issues.push(result);
        } else {
          optionalDown.push(result);
        }
        break;
    }

    const nameDisplay = result.optional ? `${result.name} ${colors.dim}(opt)${RESET}` : result.name;
    const latency = formatLatency(result.latencyMs);

    writeLine(`  ${colors.purple}│${RESET} ${padEnd(nameDisplay, 18)}${statusColor}${statusIcon} ${padEnd(statusText, 11)}${RESET}${padEnd(latency, 12)}${colors.purple}│${RESET}`);
  }

  writeLine(`  ${colors.purple}└${'─'.repeat(48)}┘${RESET}`);
  writeLine();

  // Get trigger stats if API is up
  const apiUp = results.find(r => r.name === 'API')?.status === 'healthy';
  if (apiUp) {
    const stats = await getTriggerStats();
    if (stats) {
      const lastFireText = stats.lastFire
        ? `${colors.dim}Last fire:${RESET} ${stats.lastFire.ago} (${stats.lastFire.name})`
        : `${colors.dim}No recent fires${RESET}`;

      writeLine(`  ${colors.cyan}Triggers:${RESET} ${stats.active} active, ${stats.disabled} disabled`);
      writeLine(`  ${lastFireText}`);
      writeLine();
    }
  }

  // Show issues and fixes
  if (issues.length > 0) {
    writeLine(`  ${colors.red}${icons.warning} ${issues.length} service(s) need attention${RESET}`);
    for (const issue of issues) {
      writeLine(`    ${colors.dim}•${RESET} ${issue.name}: ${issue.error || 'not responding'}`);
      if (issue.fix) {
        writeLine(`      ${colors.cyan}Fix:${RESET} ${issue.fix}`);
      }
    }
    writeLine();
  } else if (optionalDown.length > 0) {
    writeLine(`  ${colors.green}${icons.success} Core ready${RESET} ${colors.dim}(no required services are down)${RESET}`);
    writeLine(`  ${colors.dim}○ ${optionalDown.length} optional service(s) offline — run ${RESET}${colors.cyan}squads login${RESET}${colors.dim} to connect${RESET}`);
    writeLine();
  } else {
    writeLine(`  ${colors.green}${icons.success} All services healthy${RESET}`);
    writeLine();
  }

  // Show mode info
  const allDown = results.every(r => r.status === 'down');
  if (allDown) {
    writeLine(`  ${colors.cyan}${icons.progress}${RESET} Running in local mode ${colors.dim}(no cloud services required)${RESET}`);
    writeLine(`    Core commands work without cloud services: ${colors.cyan}init${RESET}, ${colors.cyan}run${RESET}, ${colors.cyan}status${RESET}, ${colors.cyan}eval${RESET}`);
    writeLine(`    Memory uses local ${colors.dim}.agents/memory/${RESET} files.`);
    writeLine();
    writeLine(`    ${colors.dim}To enable scheduling and telemetry:${RESET} squads login`);
    writeLine();
  } else if (!apiUp) {
    writeLine(`  ${colors.yellow}${icons.warning} API not reachable - triggers won't auto-fire${RESET}`);
    writeLine(`    ${colors.dim}Check connection:${RESET} squads login`);
    writeLine();
  }
}
