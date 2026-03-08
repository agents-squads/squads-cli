/**
 * squads health - Quick infrastructure health check
 *
 * Lightweight check that doesn't require Docker - just pings endpoints
 */

import {
  colors,
  RESET,
  gradient,
  icons,
  writeLine,
  padEnd,
} from '../lib/terminal.js';

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

const SERVICES: ServiceCheck[] = [
  {
    name: 'PostgreSQL',
    url: `${process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088'}/stats`,
    optional: true,
    fix: 'squads stack up postgres',
  },
  {
    name: 'Redis',
    url: `${process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088'}/stats`,
    optional: true,
    fix: 'squads stack up redis',
  },
  {
    name: 'Bridge API',
    url: `${process.env.SQUADS_BRIDGE_URL || 'http://localhost:8088'}/health`,
    optional: true,
    fix: 'squads stack up bridge',
  },
  {
    name: 'Scheduler',
    url: `${process.env.SQUADS_API_URL || process.env.SQUADS_SCHEDULER_URL || 'http://localhost:8090'}/health`,
    optional: true,
    fix: 'squads stack up scheduler',
  },
  {
    name: 'Langfuse',
    url: `${process.env.LANGFUSE_HOST || 'http://localhost:3100'}/api/public/health`,
    optional: true,
    fix: 'squads stack up langfuse',
  },
];

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
 * Get trigger stats from scheduler
 */
async function getTriggerStats(): Promise<TriggerStats | null> {
  try {
    const schedulerUrl = process.env.SQUADS_API_URL || process.env.SQUADS_SCHEDULER_URL || 'http://localhost:8090';
    const response = await fetchWithTimeout(`${schedulerUrl}/api/triggers/stats`);

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

export async function healthCommand(options: HealthOptions = {}): Promise<void> {
  writeLine();
  writeLine(`  ${gradient('squads')} ${colors.dim}health${RESET}`);
  writeLine();

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

  // Get trigger stats if scheduler is up
  const schedulerUp = results.find(r => r.name === 'Scheduler')?.status === 'healthy';
  if (schedulerUp) {
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
    const criticalIssues = issues.filter(i => !i.optional);
    const optionalIssues = issues.filter(i => i.optional);

    if (criticalIssues.length > 0) {
      writeLine(`  ${colors.red}${icons.warning} ${criticalIssues.length} service(s) need attention${RESET}`);
      for (const issue of criticalIssues) {
        writeLine(`    ${colors.dim}•${RESET} ${issue.name}: ${issue.error || 'not responding'}`);
        if (issue.fix) {
          writeLine(`      ${colors.cyan}Fix:${RESET} ${issue.fix}`);
        }
      }
      writeLine();
    }

    if (options.verbose && optionalIssues.length > 0) {
      writeLine(`  ${colors.yellow}Optional services down:${RESET}`);
      for (const issue of optionalIssues) {
        writeLine(`    ${colors.dim}•${RESET} ${issue.name}`);
      }
      writeLine();
    }
  }

  // Summary: differentiate "truly all healthy" from "core ready, optional offline"
  if (issues.length === 0) {
    if (optionalDown.length > 0) {
      writeLine(`  ${colors.green}${icons.success} Core ready ${colors.dim}(no required services are down)${RESET}`);
      writeLine(`  ${colors.yellow}○ ${optionalDown.length} optional service${optionalDown.length === 1 ? '' : 's'} offline${RESET} ${colors.dim}— run ${RESET}${colors.cyan}squads stack up${RESET}${colors.dim} to enable scheduling/telemetry${RESET}`);
    } else {
      writeLine(`  ${colors.green}${icons.success} All services healthy${RESET}`);
    }
    writeLine();
  }

  // Show mode info
  const allDown = results.every(r => r.status === 'down');
  if (allDown) {
    writeLine(`  ${colors.cyan}${icons.progress}${RESET} Running in local mode ${colors.dim}(no database required)${RESET}`);
    writeLine(`    Core commands work without infrastructure: ${colors.cyan}init${RESET}, ${colors.cyan}run${RESET}, ${colors.cyan}status${RESET}, ${colors.cyan}eval${RESET}`);
    writeLine(`    Memory uses local ${colors.dim}.agents/memory/${RESET} files.`);
    writeLine();
    writeLine(`    ${colors.dim}To enable scheduling and telemetry:${RESET} squads stack up`);
    writeLine();
  } else if (!schedulerUp) {
    writeLine(`  ${colors.yellow}${icons.warning} Scheduler not running - triggers won't auto-fire${RESET}`);
    writeLine(`    ${colors.dim}Start with:${RESET} squads stack up scheduler`);
    writeLine();
  }
}
