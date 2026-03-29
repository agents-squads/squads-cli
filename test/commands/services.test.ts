import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// All mocks must be hoisted before any imports from the modules under test.
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock('../../src/lib/tier-detect.js', () => ({
  detectTier: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '',
    red: '',
    green: '',
    yellow: '',
    cyan: '',
    white: '',
    purple: '',
  },
  bold: '',
  RESET: '',
  gradient: vi.fn((s: string) => s),
  padEnd: vi.fn((s: string, n: number) => s.padEnd(n)),
  icons: {
    success: '✓',
    error: '✗',
    warning: '!',
    progress: '›',
    empty: '○',
  },
}));

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { detectTier } from '../../src/lib/tier-detect.js';
import { writeLine } from '../../src/lib/terminal.js';
import { registerServicesCommands } from '../../src/commands/services.js';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(existsSync);
const mockDetectTier = vi.mocked(detectTier);
const mockWriteLine = vi.mocked(writeLine);

const tier1Info = {
  tier: 1 as const,
  services: { api: false, bridge: false, postgres: false, redis: false },
  urls: { api: null, bridge: null },
};

const tier2Info = {
  tier: 2 as const,
  services: { api: true, bridge: true, postgres: true, redis: true },
  urls: { api: 'http://localhost:8090', bridge: 'http://localhost:8088' },
};

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  registerServicesCommands(program);
  return program;
}

describe('services up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: Docker unavailable, no compose file
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    mockExistsSync.mockReturnValue(false);
    mockDetectTier.mockResolvedValue(tier1Info);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows error and exits gracefully when Docker is unavailable', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'up']);

    const calls = mockWriteLine.mock.calls.map(c => String(c[0] ?? ''));
    const combined = calls.join('\n');
    expect(combined).toMatch(/Docker not found/i);
    // Should NOT throw — graceful exit
  });

  it('shows Docker Desktop install hint when Docker is unavailable', async () => {
    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'up']);

    const calls = mockWriteLine.mock.calls.map(c => String(c[0] ?? ''));
    const combined = calls.join('\n');
    expect(combined).toMatch(/docker\.com/i);
  });

  it('shows error when Docker Compose is unavailable (Docker present)', async () => {
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('docker --version')) return 'Docker version 24.0.0';
      throw new Error('command not found');
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'up']);

    const calls = mockWriteLine.mock.calls.map(c => String(c[0] ?? ''));
    const combined = calls.join('\n');
    expect(combined).toMatch(/Docker Compose not found/i);
  });

  it('shows error with expected path when compose file is missing', async () => {
    // Docker and Compose available, but no compose file on disk
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('docker --version') || c.includes('docker compose version')) {
        return 'ok';
      }
      throw new Error('command not found');
    });
    mockExistsSync.mockReturnValue(false);

    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'up']);

    const calls = mockWriteLine.mock.calls.map(c => String(c[0] ?? ''));
    const combined = calls.join('\n');
    expect(combined).toMatch(/docker-compose\.yml not found/i);
    expect(combined).toMatch(/engineering\/docker/i);
  });

  it('registers the services up subcommand', () => {
    const program = buildProgram();
    const serviceCmd = program.commands.find(c => c.name() === 'services');
    expect(serviceCmd).toBeDefined();
    const upCmd = serviceCmd?.commands.find(c => c.name() === 'up');
    expect(upCmd).toBeDefined();
    expect(upCmd?.description()).toMatch(/start/i);
  });
});

describe('services down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });
    mockExistsSync.mockReturnValue(false);
    mockDetectTier.mockResolvedValue(tier1Info);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "nothing to stop" message when compose file is missing', async () => {
    mockExistsSync.mockReturnValue(false);

    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'down']);

    const calls = mockWriteLine.mock.calls.map(c => String(c[0] ?? ''));
    const combined = calls.join('\n');
    expect(combined).toMatch(/nothing to stop/i);
  });

  it('resolves gracefully when compose file is absent', async () => {
    const program = buildProgram();
    await expect(
      program.parseAsync(['node', 'squads', 'services', 'down'])
    ).resolves.toBeDefined();
  });

  it('registers the services down subcommand', () => {
    const program = buildProgram();
    const serviceCmd = program.commands.find(c => c.name() === 'services');
    const downCmd = serviceCmd?.commands.find(c => c.name() === 'down');
    expect(downCmd).toBeDefined();
    expect(downCmd?.description()).toMatch(/stop/i);
  });
});

