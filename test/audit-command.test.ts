import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { auditCommand } from '../src/commands/audit.js';

let root: string;
let out: string;
let err: string;
const savedEnv = process.env.SQUADS_ORG_ROOT;
const savedExit = process.exitCode;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-audit-cmd-'));
  out = '';
  err = '';
  process.exitCode = undefined;
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedEnv === undefined) delete process.env.SQUADS_ORG_ROOT;
  else process.env.SQUADS_ORG_ROOT = savedEnv;
  process.exitCode = savedExit;
  rmSync(root, { recursive: true, force: true });
});

function unitWithMetric(name: string, command: string): void {
  const dir = join(root, name);
  mkdirSync(dir);
  spawnSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(join(dir, 'AGENTS.md'), `---\nkind: domain\nlifecycle: active\n---\n\n## Metric\n\n\`\`\`sh\n${command}\n\`\`\`\n`);
}

describe('squads audit (command)', () => {
  it('--json emits the report with units and summary', async () => {
    process.env.SQUADS_ORG_ROOT = root;
    mkdirSync(join(root, 'scratch'));
    writeFileSync(join(root, 'scratch', 'n.txt'), 'x');
    await auditCommand({ json: true });
    const report = JSON.parse(out);
    expect(report.units.map((u: { name: string }) => u.name)).toEqual(['scratch']);
    expect(report.summary.units).toBe(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('--propose includes drafted proposals in the JSON', async () => {
    process.env.SQUADS_ORG_ROOT = root;
    mkdirSync(join(root, 'scratch'));
    writeFileSync(join(root, 'scratch', 'n.txt'), 'x');
    await auditCommand({ json: true, propose: true });
    expect(JSON.parse(out).proposals.length).toBeGreaterThan(0);
  });

  it('L9: no org root prints the JSON error and exits non-zero', async () => {
    delete process.env.SQUADS_ORG_ROOT;
    const bare = join(root, 'bare');
    mkdirSync(bare);
    vi.spyOn(process, 'cwd').mockReturnValue(bare);
    await auditCommand({ json: true });
    expect(JSON.parse(out).error).toBe('no-org-root');
    expect(process.exitCode).toBe(2);
  });

  it('L12: an explicit but invalid SQUADS_ORG_ROOT is an error, not a silent fallback', async () => {
    process.env.SQUADS_ORG_ROOT = join(root, 'does-not-exist');
    await auditCommand({ json: true });
    expect(JSON.parse(out).error).toBe('invalid-org-root');
    expect(process.exitCode).toBe(2);
  });

  it('S1: --run-metrics without --yes lists the commands, runs nothing, exits non-zero', async () => {
    process.env.SQUADS_ORG_ROOT = root;
    const marker = join(root, 'ran.marker');
    unitWithMetric('u', `touch '${marker}'; echo 1`);
    await auditCommand({ json: true, runMetrics: true });
    expect(existsSync(marker)).toBe(false);
    expect(err).toContain(`touch '${marker}'`);
    expect(process.exitCode).toBe(2);
  });

  it('S1: --run-metrics --yes runs the commands', async () => {
    process.env.SQUADS_ORG_ROOT = root;
    const marker = join(root, 'ran.marker');
    unitWithMetric('u', `touch '${marker}'; echo 1`);
    await auditCommand({ json: true, runMetrics: true, yes: true });
    expect(existsSync(marker)).toBe(true);
    expect(err).toContain(`touch '${marker}'`);
    expect(process.exitCode).toBeUndefined();
  });
});
