import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

interface TelemetryEvent {
  event: string;
  timestamp: string;
  properties?: Record<string, string | number | boolean>;
}

interface TelemetryConfig {
  enabled: boolean;
  anonymousId: string;
  firstRun: string;
}

const TELEMETRY_DIR = join(homedir(), '.squads-cli');
const CONFIG_PATH = join(TELEMETRY_DIR, 'telemetry.json');
const EVENTS_PATH = join(TELEMETRY_DIR, 'events.json');

// Telemetry endpoint (when ready)
const TELEMETRY_ENDPOINT = process.env.SQUADS_TELEMETRY_URL || null;

function ensureDir(): void {
  if (!existsSync(TELEMETRY_DIR)) {
    mkdirSync(TELEMETRY_DIR, { recursive: true });
  }
}

function getConfig(): TelemetryConfig {
  ensureDir();

  if (!existsSync(CONFIG_PATH)) {
    const config: TelemetryConfig = {
      enabled: true, // Opt-out by default (common for CLIs)
      anonymousId: randomUUID(),
      firstRun: new Date().toISOString(),
    };
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    return config;
  }

  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { enabled: false, anonymousId: '', firstRun: '' };
  }
}

function saveConfig(config: TelemetryConfig): void {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

export function isEnabled(): boolean {
  // Check environment variable first (allows CI/testing override)
  if (process.env.SQUADS_TELEMETRY_DISABLED === '1') {
    return false;
  }
  if (process.env.DO_NOT_TRACK === '1') {
    return false;
  }

  return getConfig().enabled;
}

export function enable(): void {
  const config = getConfig();
  config.enabled = true;
  saveConfig(config);
}

export function disable(): void {
  const config = getConfig();
  config.enabled = false;
  saveConfig(config);
}

export function getAnonymousId(): string {
  return getConfig().anonymousId;
}

export async function track(event: string, properties?: Record<string, string | number | boolean>): Promise<void> {
  if (!isEnabled()) return;

  const config = getConfig();

  const telemetryEvent: TelemetryEvent = {
    event,
    timestamp: new Date().toISOString(),
    properties: {
      ...properties,
      anonymousId: config.anonymousId,
      cliVersion: process.env.npm_package_version || 'unknown',
    },
  };

  // Store locally (for debugging/review)
  storeEventLocally(telemetryEvent);

  // Send to endpoint if configured
  if (TELEMETRY_ENDPOINT) {
    try {
      await fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(telemetryEvent),
      }).catch(() => {}); // Silent fail - telemetry should never break the CLI
    } catch {
      // Silent fail
    }
  }
}

function storeEventLocally(event: TelemetryEvent): void {
  ensureDir();

  let events: TelemetryEvent[] = [];

  if (existsSync(EVENTS_PATH)) {
    try {
      events = JSON.parse(readFileSync(EVENTS_PATH, 'utf-8'));
    } catch {
      events = [];
    }
  }

  // Keep last 1000 events
  events.push(event);
  if (events.length > 1000) {
    events = events.slice(-1000);
  }

  writeFileSync(EVENTS_PATH, JSON.stringify(events, null, 2));
}

// Pre-defined events for consistency
export const Events = {
  CLI_INIT: 'cli.init',
  CLI_RUN: 'cli.run',
  CLI_STATUS: 'cli.status',
  CLI_DASHBOARD: 'cli.dashboard',
  CLI_GOAL_SET: 'cli.goal.set',
  CLI_GOAL_COMPLETE: 'cli.goal.complete',
  CLI_MEMORY_QUERY: 'cli.memory.query',
  CLI_FEEDBACK_ADD: 'cli.feedback.add',
} as const;

// Track command execution time
export function trackCommand(command: string): () => void {
  const start = Date.now();

  return () => {
    const duration = Date.now() - start;
    track(`cli.${command}`, { durationMs: duration });
  };
}
