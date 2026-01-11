import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform, release } from 'os';
import { randomUUID } from 'crypto';

interface TelemetryEvent {
  event: string;
  timestamp: string;
  properties?: Record<string, string | number | boolean | undefined>;
}

interface TelemetryConfig {
  enabled: boolean;
  anonymousId: string;
  firstRun: string;
}

const TELEMETRY_DIR = join(homedir(), '.squads-cli');
const CONFIG_PATH = join(TELEMETRY_DIR, 'telemetry.json');
const EVENTS_PATH = join(TELEMETRY_DIR, 'events.json');

// Telemetry endpoint - locked to Agents Squads infrastructure
// Users can opt-out but cannot redirect telemetry
const TELEMETRY_ENDPOINT = Buffer.from(
  'aHR0cHM6Ly9zcXVhZHMtdGVsZW1ldHJ5LTk3ODg3MTgxNzYxMC51cy1jZW50cmFsMS5ydW4uYXBwL3Bpbmc=',
  'base64'
).toString();

// API key for endpoint validation (obfuscated)
const TELEMETRY_KEY = Buffer.from('c3FfdGVsX3YxXzdmOGE5YjJjM2Q0ZTVmNmE=', 'base64').toString();

// Event queue for batch flushing
let eventQueue: TelemetryEvent[] = [];
let flushScheduled = false;

// Cached system context (computed once per session)
let cachedSystemContext: Record<string, string | undefined> | null = null;

/**
 * Get minimal system context for error identification.
 * Computed once per session for performance.
 */
function getSystemContext(): Record<string, string | undefined> {
  if (cachedSystemContext) return cachedSystemContext;

  cachedSystemContext = {
    os: platform(), // darwin, linux, win32
    osVersion: release(),
    nodeVersion: process.version,
    shell: process.env.SHELL?.split('/').pop() || process.env.ComSpec?.split('\\').pop(),
    terminal: process.env.TERM_PROGRAM || undefined,
    ci: process.env.CI === 'true' ? 'true' : undefined,
  };

  return cachedSystemContext;
}

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

export async function track(event: string, properties?: Record<string, string | number | boolean | undefined>): Promise<void> {
  if (!isEnabled()) return;

  const config = getConfig();

  const telemetryEvent: TelemetryEvent = {
    event,
    timestamp: new Date().toISOString(),
    properties: {
      ...properties,
      ...getSystemContext(),
      anonymousId: config.anonymousId,
      cliVersion: process.env.npm_package_version || 'unknown',
    },
  };

  // Store locally (for debugging/review)
  storeEventLocally(telemetryEvent);

  // Queue for batch sending
  eventQueue.push(telemetryEvent);

  // Schedule flush if not already scheduled
  if (TELEMETRY_ENDPOINT && !flushScheduled) {
    flushScheduled = true;
    // Flush on next tick to batch events from same command
    setImmediate(() => {
      flushEvents().catch(() => {});
    });
  }
}

/**
 * Flush queued events to the telemetry endpoint
 */
export async function flushEvents(): Promise<void> {
  if (!TELEMETRY_ENDPOINT || eventQueue.length === 0) {
    flushScheduled = false;
    return;
  }

  const batch = [...eventQueue];
  eventQueue = [];
  flushScheduled = false;

  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Squads-Key': TELEMETRY_KEY,
      },
      body: JSON.stringify({ events: batch }),
    });
  } catch {
    // Restore events on failure (will retry on next track)
    eventQueue = [...batch, ...eventQueue].slice(-100); // Keep max 100
  }
}

/**
 * Track an error event
 */
export async function trackError(
  command: string,
  error: Error,
  context?: Record<string, string | number | boolean>
): Promise<void> {
  await track(Events.CLI_ERROR, {
    command,
    errorType: error.constructor.name,
    errorMessage: error.message.slice(0, 100), // Truncate for privacy
    ...context,
  });
}

/**
 * Wrap an async command function with telemetry
 */
export function instrumentCommand<T>(
  name: string,
  fn: () => Promise<T>
): () => Promise<T> {
  return async () => {
    const start = Date.now();
    try {
      const result = await fn();
      await track(`cli.${name}`, {
        durationMs: Date.now() - start,
        success: true,
      });
      return result;
    } catch (error) {
      await trackError(name, error as Error, {
        durationMs: Date.now() - start,
      });
      throw error;
    }
  };
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
  // Lifecycle
  CLI_INIT: 'cli.init',
  CLI_ERROR: 'cli.error',

  // Commands
  CLI_RUN: 'cli.run',
  CLI_STATUS: 'cli.status',
  CLI_DASHBOARD: 'cli.dashboard',
  CLI_WORKERS: 'cli.workers',
  CLI_TONIGHT: 'cli.tonight',
  CLI_CONTEXT: 'cli.context',
  CLI_COST: 'cli.cost',
  CLI_EXEC: 'cli.exec',

  // Goals
  CLI_GOAL_SET: 'cli.goal.set',
  CLI_GOAL_LIST: 'cli.goal.list',
  CLI_GOAL_COMPLETE: 'cli.goal.complete',
  CLI_GOAL_PROGRESS: 'cli.goal.progress',

  // Memory
  CLI_MEMORY_QUERY: 'cli.memory.query',
  CLI_MEMORY_SHOW: 'cli.memory.show',
  CLI_MEMORY_UPDATE: 'cli.memory.update',
  CLI_MEMORY_LIST: 'cli.memory.list',
  CLI_MEMORY_SYNC: 'cli.memory.sync',

  // Feedback
  CLI_FEEDBACK_ADD: 'cli.feedback.add',
  CLI_FEEDBACK_SHOW: 'cli.feedback.show',
  CLI_FEEDBACK_STATS: 'cli.feedback.stats',

  // Learnings
  CLI_LEARN: 'cli.learn',
  CLI_LEARN_SHOW: 'cli.learn.show',
  CLI_LEARN_SEARCH: 'cli.learn.search',

  // Auth
  CLI_LOGIN: 'cli.login',
  CLI_LOGOUT: 'cli.logout',

  // Providers
  CLI_PROVIDERS: 'cli.providers',

  // Context Condenser
  CONDENSER_COMPRESS: 'condenser.compress',
  CONDENSER_DEDUPE: 'condenser.dedupe',
  CONDENSER_PRUNE: 'condenser.prune',
  CONDENSER_SUMMARIZE: 'condenser.summarize',
} as const;

// Track command execution time (legacy helper)
export function trackCommand(command: string): () => void {
  const start = Date.now();

  return () => {
    const duration = Date.now() - start;
    track(`cli.${command}`, { durationMs: duration });
  };
}

// Register exit handler to flush remaining events
let exitHandlerRegistered = false;

export function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  // beforeExit allows async operations (unlike 'exit')
  process.on('beforeExit', async () => {
    if (eventQueue.length > 0) {
      await flushEvents();
    }
  });

  // For signals, we need to handle manually
  const signalHandler = async (_signal: string) => {
    if (eventQueue.length > 0) {
      await flushEvents();
    }
    process.exit(0);
  };

  process.on('SIGINT', () => signalHandler('SIGINT'));
  process.on('SIGTERM', () => signalHandler('SIGTERM'));
}
