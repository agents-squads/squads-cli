import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';

import { findOrgRoot, listOrgUnits } from '../src/lib/org-root.js';

let root: string;
const ENV_KEYS = ['SQUADS_ORG_ROOT', 'SQUADS_ORG_CONTROL_REPO'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'squads-org-root-'));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(root, { recursive: true, force: true });
});

describe('findOrgRoot', () => {
  it('honors the SQUADS_ORG_ROOT env override', () => {
    const ws = join(root, 'workspace');
    mkdirSync(ws, { recursive: true });
    process.env.SQUADS_ORG_ROOT = ws;
    const org = findOrgRoot(join(root, 'elsewhere'));
    expect(org).not.toBeNull();
    expect(org!.root).toBe(realpathSync(ws));
    expect(org!.source).toBe('env');
  });

  it('walks up to the directory containing the control repo (default hq)', () => {
    const ws = join(root, 'workspace');
    mkdirSync(join(ws, 'hq'), { recursive: true });
    const nested = join(ws, 'app', 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    const org = findOrgRoot(nested);
    expect(org!.root).toBe(realpathSync(ws));
    expect(org!.source).toBe('control-repo');
    expect(org!.controlRepo).toBe('hq');
  });

  it('supports a configurable control repo name', () => {
    const ws = join(root, 'workspace');
    mkdirSync(join(ws, 'control'), { recursive: true });
    process.env.SQUADS_ORG_CONTROL_REPO = 'control';
    const org = findOrgRoot(join(ws, 'app'));
    expect(org!.root).toBe(realpathSync(ws));
    expect(org!.controlRepo).toBe('control');
  });

  it('falls back to the parent of the nearest squads project root', () => {
    const ws = join(root, 'workspace');
    const proj = join(ws, 'myproj');
    mkdirSync(join(proj, '.agents', 'squads'), { recursive: true });
    const org = findOrgRoot(join(proj, 'sub', 'dir'));
    expect(org!.root).toBe(realpathSync(ws));
    expect(org!.source).toBe('squads-project');
  });

  it('returns null when no workspace structure exists', () => {
    const bare = join(root, 'bare');
    mkdirSync(bare, { recursive: true });
    expect(findOrgRoot(bare)).toBeNull();
  });
});

describe('listOrgUnits', () => {
  it('lists non-hidden subdirectories sorted by name', () => {
    mkdirSync(join(root, 'beta'));
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, '.hidden'));
    expect(listOrgUnits(root)).toEqual(['alpha', 'beta']);
  });
});