describe('services status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // docker ps returns null (no running containers)
    mockExecSync.mockReturnValue(null as unknown as ReturnType<typeof execSync>);
    mockDetectTier.mockResolvedValue(tier1Info);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows "no containers running" when docker ps returns nothing', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'status']);

    const calls = mockWriteLine.mock.calls.map(c => String(c[0] ?? ''));
    const combined = calls.join('\n');
    expect(combined).toMatch(/no docker containers running/i);
  });

  it('shows tier info from detectTier even when no containers', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('command not found');
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'status']);

    expect(mockDetectTier).toHaveBeenCalledOnce();
  });

  it('displays container names when docker ps returns results', async () => {
    mockDetectTier.mockResolvedValue(tier2Info);
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('docker ps')) {
        return 'squads-postgres\tUp 5 minutes (healthy)\t0.0.0.0:5432->5432/tcp';
      }
      // psql queries return null (throw)
      throw new Error('not found');
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'status']);

    const calls = mockWriteLine.mock.calls.map(c => String(c[0] ?? ''));
    const combined = calls.join('\n');
    expect(combined).toContain('squads-postgres');
  });

  it('shows Tier 2 when api is healthy', async () => {
    mockDetectTier.mockResolvedValue(tier2Info);
    mockExecSync.mockImplementation((cmd: unknown) => {
      const c = String(cmd);
      if (c.includes('docker ps')) {
        return 'squads-api\tUp 2 minutes (healthy)\t0.0.0.0:8090->8090/tcp';
      }
      throw new Error('not found');
    });

    const program = buildProgram();
    await program.parseAsync(['node', 'squads', 'services', 'status']);

    const calls = mockWriteLine.mock.calls.map(c => String(c[0] ?? ''));
    const combined = calls.join('\n');
    expect(combined).toMatch(/tier 2/i);
  });

  it('registers the services status subcommand', () => {
    const program = buildProgram();
    const serviceCmd = program.commands.find(c => c.name() === 'services');
    const statusCmd = serviceCmd?.commands.find(c => c.name() === 'status');
    expect(statusCmd).toBeDefined();
    expect(statusCmd?.description()).toMatch(/health|show|running/i);
  });
});

describe('services command structure', () => {
  it('registers services command with correct description', () => {
    const program = buildProgram();
    const serviceCmd = program.commands.find(c => c.name() === 'services');
    expect(serviceCmd).toBeDefined();
    expect(serviceCmd?.description()).toMatch(/tier 2|docker|services/i);
  });

  it('registers all three subcommands: up, down, status', () => {
    const program = buildProgram();
    const serviceCmd = program.commands.find(c => c.name() === 'services');
    const names = serviceCmd?.commands.map(c => c.name()) ?? [];
    expect(names).toContain('up');
    expect(names).toContain('down');
    expect(names).toContain('status');
  });

  it('services up supports --webhooks flag', () => {
    const program = buildProgram();
    const serviceCmd = program.commands.find(c => c.name() === 'services');
    const upCmd = serviceCmd?.commands.find(c => c.name() === 'up');
    const options = upCmd?.options.map(o => o.long) ?? [];
    expect(options).toContain('--webhooks');
  });

  it('services up supports --telemetry flag', () => {
    const program = buildProgram();
    const serviceCmd = program.commands.find(c => c.name() === 'services');
    const upCmd = serviceCmd?.commands.find(c => c.name() === 'up');
    const options = upCmd?.options.map(o => o.long) ?? [];
    expect(options).toContain('--telemetry');
  });
});
