import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('open', () => ({ default: vi.fn().mockResolvedValue(undefined) }));

vi.mock('ora', () => ({
  default: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    clear: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    text: '',
  })),
}));

vi.mock('../../src/lib/auth.js', () => ({
  isAuthConfigured: vi.fn(),
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

import { loginCommand, logoutCommand, whoamiCommand } from '../../src/commands/login.js';
import {
  loadSession,
  clearSession,
  saveSession,
  startAuthCallbackServer,
  isAuthConfigured,
} from '../../src/lib/auth.js';
import { writeLine } from '../../src/lib/terminal.js';

const mockLoadSession = vi.mocked(loadSession);
const mockClearSession = vi.mocked(clearSession);
const mockSaveSession = vi.mocked(saveSession);
const mockStartAuthCallbackServer = vi.mocked(startAuthCallbackServer);
const mockIsAuthConfigured = vi.mocked(isAuthConfigured);
const mockWriteLine = vi.mocked(writeLine);

describe('loginCommand', () => {
  const originalAuthUrl = process.env.SQUADS_AUTH_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SQUADS_AUTH_URL;
  });

  afterEach(() => {
    if (originalAuthUrl === undefined) delete process.env.SQUADS_AUTH_URL;
    else process.env.SQUADS_AUTH_URL = originalAuthUrl;
  });

  it('prints the unavailable message and exits 0 when auth is not configured', async () => {
    mockIsAuthConfigured.mockReturnValue(false);

    await expect(loginCommand()).resolves.toBeUndefined();

    expect(mockWriteLine).toHaveBeenCalledWith('Cloud login is not available in this build.');
    // No probe, no callback server, no session written.
    expect(mockStartAuthCallbackServer).not.toHaveBeenCalled();
    expect(mockSaveSession).not.toHaveBeenCalled();
  });

  it('accepts a personal email and saves an active session when configured (#1208)', async () => {
    mockIsAuthConfigured.mockReturnValue(true);
    mockLoadSession.mockReturnValue(null);
    process.env.SQUADS_AUTH_URL = 'https://auth.example.com';
    // Auth endpoint probe succeeds.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    // Callback resolves with a personal email — must be accepted, not rejected.
    mockStartAuthCallbackServer.mockResolvedValue({ email: 'user@gmail.com', token: 'tok' });

    await expect(loginCommand()).resolves.toBeUndefined();

    expect(mockSaveSession).toHaveBeenCalledTimes(1);
    const session = mockSaveSession.mock.calls[0][0];
    expect(session.email).toBe('user@gmail.com');
    // No 'pending' state — a successful auth is an active session.
    expect(session.status).toBe('active');

    // The personal-email rejection copy must never appear.
    const rejectionShown = mockWriteLine.mock.calls
      .some(c => c[0]?.toString().includes('Personal emails not supported'));
    expect(rejectionShown).toBe(false);

    vi.unstubAllGlobals();
  });
});

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
});
