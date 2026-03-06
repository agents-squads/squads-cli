/**
 * E2E tests for critical user workflows: init → status → run
 *
 * These tests run the actual CLI binary in isolated temp directories
 * to verify that the full user journey produces expected output.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const CLI_PATH = resolve(__dirname, '../../dist/cli.js');

/** Strip ANSI escape codes for plain-text assertions */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').replace(/\x1B\[[0-9;]*m/g, '');
}

function runCli(
  args: string,
  cwd: string,
  opts: { timeout?: number } = {}
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`node ${CLI_PATH} ${args}`, {
      encoding: 'utf-8',
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: opts.timeout ?? 15000,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: stripAnsi(e.stdout || ''),
      stderr: stripAnsi(e.stderr || ''),
      exitCode: e.status || 1,
    };
  }
}

/**
 * Return which squad directories were created.
 * Works regardless of whether init creates 'demo' or 'company/research/...' squads.
 */
function getCreatedSquads(testDir: string): string[] {
  const squadsDir = join(testDir, '.agents', 'squads');
  if (!existsSync(squadsDir)) return [];
  return readdirSync(squadsDir) as string[];
}

describe('E2E: squads init workflow', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `squads-e2e-init-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    // init requires a git repo
    execSync('git init -q', { cwd: testDir });
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits with code 0 on successful init', () => {
    const result = runCli('init --yes --provider none --force', testDir);
    expect(result.exitCode).toBe(0);
  });

  it('reports success in output', () => {
    const result = runCli('init --yes --provider none --force', testDir);
    const out = stripAnsi(result.stdout);
    // Accept either "Squads initialized" or "AI workforce is ready" success messages
    expect(out).toMatch(/initialized|workforce is ready/i);
  });

  it('creates .agents/squads directory', () => {
    runCli('init --yes --provider none --force', testDir);
    expect(existsSync(join(testDir, '.agents', 'squads'))).toBe(true);
  });

  it('creates at least one squad directory', () => {
    runCli('init --yes --provider none --force', testDir);
    const squads = getCreatedSquads(testDir);
    expect(squads.length).toBeGreaterThan(0);
  });

  it('creates SQUAD.md in each squad directory', () => {
    runCli('init --yes --provider none --force', testDir);
    const squads = getCreatedSquads(testDir);
    for (const squad of squads) {
      const squadFile = join(testDir, '.agents', 'squads', squad, 'SQUAD.md');
      expect(existsSync(squadFile)).toBe(true);
      const content = readFileSync(squadFile, 'utf-8');
      expect(content.length).toBeGreaterThan(0);
    }
  });

  it('creates agent definition files in each squad', () => {
    runCli('init --yes --provider none --force', testDir);
    const squads = getCreatedSquads(testDir);
    for (const squad of squads) {
      const squadDir = join(testDir, '.agents', 'squads', squad);
      const files = readdirSync(squadDir) as string[];
      const agentFiles = files.filter((f: string) => f.endsWith('.md') && f !== 'SQUAD.md');
      expect(agentFiles.length).toBeGreaterThan(0);
    }
  });

  it('creates memory directory', () => {
    runCli('init --yes --provider none --force', testDir);
    expect(existsSync(join(testDir, '.agents', 'memory'))).toBe(true);
  });

  it('creates provider config', () => {
    runCli('init --yes --provider none --force', testDir);
    expect(existsSync(join(testDir, '.agents', 'config', 'provider.yaml'))).toBe(true);
  });

  it('shows next steps in output', () => {
    const result = runCli('init --yes --provider none --force', testDir);
    const out = stripAnsi(result.stdout);
    // Should mention at least one next step command
    expect(out).toMatch(/squads (status|run|dash)/);
  });
});

describe('E2E: squads status workflow', () => {
  let testDir: string;
  let squads: string[];

  beforeEach(() => {
    testDir = join(tmpdir(), `squads-e2e-status-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    execSync('git init -q', { cwd: testDir });
    // Set up a project via init
    runCli('init --yes --provider none --force', testDir);
    squads = getCreatedSquads(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits with code 0 when squads exist', () => {
    const result = runCli('status', testDir);
    expect(result.exitCode).toBe(0);
  });

  it('shows squad count', () => {
    const result = runCli('status', testDir);
    const out = stripAnsi(result.stdout);
    expect(out).toMatch(/\d+\/\d+\s+squads/);
  });

  it('lists initialized squads in table', () => {
    const result = runCli('status', testDir);
    const out = stripAnsi(result.stdout);
    // At least one created squad should appear in the status table
    const foundSquad = squads.some(squad => out.includes(squad));
    expect(foundSquad).toBe(true);
  });

  it('shows agent count for squads', () => {
    const result = runCli('status', testDir);
    const out = stripAnsi(result.stdout);
    // Should show numbers (agent counts) in the table
    expect(out).toMatch(/\d+/);
  });

  it('shows helpful commands in footer', () => {
    const result = runCli('status', testDir);
    const out = stripAnsi(result.stdout);
    expect(out).toContain('squads run');
  });

  it('exits with error when no squads directory exists', () => {
    const emptyDir = join(tmpdir(), `squads-e2e-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      const result = runCli('status', emptyDir);
      expect(result.exitCode).not.toBe(0);
      const out = stripAnsi(result.stdout + result.stderr);
      expect(out).toContain('squads init');
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('shows specific squad details with squad argument', () => {
    const targetSquad = squads[0];
    const result = runCli(`status ${targetSquad}`, testDir);
    const out = stripAnsi(result.stdout);
    expect(out.length).toBeGreaterThan(0);
    expect(result.exitCode).toBe(0);
  });
});

describe('E2E: squads run workflow', () => {
  let testDir: string;
  let squads: string[];

  beforeEach(() => {
    testDir = join(tmpdir(), `squads-e2e-run-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    execSync('git init -q', { cwd: testDir });
    runCli('init --yes --provider none --force', testDir);
    squads = getCreatedSquads(testDir);
  });

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('exits with code 0 in dry-run mode', () => {
    const targetSquad = squads[0];
    const result = runCli(`run ${targetSquad} --dry-run`, testDir);
    expect(result.exitCode).toBe(0);
  });

  it('shows squad name in dry-run output', () => {
    const targetSquad = squads[0];
    const result = runCli(`run ${targetSquad} --dry-run`, testDir);
    const out = stripAnsi(result.stdout);
    expect(out).toContain(targetSquad);
  });

  it('shows agents in dry-run output', () => {
    const targetSquad = squads[0];
    const result = runCli(`run ${targetSquad} --dry-run`, testDir);
    const out = stripAnsi(result.stdout);
    // Should contain at least one agent name from the squad
    const squadDir = join(testDir, '.agents', 'squads', targetSquad);
    const agentFiles = (readdirSync(squadDir) as string[]).filter(
      (f: string) => f.endsWith('.md') && f !== 'SQUAD.md'
    );
    const agentNames = agentFiles.map((f: string) => f.replace('.md', ''));
    const foundAgent = agentNames.some((name: string) => out.includes(name));
    expect(foundAgent).toBe(true);
  });

  it('exits with code 0 in dry-run mode (second squad)', () => {
    // Verify dry-run works for another squad if multiple exist
    if (squads.length < 2) return;
    const targetSquad = squads[1];
    const result = runCli(`run ${targetSquad} --dry-run`, testDir);
    expect(result.exitCode).toBe(0);
  });

  it('exits with error for unknown squad', () => {
    const result = runCli('run nonexistent-squad --dry-run', testDir);
    expect(result.exitCode).not.toBe(0);
  });

  it('exits with error when no squads directory exists', () => {
    const emptyDir = join(tmpdir(), `squads-e2e-run-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    try {
      const result = runCli('run demo --dry-run', emptyDir);
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('shows post-run guidance in output', () => {
    const targetSquad = squads[0];
    const result = runCli(`run ${targetSquad} --dry-run`, testDir);
    const out = stripAnsi(result.stdout);
    // Should mention feedback or next steps after run
    expect(out).toContain('feedback');
  });
});
