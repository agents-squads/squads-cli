import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';

const CLI_PATH = join(__dirname, '..', 'dist', 'cli.js');

function runCli(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
    };
  }
}

// ─── #1009: root preAction/postAction telemetry hook ────────────────────────
// These tests need real command *execution* (not just --help), so they run
// the built CLI with an isolated HOME and telemetry re-enabled (the rest of
// the suite runs under VITEST, which telemetry.ts suppresses by design).
const telemetryHomes: string[] = [];

function runCliWithTelemetry(args: string, envOverrides: Record<string, string> = {}): { stdout: string; exitCode: number; events: Array<{ event: string; properties?: Record<string, unknown> }> } {
  const home = mkdtempSync(join(tmpdir(), 'squads-cli-telemetry-'));
  telemetryHomes.push(home);
  const env = { ...process.env, HOME: home, SQUADS_NO_AUTO_UPDATE: '1', SQUADS_TELEMETRY_ENDPOINT: 'http://127.0.0.1:1/unreachable', ...envOverrides };
  delete env.CI;
  delete env.VITEST;
  delete env.SQUADS_TELEMETRY_DISABLED;
  delete env.DO_NOT_TRACK;

  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execSync(`node ${CLI_PATH} ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], env });
  } catch (error: unknown) {
    const e = error as { stdout?: string; status?: number };
    stdout = e.stdout || '';
    exitCode = e.status || 1;
  }

  let events: Array<{ event: string; properties?: Record<string, unknown> }> = [];
  try {
    events = JSON.parse(readFileSync(join(home, '.squads-cli', 'events.json'), 'utf-8'));
  } catch {
    events = [];
  }
  return { stdout, exitCode, events };
}

describe('CLI', () => {
  describe('--help', () => {
    it('shows help without error', () => {
      const result = runCli('--help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('squads');
      expect(result.stdout).toContain('Your AI workforce');
    });

    it('lists available commands', () => {
      const result = runCli('--help');
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('dashboard');
      expect(result.stdout).toContain('run');
      expect(result.stdout).toContain('memory');
    });
  });

  describe('--version', () => {
    it('shows version', () => {
      const result = runCli('--version');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });
  });

  describe('removed commands', () => {
    it('shows removed message for deprecated commands', () => {
      const result = runCli('workers --help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('[removed]');
    });
  });

  describe('memory', () => {
    it('shows memory subcommands', () => {
      const result = runCli('memory --help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('query');
      expect(result.stdout).toContain('show');
      expect(result.stdout).toContain('update');
      expect(result.stdout).toContain('sync');
    });
  });

  describe('goal', () => {
    it('shows goal subcommands', () => {
      const result = runCli('goal --help');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('set');
      expect(result.stdout).toContain('list');
      expect(result.stdout).toContain('complete');
    });
  });
});

describe('telemetry hook (#1009)', () => {
  afterEach(() => {
    while (telemetryHomes.length > 0) {
      const home = telemetryHomes.pop();
      if (home) rmSync(home, { recursive: true, force: true });
    }
  });

  it('builds a spaced path for nested subcommands and records the baseline event', () => {
    const { exitCode, events } = runCliWithTelemetry('goal set super-secret-squad-name "very private goal text"');
    expect(exitCode).toBe(0);
    const goalSetEvent = events.find(e => e.event === 'cli.goal set');
    expect(goalSetEvent).toBeDefined();
    expect(goalSetEvent?.properties?.command).toBe('goal set');
    expect(goalSetEvent?.properties?.success).toBe(true);
    expect(typeof goalSetEvent?.properties?.duration_ms).toBe('number');
  });

  it('records present flag names without their values', () => {
    const { events } = runCliWithTelemetry('goal set super-secret-squad-name "very private goal text" -m leads_generated');
    const goalSetEvent = events.find(e => e.event === 'cli.goal set');
    expect(goalSetEvent?.properties?.flags).toBe('metric');
  });

  it('records an empty flags string when no flags were passed', () => {
    const { events } = runCliWithTelemetry('goal set super-secret-squad-name "very private goal text"');
    const goalSetEvent = events.find(e => e.event === 'cli.goal set');
    expect(goalSetEvent?.properties?.flags).toBe('');
  });

  it('never leaks positional argument values anywhere in the payload', () => {
    const { events } = runCliWithTelemetry('goal set super-secret-squad-name "very private goal text" -m leads_generated');
    const goalSetEvent = events.find(e => e.event === 'cli.goal set');
    const serialized = JSON.stringify(goalSetEvent);
    expect(serialized).not.toContain('super-secret-squad-name');
    expect(serialized).not.toContain('very private goal text');
    expect(serialized).not.toContain('leads_generated');
  });

  it('fires journey.first_invoke exactly once and composes with the baseline event', () => {
    const { events } = runCliWithTelemetry('goal list');
    const firstInvokeEvents = events.filter(e => e.event === 'journey.first_invoke');
    expect(firstInvokeEvents).toHaveLength(1);
    expect(events.some(e => e.event === 'cli.goal list')).toBe(true);
  });

  it('records success:false when the action handler throws (postAction does not fire on throw)', () => {
    // `credentials create` has no internal try/catch — getProject() throws a
    // real Error when `gcloud` isn't resolvable, which propagates straight
    // out of the action handler. Hiding gcloud via PATH makes this
    // deterministic regardless of whether the host machine has it installed.
    const restrictedPath = `${dirname(process.execPath)}:/usr/bin:/bin`;
    const { exitCode, events } = runCliWithTelemetry('credentials create some-squad', { PATH: restrictedPath });
    expect(exitCode).toBe(1);
    const credEvent = events.find(e => e.event === 'cli.credentials create');
    expect(credEvent).toBeDefined();
    expect(credEvent?.properties?.command).toBe('credentials create');
    expect(credEvent?.properties?.success).toBe(false);
    expect(typeof credEvent?.properties?.duration_ms).toBe('number');
    expect(JSON.stringify(credEvent)).not.toContain('some-squad');
  });
});
