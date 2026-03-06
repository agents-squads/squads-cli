import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/auth.js', () => ({
  isPersonalEmail: vi.fn(),
  getEmailDomain: vi.fn().mockReturnValue('example.com'),
  saveSession: vi.fn(),
  loadSession: vi.fn(),
  clearSession: vi.fn(),
  startAuthCallbackServer: vi.fn(),
}));

vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
}));

vi.mock('chalk', () => {
  const bold = Object.assign((s: string) => s, {
    cyan: (s: string) => s,
    magenta: (s: string) => s,
  });
  return {
    default: {
      green: (s: string) => s,
      yellow: (s: string) => s,
      red: (s: string) => s,
      cyan: (s: string) => s,
      dim: (s: string) => s,
      bold,
    },
  };
});

import { logoutCommand, whoamiCommand } from '../../src/commands/login.js';
import { loadSession, clearSession } from '../../src/lib/auth.js';

const mockLoadSession = vi.mocked(loadSession);
const mockClearSession = vi.mocked(clearSession);

describe('logoutCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when not logged in', async () => {
    mockLoadSession.mockReturnValue(null);

    await expect(logoutCommand()).resolves.toBeUndefined();
    expect(mockClearSession).not.toHaveBeenCalled();
  });

  it('clears session when logged in', async () => {
    mockLoadSession.mockReturnValue({
      email: 'user@company.com',
      domain: 'company.com',
      status: 'active',
      createdAt: new Date().toISOString(),
      accessToken: 'tok',
    });

    await expect(logoutCommand()).resolves.toBeUndefined();
    expect(mockClearSession).toHaveBeenCalledOnce();
  });
});

describe('whoamiCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handles not logged in state', async () => {
    mockLoadSession.mockReturnValue(null);

    await expect(whoamiCommand()).resolves.toBeUndefined();
  });

  it('displays active session info', async () => {
    mockLoadSession.mockReturnValue({
      email: 'jorge@company.com',
      domain: 'company.com',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessToken: 'tok123',
    });

    await expect(whoamiCommand()).resolves.toBeUndefined();
  });

  it('displays pending session info', async () => {
    mockLoadSession.mockReturnValue({
      email: 'jorge@company.com',
      domain: 'company.com',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      accessToken: 'tok456',
    });

    await expect(whoamiCommand()).resolves.toBeUndefined();
  });
});
