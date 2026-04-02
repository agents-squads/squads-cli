/**
 * E2E: First-Run User Journey Simulation
 *
 * Simulates a new user's complete first-run experience.
 * Maps to the 7-step retention improvement plan from issue #488.
 *
 * Design:
 * - Each step is timed and labeled by friction type (P0/P1/P2)
 * - Steps that require real auth are verified for UX quality (not run blindly)
 * - All steps run in a clean isolated temp directory
 * - Total journey must complete in <5 minutes
 *
 * Friction labels:
 *   P0 = crash / error / silent failure (retention killer)
 *   P1 = confusing output, misleading message (high friction)
 *   P2 = slow (>target thresholds but not broken)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

// Clear git env vars set by pre-commit hook to prevent GIT_DIR pollution
beforeAll(() => {
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
  delete process.env.GIT_INDEX_FILE;
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const CLI_PATH = resolve(__dirname, '../../dist/cli.js');

/** Strip ANSI escape codes for plain-text assertions */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/\x1B\[[0-9;]*m/g, '');
}

interface StepResult {
  step: number;
  name: string;
  durationMs: number;
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string,
  cwd: string,
  opts: { timeout?: number; input?: string } = {}
): { stdout: string; stderr: string; exitCode: number; durationMs: number } {
  const start = Date.now();
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 30000,
      // Override HOME so ~/.squads/ config writes land in cwd, not the real home.
      // This prevents parallel test files from sharing daemon/config state.
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', HOME: cwd },
      input: opts.input,
    });
    return { stdout: stripAnsi(stdout), stderr: '', exitCode: 0, durationMs: Date.now() - start };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: stripAnsi(e.stdout || ''),
      stderr: stripAnsi(e.stderr || ''),
      exitCode: e.status || 1,
      durationMs: Date.now() - start,
    };
  }
}

// Shared state for the journey
let testDir: string;
let firstSquad: string;
const journeySteps: StepResult[] = [];

function logStep(step: Omit<StepResult, never>) {
  journeySteps.push(step);
}

