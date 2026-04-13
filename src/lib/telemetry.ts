import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform, release } from 'os';
import { randomUUID } from 'crypto';
import { version as cliVersion } from '../version.js';

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
const TELEMETRY_ENDPOINT = process.env.SQUADS_TELEMETRY_ENDPOINT || Buffer.from(
  'aHR0cHM6Ly9zcXVhZHMtdGVsZW1ldHJ5LTk3ODg3MTgxNzYxMC51cy1jZW50cmFsMS5ydW4uYXBwL3Bpbmc=',
  'base64'
).toString();

// API key for endpoint validation — must be set via environment variable
// NEVER hardcode API keys in source (see: engineering#51)
const TELEMETRY_KEY = process.env.SQUADS_TELEMETRY_KEY || '';

// Event queue for batch flushing
let eventQueue: TelemetryEvent[] = [];
let flushScheduled = false;

// Cached system context (computed once per session)
let cachedSystemContext: Record<string, string | undefined> | null = null;

/**
 * Detect user type for segmentation.
 * - 'agent': Autonomous agent execution (via squads run)
 * - 'ci': CI/CD environment (GitHub Actions, Azure Pipelines, etc)
 * - 'human': Interactive terminal usage
 */
function detectUserType(): 'human' | 'agent' | 'ci' {
  // Agent execution (set by squads run command)
  // SQUADS_AGENT contains the agent name when running via squads run
  if (process.env.SQUADS_AGENT) {
    return 'agent';
  }

  // CI/CD environments
  if (
    process.env.CI === 'true' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.GITLAB_CI === 'true' ||
    process.env.JENKINS_URL ||
    process.env.BUILDKITE === 'true' ||
    process.env.CIRCLECI === 'true' ||
    process.env.AZURE_PIPELINES === 'true' ||
    process.env.TF_BUILD === 'True'
  ) {
    return 'ci';
  }

  return 'human';
}

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
    userType: detectUserType(),
    // Agent context (set by squads run)
    squad: process.env.SQUADS_SQUAD || undefined,
    agent: process.env.SQUADS_AGENT || undefined,
    executionId: process.env.SQUADS_EXECUTION_ID || undefined,
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

/**
 * Check if telemetry is enabled.
 * Telemetry is disabled if SQUADS_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1.
 * @returns true if telemetry collection is enabled
 */
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

/**
 * Enable telemetry collection.
 * Persists the setting to ~/.squads-cli/telemetry.json
 */
export function enable(): void {
  const config = getConfig();
  config.enabled = true;
  saveConfig(config);
}

/**
 * Disable telemetry collection.
 * Persists the setting to ~/.squads-cli/telemetry.json
 */
export function disable(): void {
  const config = getConfig();
  config.enabled = false;
  saveConfig(config);
}

/**
 * Get the anonymous identifier for this CLI installation.
 * Generated once on first run and persisted.
 * @returns UUID string
 */
export function getAnonymousId(): string {
  return getConfig().anonymousId;
}

/**
 * Track a telemetry event with optional properties.
 * Events are batched and flushed asynchronously.
 * @param event - Event name (e.g., 'cli.status', 'cli.error')
 * @param properties - Optional key-value pairs of event metadata
 */
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
      cliVersion,
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
  if (!TELEMETRY_ENDPOINT || !TELEMETRY_KEY || eventQueue.length === 0) {
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
      signal: AbortSignal.timeout(5000),
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

/**
 * Pre-defined event names for consistency across the CLI.
 * Use these constants instead of string literals.
 */
export const Events = {
  // Lifecycle
  CLI_INIT: 'cli.init',
  CLI_ERROR: 'cli.error',

  // Commands
  CLI_RUN: 'cli.run',
  CLI_RUN_COMPLETE: 'cli.run.complete',
  CLI_STATUS: 'cli.status',
  CLI_DASHBOARD: 'cli.dashboard',
  CLI_WORKERS: 'cli.workers',
  CLI_TONIGHT: 'cli.tonight',
  CLI_CONTEXT: 'cli.context',
  CLI_COST: 'cli.cost',
  CLI_EXEC: 'cli.exec',
  CLI_BASELINE: 'cli.baseline',

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

  // KPIs
  CLI_KPI_SHOW: 'cli.kpi.show',
  CLI_KPI_RECORD: 'cli.kpi.record',
  CLI_KPI_TREND: 'cli.kpi.trend',
  CLI_KPI_INSIGHTS: 'cli.kpi.insights',
  CLI_KPI_LIST: 'cli.kpi.list',

  // Cycle Sync
  CLI_SYNC_CYCLE: 'cli.sync.cycle',

  // Context Condenser
  CONDENSER_COMPRESS: 'condenser.compress',
  CONDENSER_DEDUPE: 'condenser.dedupe',
  CONDENSER_PRUNE: 'condenser.prune',
  CONDENSER_SUMMARIZE: 'condenser.summarize',
} as const;

/**
 * Track command execution time.
 * Call at start of command, returns function to call when command completes.
 * @param command - Command name (without 'cli.' prefix)
 * @returns Callback to invoke when command completes
 * @example
 * const done = trackCommand('status');
 * // ... execute command ...
 * done(); // Records duration
 */
export function trackCommand(command: string): () => void {
  const start = Date.now();

  return () => {
    const duration = Date.now() - start;
    track(`cli.${command}`, { durationMs: duration });
  };
}

// Register exit handler to flush remaining events
let exitHandlerRegistered = false;

/**
 * Register process exit handlers to flush pending telemetry events.
 * Call once at CLI startup. Handles SIGINT, SIGTERM, and normal exit.
 */
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
