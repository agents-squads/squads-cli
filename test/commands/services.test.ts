import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Command } from 'commander';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execSync: vi.fn() };
});
vi.mock('../../src/lib/tier-detect.js', () => ({ detectTier: vi.fn() }));
vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', cyan: '', white: '', purple: '' },
  bold: '', RESET: '',
}));

import { execSync } from 'child_process';
import { detectTier } from '../../src/lib/tier-detect.js';
import { writeLine } from '../../src/lib/terminal.js';
import { registerServicesCommands } from '../../src/commands/services.js';

const mockExec = vi.mocked(execSync);
const mockTier = vi.mocked(detectTier);
const mockWrite = vi.mocked(writeLine);
const output = () => mockWrite.mock.calls.map(c => String(c[0] ?? '')).join('\n');
const prog = () => { const p = new Command(); p.exitOverride(); registerServicesCommands(p); return p; };

const tier1 = { tier: 1 as const, services: { api: false, bridge: false, postgres: false, redis: false }, urls: { api: null, bridge: null } };
const tier2 = { tier: 2 as const, services: { api: true, bridge: true, postgres: true, redis: true }, urls: { api: 'http://localhost:8090', bridge: 'http://localhost:8088' } };

describe('services commands', () => {
  let tmpDir: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = mkdtempSync(join(tmpdir(), 'svc-'));
    savedHome = process.env.HOME;
    mockTier.mockResolvedValue(tier1);
    mockExec.mockImplementation(() => { throw new Error('not found'); });
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('services up', () => {
    it('errors when Docker unavailable', async () => {
      await prog().parseAsync(['node', 'squads', 'services', 'up']);
      expect(output()).toMatch(/Docker not found/i);
    });

    it('errors when Docker Compose unavailable', async () => {
      mockExec.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes('docker --version')) return 'Docker 24.0' as never;
        throw new Error('not found');
      });
      await prog().parseAsync(['node', 'squads', 'services', 'up']);
      expect(output()).toMatch(/Docker Compose not found/i);
    });

    it('errors when compose file missing (real empty HOME)', async () => {
      mockExec.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes('docker --version') || String(cmd).includes('docker compose version')) return 'ok' as never;
        throw new Error('not found');
      });
      process.env.HOME = tmpDir;
      await prog().parseAsync(['node', 'squads', 'services', 'up']);
      expect(output()).toMatch(/docker-compose\.yml not found/i);
    });

    it('starts services with real compose file', async () => {
      const dir = join(tmpDir, 'agents-squads', 'engineering', 'docker');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'docker-compose.yml'), 'version: "3"\nservices:\n  pg:\n    image: postgres\n');
      process.env.HOME = tmpDir;
      mockExec.mockImplementation((cmd: unknown) => {
        const c = String(cmd);
        if (c.includes('docker --version') || c.includes('docker compose version') || c.includes('up')) return '' as never;
        throw new Error('not found');
      });
      mockTier.mockResolvedValue(tier2);
      await prog().parseAsync(['node', 'squads', 'services', 'up']);
      expect(output()).toContain('Tier 2 active');
    });
  });

  describe('services down', () => {
    it('shows nothing-to-stop when no compose file', async () => {
      process.env.HOME = tmpDir;
      await prog().parseAsync(['node', 'squads', 'services', 'down']);
      expect(output()).toMatch(/nothing to stop|not found/i);
    });
  });

  describe('services status', () => {
    it('shows no containers when docker ps fails', async () => {
      await prog().parseAsync(['node', 'squads', 'services', 'status']);
      expect(output()).toMatch(/no docker containers/i);
    });

    it('displays container names from docker ps', async () => {
      mockTier.mockResolvedValue(tier2);
      mockExec.mockImplementation((cmd: unknown) => {
        if (String(cmd).includes('docker ps')) return 'squads-pg\tUp 5m (healthy)\t5432/tcp' as never;
        throw new Error('not found');
      });
      await prog().parseAsync(['node', 'squads', 'services', 'status']);
      expect(output()).toContain('squads-pg');
    });
  });

  describe('command structure', () => {
    it('registers up/down/status with correct options', () => {
      const svc = prog().commands.find(c => c.name() === 'services')!;
      expect(svc.commands.map(c => c.name())).toEqual(expect.arrayContaining(['up', 'down', 'status']));
      const upOpts = svc.commands.find(c => c.name() === 'up')!.options.map(o => o.long);
      expect(upOpts).toContain('--webhooks');
      expect(upOpts).toContain('--telemetry');
    });
  });
});
