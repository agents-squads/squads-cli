/**
 * Shared types and constants for the `squads run` command.
 * Extracted from commands/run.ts to enable reuse across run-* modules.
 */
import type { EffortLevel } from './squad-parser.js';

// ── Constants ────────────────────────────────────────────────────────
export const DEFAULT_TIMEOUT_MINUTES = 15;

/**
 * Research-class agents (web scanners, profilers, monitors) research first and
 * write last — a 15-minute watchdog reaps them at ANY scope before the write
 * (6/6 company-profilers lost on 2026-07-04, #941). They get a 40m default.
 * An explicit --timeout / -t or SQUADS_AGENT_TIMEOUT_MINUTES always wins.
 */
export const RESEARCH_TIMEOUT_MINUTES = 40;
const RESEARCH_HINT = /scan|monitor|research|profil|watch|intel|market/i;

export function defaultTimeoutMinutes(agent?: { name?: string; role?: string }): number {
  if (!agent) return DEFAULT_TIMEOUT_MINUTES;
  return RESEARCH_HINT.test(`${agent.name ?? ''} ${agent.role ?? ''}`)
    ? RESEARCH_TIMEOUT_MINUTES
    : DEFAULT_TIMEOUT_MINUTES;
}
export const SOFT_DEADLINE_RATIO = 0.7;

/** Providers that support tool use (sub-agent spawning, conversation orchestration) */
export const TOOL_USE_PROVIDERS = new Set(['anthropic', 'google']);

// ── Interfaces ───────────────────────────────────────────────────────

export interface RunOptions {
  verbose?: boolean;
  dryRun?: boolean;
  agent?: string;
  timeout?: number; // per-agent minutes; unset → DEFAULT_TIMEOUT_MINUTES
  execute?: boolean;
  parallel?: boolean; // Run all agents in parallel
  lead?: boolean; // Run as lead session using Task tool for parallelization
  foreground?: boolean; // Run in foreground (deprecated, now default)
  background?: boolean; // Run in background (detached process)
  watch?: boolean; // Run in background but tail the log
  useApi?: boolean; // Use API credits instead of subscription
  effort?: EffortLevel; // Effort level: high, medium, low
  skills?: string[]; // Skills to load (skill IDs or local paths)
  trigger?: 'manual' | 'scheduled' | 'event' | 'smart'; // Trigger source for telemetry
  provider?: string; // LLM provider: anthropic, google, openai, mistral, xai, aider, ollama
  model?: string; // Model to use (Claude aliases or full model IDs like gemini-2.5-flash)
  verify?: boolean; // Post-execution verification (default true, --no-verify to skip)
  cloud?: boolean; // Dispatch to cloud worker via API instead of local execution
  conversation?: boolean; // Run squad as multi-agent conversation (default for squad runs)
  task?: string; // Founder directive — replaces lead briefing in conversation mode
  maxTurns?: number; // Max conversation turns (default: 20)
  costCeiling?: number; // Cost ceiling in USD (default: 25)
  interval?: number | string; // Autopilot: minutes between cycles
  maxParallel?: number | string; // Autopilot: max parallel squad loops
  budget?: number | string; // Autopilot: daily budget cap ($)
  once?: boolean; // Autopilot: run one cycle then exit
  phased?: boolean; // Autopilot: use dependency-based phase ordering
  eval?: boolean; // Post-run COO evaluation (default: true, --no-eval to skip)
  org?: boolean; // Org cycle: scan → plan → execute all leads → report
  force?: boolean; // Force re-run squads that already completed today
  resume?: boolean; // Resume org cycle from quota-skipped squads
  focus?: string; // Cycle focus: create, resolve, review, ship, research, cost
  yes?: boolean; // Skip the org-run cost confirmation gate (deliberate trigger)
  waitForQuota?: boolean; // Org cycle: on quota cap, poll until the window reopens instead of stopping
}

/**
 * Execution context for telemetry tagging.
 * Passed to Claude via environment variables for per-agent cost tracking.
 */
export interface ExecutionContext {
  squad: string;
  agent: string;
  taskType: 'evaluation' | 'execution' | 'research' | 'lead';
  trigger: 'manual' | 'scheduled' | 'event' | 'smart';
  executionId: string;
}