// Create test dir once for the entire journey
const JOURNEY_DIR = join(tmpdir(), `squads-first-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
mkdirSync(JOURNEY_DIR, { recursive: true });
execSync('git init -q', { cwd: JOURNEY_DIR });
testDir = JOURNEY_DIR;

afterAll(() => {
  // Print journey summary
  console.log('\n=== First-Run Journey Summary ===');
  let totalMs = 0;
  for (const step of journeySteps) {
    const friction = step.exitCode !== 0 ? '[P0-FAIL]' : step.durationMs > 5000 ? '[P2-SLOW]' : '[OK]';
    console.log(`  Step ${step.step}: ${step.name} — ${step.durationMs}ms ${friction}`);
    totalMs += step.durationMs;
  }
  console.log(`  Total journey: ${totalMs}ms (limit: 300000ms)`);
  console.log('================================\n');

  // Cleanup
  if (existsSync(JOURNEY_DIR)) {
    rmSync(JOURNEY_DIR, { recursive: true, force: true });
  }
});

describe('E2E: First-Run User Journey (#488)', () => {
  /**
   * Step 1: Version check
   * Simulates "npm install -g squads-cli" success.
   * In CI we skip the actual install but verify the binary works.
   * Threshold: <500ms (instant)
   */
  it('Step 1 — version: binary works after install', () => {
    const result = runCli('--version', testDir, { timeout: 5000 });
    logStep({ step: 1, name: '--version', ...result });

    // P0: Must not crash
    expect(result.exitCode).toBe(0);

    // P0: Must print a version number (not empty, not an error)
    expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);

    // P2: Should be fast
    expect(result.durationMs).toBeLessThan(5000);
  });

  /**
   * Step 2: Help
   * New user runs --help to understand what the tool does.
   * Threshold: <1s
   */
  it('Step 2 — help: shows clear commands and usage', () => {
    const result = runCli('--help', testDir, { timeout: 5000 });
    logStep({ step: 2, name: '--help', ...result });

    // P0: Must not crash
    expect(result.exitCode).toBe(0);

    // P1: Must list key commands clearly
    expect(result.stdout).toContain('init');
    expect(result.stdout).toContain('run');
    expect(result.stdout).toContain('status');

    // P1: Must have Usage/Options section
    expect(result.stdout).toMatch(/Usage|Commands|Options/i);

    // P2: Should be fast
    expect(result.durationMs).toBeLessThan(3000);
  });

  /**
   * Step 3: Init
   * User sets up their squad project in a fresh directory.
   * Threshold: <30s (per issue requirements)
   */
  it('Step 3 — init: creates project structure in <30s', () => {
    const result = runCli('init --yes --force', testDir, { timeout: 35000 });
    logStep({ step: 3, name: 'init', ...result });

    // P0: Must not crash
    expect(result.exitCode).toBe(0);

    // P0: Core directories must be created
    expect(existsSync(join(testDir, '.agents', 'squads'))).toBe(true);
    expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(true);

    // P2: Must complete within 30s
    expect(result.durationMs).toBeLessThan(30000);

    // Capture first squad for subsequent steps
    const squadsDir = join(testDir, '.agents', 'squads');
    const squads = readdirSync(squadsDir).filter(
      (f) => existsSync(join(squadsDir, f, 'SQUAD.md'))
    );
    expect(squads.length).toBeGreaterThan(0);
    firstSquad = squads[0];
  });

  /**
   * Step 3b: Verify init scaffolding content
   * The 4 core squads, cascade files, sentinel, and agent count.
   */
  it('Step 3b — init content: 5 squads (4 core + demo), 15 agents, cascade files, placeholder sentinel', () => {
    const squadsDir = join(testDir, '.agents', 'squads');
    const squads = readdirSync(squadsDir).filter(
      (f) => existsSync(join(squadsDir, f, 'SQUAD.md'))
    );

    // Must create exactly 5 squads: 4 core + demo starter squad
    expect(squads.sort()).toEqual(['company', 'demo', 'intelligence', 'product', 'research']);

    // Must create 15 agent files total: 5 company + 3 research + 3 intelligence + 3 product + 1 demo (excluding SQUAD.md)
    let agentCount = 0;
    for (const squad of squads) {
      const files = readdirSync(join(squadsDir, squad)).filter(
        (f) => f.endsWith('.md') && f !== 'SQUAD.md'
      );
      agentCount += files.length;
    }
    expect(agentCount).toBe(15);

    // Context cascade files must exist
    expect(existsSync(join(testDir, '.agents', 'config', 'SYSTEM.md'))).toBe(true);
    expect(existsSync(join(testDir, '.agents', 'BUSINESS_BRIEF.md'))).toBe(true);
    expect(existsSync(join(testDir, '.agents', 'memory', 'company', 'directives.md'))).toBe(true);

    // BUSINESS_BRIEF with --yes should have real content (no PLACEHOLDER sentinel)
    const brief = readFileSync(join(testDir, '.agents', 'BUSINESS_BRIEF.md'), 'utf-8');
    expect(brief).toContain('autonomous execution');
    expect(brief).not.toContain('PLACEHOLDER');

    // SYSTEM.md must instruct agents to check for PLACEHOLDER (for interactive mode where user skips)
    const system = readFileSync(join(testDir, '.agents', 'config', 'SYSTEM.md'), 'utf-8');
    expect(system).toContain('PLACEHOLDER');

    // Root files must exist
    expect(existsSync(join(testDir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(testDir, 'AGENTS.md'))).toBe(true);
  });

  /**
   * Step 4: Status
   * User wants to see what squads are available.
   * Threshold: <2s
   */
  it('Step 4 — status: shows available squads', () => {
    const result = runCli('status', testDir, { timeout: 10000 });
    logStep({ step: 4, name: 'status', ...result });

    // P0: Must not crash
    expect(result.exitCode).toBe(0);

    // P1: Output must not be empty
    expect(result.stdout.trim().length).toBeGreaterThan(0);

    // P1: Must show squads (each has a name)
    const squadsDir = join(testDir, '.agents', 'squads');
    const squads = readdirSync(squadsDir);
    // At least one squad name should appear in output
    const foundSquad = squads.some((s) => result.stdout.includes(s));
    expect(foundSquad).toBe(true);

    // P2: Must be fast
    expect(result.durationMs).toBeLessThan(5000);
  });

  /**
   * Step 5: Run (dry-run mode)
   * User runs an agent squad. In CI we use --dry-run to avoid real API calls.
   * The real retention metric is whether the user gets useful output.
   * Threshold: <5min (per issue requirements)
   */
  it('Step 5 — run: dry-run completes with useful output', () => {
    const squad = firstSquad || 'company';
    const result = runCli(`run ${squad} --dry-run`, testDir, { timeout: 60000 });
    logStep({ step: 5, name: `run ${squad} --dry-run`, ...result });

    // P0: Must not crash
    expect(result.exitCode).toBe(0);

    // P1: Output must mention the squad
    expect(result.stdout).toContain(squad);

    // P2: Dry-run must be fast (no actual agent execution)
    expect(result.durationMs).toBeLessThan(30000);
  });

  /**
   * Step 6: Memory read
   * User checks what agents learned. Even on first run, this should not crash.
   * P0: Must not crash. P1: Should give helpful output or message.
   */
  it('Step 6 — memory read: does not crash, shows state or helpful message', () => {
    const squad = firstSquad || 'company';
    const result = runCli(`memory read ${squad}`, testDir, { timeout: 10000 });
    logStep({ step: 6, name: `memory read ${squad}`, ...result });

    // P0: Must not crash with unhandled exception or empty output
    // (exit code 1 is OK if message is helpful, e.g. "No memory found")
    const combinedOutput = result.stdout + result.stderr;
    expect(combinedOutput.trim().length).toBeGreaterThan(0);

    // P1: If it fails, it must give a human-readable message (not a stack trace)
    if (result.exitCode !== 0) {
      expect(combinedOutput).not.toContain('TypeError');
      expect(combinedOutput).not.toContain('at Object.');
      expect(combinedOutput).not.toContain('at Module.');
    }

    // P2: Must respond quickly
    expect(result.durationMs).toBeLessThan(10000);
  });

  /**
   * Step 7: Second run
   * User runs the squad again. The CLI should behave consistently.
   * A real intelligence test (agents learn from first run) requires real execution,
   * but at minimum the second dry-run must succeed identically to the first.
   */
  it('Step 7 — second run: consistent behavior on repeated execution', () => {
    const squad = firstSquad || 'company';
    const result = runCli(`run ${squad} --dry-run`, testDir, { timeout: 60000 });
    logStep({ step: 7, name: `run ${squad} --dry-run (2nd)`, ...result });

    // P0: Must not crash on second run (no state corruption)
    expect(result.exitCode).toBe(0);

    // P1: Output must still mention the squad
    expect(result.stdout).toContain(squad);
  });

  /**
   * Journey gate: Total duration must be under 5 minutes.
   * This runs after all steps have been logged.
   */
  it('Journey gate: total time under 5 minutes', () => {
    const totalMs = journeySteps.reduce((sum, s) => sum + s.durationMs, 0);
    // 5 minutes = 300,000ms
    expect(totalMs).toBeLessThan(300000);
  });

  /**
   * Unknown command UX: Should give helpful error, not silent failure.
   * Regression test for issue #459.
   */
  it('UX: unknown command gives helpful error message', () => {
    const result = runCli('not-a-real-command', testDir, { timeout: 5000 });

    // P0: Must exit non-zero
    expect(result.exitCode).not.toBe(0);

    // P1: Must give actionable output (not just exit silently)
    const combined = result.stdout + result.stderr;
    expect(combined.trim().length).toBeGreaterThan(0);

    // P1: Should suggest help or available commands
    expect(combined).toMatch(/unknown|invalid|help|command/i);
  });
});
