import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

vi.mock('../../src/lib/run-utils.js', () => ({
  getProjectRoot: vi.fn(() => process.cwd()),
}));

vi.mock('../../src/lib/execution-engine.js', () => ({
  resolveOwnedRepoRoots: vi.fn((projectRoot: string) => [projectRoot]),
  harvestProviderWork: vi.fn(async () => ({ outcome: 'merged' })),
}));

import { runsCommand } from '../../src/commands/runs.js';
import { listDetachedRuns } from '../../src/lib/runs-inventory.js';

let root: string;

function writePidFile(squad: string, agent: string, ts: number, pid: number): string {
  const dir = join(root, '.agents', 'logs', squad);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${agent}-${ts}.pid`);
  writeFileSync(p, String(pid));
  return p;
}

function writeLogFile(squad: string, agent: string, ts: number, content: string): string {
  const dir = join(root, '.agents', 'logs', squad);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${agent}-${ts}.log`);
  writeFileSync(p, content);
  return p;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-runs-test-'));
  mkdirSync(join(root, '.agents', 'squads'), { recursive: true });
  mkdirSync(join(root, '.agents', 'observability'), { recursive: true });
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('runsCommand --wait', () => {
  it('exits with error when no live runs exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(runsCommand({ wait: true })).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('exits with error when specified run id does not exist', async () => {
    // Create a live run
    const ts = Date.now();
    writePidFile('research', 'housekeeper', ts, process.pid);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    await expect(runsCommand({ wait: 'nonexistent' })).rejects.toThrow('process.exit');
    exitSpy.mockRestore();
  });

  it('outputs JSON format when requested and run has completed', async () => {
    // Create a short-lived child process
    const ts = Date.now();
    const child = spawn('sh', ['-c', 'echo "test" && sleep 0.05'], { detached: true });
    const childPid = child.pid!;

    // Wait a bit for the child to start
    await new Promise(resolve => setTimeout(resolve, 10));

    // Write PID file with the child PID (will be dead by the time we poll)
    const pidFile = writePidFile('research', 'housekeeper', ts, childPid);

    // Write a log file with a completed result
    const logContent = JSON.stringify({
      type: 'result',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 }
    });
    writeFileSync(pidFile.replace('.pid', '.log'), logContent);

    // Wait for child to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runsCommand({ wait: 'research/housekeeper', json: true });

    expect(writeSpy).toHaveBeenCalled();
    const calls = writeSpy.mock.calls;
    // Find the JSON line (skip empty lines and formatting)
    const jsonLine = calls.map(c => String(c[0])).find(line => line.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine!);
    expect(parsed).toHaveProperty('status');
    expect(parsed).toHaveProperty('duration_s');
    expect(parsed).toHaveProperty('denials');

    writeSpy.mockRestore();
  });

  it('counts permission denials correctly', async () => {
    // Create a short-lived child process
    const ts = Date.now();
    const child = spawn('sh', ['-c', 'echo "test" && sleep 0.05'], { detached: true });
    const childPid = child.pid!;

    // Wait a bit for the child to start
    await new Promise(resolve => setTimeout(resolve, 10));

    const pidFile = writePidFile('research', 'housekeeper', ts, childPid);

    // Write a log file with permission denials
    const logContent = `
      Some log content
      "haven't granted it yet" - permission denied
      "haven't granted it yet" - another denial
      ${JSON.stringify({ type: 'result', stop_reason: 'end_turn' })}
    `;
    writeFileSync(pidFile.replace('.pid', '.log'), logContent);

    // Wait for child to complete
    await new Promise(resolve => setTimeout(resolve, 100));

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runsCommand({ wait: 'research/housekeeper', json: true });

    const calls = writeSpy.mock.calls;
    // Find the JSON line
    const jsonLine = calls.map(c => String(c[0])).find(line => line.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();

    const parsed = JSON.parse(jsonLine!);
    expect(parsed.denials).toBe(2);

    writeSpy.mockRestore();
  });
});
