import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform, release } from 'os';
import { randomUUID } from 'crypto';
import type { Command } from 'commander';
import { version as cliVersion } from '../version.js';
import { loadProjectConfig } from './config.js';

interface TelemetryEvent {
  event: string;
  timestamp: string;
  properties?: Record<string, string | number | boolean | undefined>;
}

interface TelemetryConfig {
  enabled: boolean;
  anonymousId: string;
  firstRun: string;
  /** GA4 session id (epoch seconds, the form GA4 expects). Rolls after inactivity. */
  sessionId?: string;
  /** Epoch ms of the last flushed event — used to expire the session. */
  lastEventAt?: number;
  /** Whether `first_open` has been sent for this anonymousId. */
  firstOpenSent?: boolean;
}

/** GA4 closes a session after 30 minutes of inactivity. */
const SESSION_WINDOW_MS = 30 * 60 * 1000;

const TELEMETRY_DIR = join(homedir(), '.squads-cli');
const CONFIG_PATH = join(TELEMETRY_DIR, 'telemetry.json');
const EVENTS_PATH = join(TELEMETRY_DIR, 'events.json');

// Telemetry destination (#964): GA4 Measurement Protocol on a dedicated
// property — replaced the dead Cloud Run/BQ pipe (endpoint 404, warehouse
// frozen 2026-03-14). The api_secret is WRITE-only (spam-only risk) and
// rotatable in the GA admin; shipping it in the bundle is the accepted
// trade for a zero-infra collector.
const GA4_MEASUREMENT_ID = 'G-HYNPEBBXEN';
const GA4_API_SECRET = 'VYozX83RTUS0Hqe7lsi8cw';
const TELEMETRY_ENDPOINT = process.env.SQUADS_TELEMETRY_ENDPOINT ||
  `https://www.google-analytics.com/mp/collect?measurement_id=${GA4_MEASUREMENT_ID}&api_secret=${GA4_API_SECRET}`;

// Event queue for batch flushing
let eventQueue: TelemetryEvent[] = [];
let flushScheduled = false;
let isFirstInvoke = false;

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
    // Internal-traffic guard (#964): our own machines and the coo-tick must
    // never read as adoption — GA4 filters on traffic_type=internal.
    traffic_type: process.env.SQUADS_INTERNAL === '1' ||
      existsSync(join(homedir(), 'agents-squads', 'hq', '.agents')) ? 'internal' : undefined,
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
    isFirstInvoke = true; // journey_first_invoke fires once (#964)
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
 * Resolve the GA4 session for this flush.
 *
 * GA4's Measurement Protocol will not construct sessions unless every event
 * carries a `session_id` param — without it the property reports `sessions=0`
 * and every session-scoped report (funnels, paths, retention, new-vs-returning)
 * is empty regardless of how many events arrive (#1214).
 *
 * A CLI has no natural session, so we mirror GA4's own rule: reuse the stored
 * id while commands keep arriving, and start a new one after 30 minutes of
 * inactivity. Persisting it means consecutive commands group into one session
 * instead of each invocation looking like a separate visit.
 *
 * Also reports whether `first_open` still needs to be sent for this install —
 * GA4 derives `newUsers` from that event alone.
 */
export function resolveSession(
  config: TelemetryConfig,
  now: number = Date.now()
): { sessionId: string; needsFirstOpen: boolean } {
  const expired = !config.lastEventAt || now - config.lastEventAt > SESSION_WINDOW_MS;
  const sessionId = expired || !config.sessionId
    ? String(Math.floor(now / 1000))
    : config.sessionId;
  const needsFirstOpen = !config.firstOpenSent;

  config.sessionId = sessionId;
  config.lastEventAt = now;
  config.firstOpenSent = true;
  try {
    saveConfig(config);
  } catch {
    // Persisting is best-effort; a fresh session id per process is still
    // better than none at all.
  }

  return { sessionId, needsFirstOpen };
}

/**
 * Check if telemetry is enabled.
 * Telemetry is disabled if:
 *   - SQUADS_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1 (env)
 *   - SQUADS_TELEMETRY=false (env, checked via project config)
 *   - telemetry: false in .squads/config.yml
 *   - `squads config set telemetry false` (~/.squads-cli/telemetry.json)
 * @returns true if telemetry collection is enabled
 */
export function isEnabled(): boolean {
  // CI runners are not users (#964): test suites and pipelines spawn the CLI
  // hundreds of times and would drown the adoption funnel. VITEST covers
  // local test runs, which spawn the built CLI e2e.
  if (process.env.CI === 'true' || process.env.VITEST) {
    return false;
  }
  // Check environment variable first (allows CI/testing override)
  if (process.env.SQUADS_TELEMETRY_DISABLED === '1') {
    return false;
  }
  if (process.env.DO_NOT_TRACK === '1') {
    return false;
  }

  // Check project-level config (env: SQUADS_TELEMETRY > .squads/config.yml)
  try {
    if (!loadProjectConfig().telemetry) {
      return false;
    }
  } catch {
    // Config loading may fail in edge cases — fall through to user config
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

  if (isFirstInvoke) {
    isFirstInvoke = false; // before the recursive call — fire exactly once
    await track('journey.first_invoke', {});
  }

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
  if (!TELEMETRY_ENDPOINT || eventQueue.length === 0) {
    flushScheduled = false;
    return;
  }

  const batch = [...eventQueue];
  eventQueue = [];
  flushScheduled = false;

  const config = getConfig();
  const { sessionId, needsFirstOpen } = resolveSession(config);
  try {
    // GA4 MP accepts ≤25 events per request; names snake_case ≤40 chars;
    // params must be scalars with names ≤40 / values ≤100 chars.
    // `first_open` leads the first batch this install ever sends — GA4 derives
    // newUsers from it and will otherwise report 0 forever.
    const queued = batch.map((e) => toMpEvent(e, sessionId));
    const all = needsFirstOpen
      ? [{ name: 'first_open', params: { engagement_time_msec: 1, session_id: sessionId } }, ...queued]
      : queued;

    for (let i = 0; i < all.length; i += 25) {
      const events = all.slice(i, i + 25);
      await fetch(TELEMETRY_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: config.anonymousId || 'unknown', events }),
        signal: AbortSignal.timeout(5000),
      });
    }
  } catch {
    // Restore events on failure (will retry on next track)
    eventQueue = [...batch, ...eventQueue].slice(-100); // Keep max 100
  }
}

