/**
 * Shared types and constants for the `squads run` command.
 * Extracted from commands/run.ts to enable reuse across run-* modules.
 */
import type { EffortLevel } from './squad-parser.js';

// ── Constants ────────────────────────────────────────────────────────
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const SOFT_DEADLINE_RATIO = 0.7;

// ── Interfaces ───────────────────────────────────────────────────────

export interface RunOptions {
  verbose?: boolean;
  dryRun?: boolean;
  agent?: string;
  timeout?: number; // minutes, default 30
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
  stop?: boolean; // Daemon: stop running daemon
  status?: boolean; // Daemon: show daemon status
  pause?: boolean | string; // Daemon: pause (optional reason)
  resume?: boolean; // Daemon: resume after pause
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