/** GA4 Measurement Protocol shape: snake_case name ≤40 chars, scalar params. */
export function toMpEvent(
  e: TelemetryEvent,
  sessionId?: string
): { name: string; params: Record<string, string | number> } {
  const name = e.event.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').slice(0, 40);
  const params: Record<string, string | number> = { engagement_time_msec: 1 };
  if (sessionId) params.session_id = sessionId;
  for (const [k, v] of Object.entries(e.properties || {})) {
    if (v === undefined || v === null) continue;
    const key = k.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40);
    params[key] = typeof v === 'number' ? v : String(v).slice(0, 100);
  }
  return { name, params };
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
  CLI_LOG: 'cli.log',
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

  // User outreach
  CLI_EMAIL_CAPTURED: 'cli.email_captured',

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
/**
 * Full subcommand path of a Commander action command, dot-joined
 * (e.g. "memory.sync", "goal.set"). Excludes the root program name.
 */
export function commandPath(cmd: Command): string {
  const parts: string[] = [];
  let c: Command | null = cmd;
  while (c && c.parent) {
    parts.unshift(c.name());
    c = c.parent;
  }
  return parts.join('.') || cmd.name();
}

/**
 * Names of the flags the caller explicitly passed (option source 'cli'),
 * sorted. Names ONLY — flag values and positional args never leave the
 * machine (#1009 privacy scope).
 */
export function presentFlagNames(cmd: Command): string[] {
  const names: string[] = [];
  for (const opt of cmd.options) {
    try {
      if (cmd.getOptionValueSource(opt.attributeName()) === 'cli') {
        names.push(opt.long ?? opt.short ?? opt.attributeName());
      }
    } catch {
      // telemetry must never break a command
    }
  }
  return names.sort();
}

/**
 * Root command instrumentation (#1009): one preAction/postAction pair on
 * the program covers every command, current and future — no per-command
 * wiring. preAction emits `cli.<path>` (the usage counter; fires even when
 * the action later hard-exits — the local store write is synchronous).
 * postAction emits `cli.done` with duration + success for commands that
 * complete. Payload is hard-scoped to command path + present flag NAMES;
 * values and positional args NEVER ship. Routes through track(), so
 * opt-out / DO_NOT_TRACK / CI+VITEST suppression apply automatically.
 */
export function installCommandTelemetry(
  program: Command,
  trackFn: typeof track = track
): void {
  const startedAt = new WeakMap<Command, number>();
  program.hook('preAction', async (_root, actionCommand) => {
    startedAt.set(actionCommand, Date.now());
    const flags = presentFlagNames(actionCommand).join(',');
    await trackFn(`cli.${commandPath(actionCommand)}`, {
      flags: flags || undefined,
    });
  });
  program.hook('postAction', async (_root, actionCommand) => {
    const start = startedAt.get(actionCommand);
    await trackFn('cli.done', {
      command: commandPath(actionCommand),
      durationMs: start ? Date.now() - start : undefined,
      success: !process.exitCode,
    });
  });
}

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
