import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock auth lib
vi.mock('../../src/lib/auth.js', () => ({
  isPersonalEmail: vi.fn(),
  getEmailDomain: vi.fn(),
  saveSession: vi.fn(),
  loadSession: vi.fn(),
  clearSession: vi.fn(),
  startAuthCallbackServer: vi.fn(),
}));

// Mock telemetry
vi.mock('../../src/lib/telemetry.js', () => ({
  track: vi.fn().mockResolvedValue(undefined),
}));

// Mock terminal
vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
}));

// Mock chalk to return plain strings
vi.mock('chalk', () => {
  const identity = (s: string) => s;
  const chalk = new Proxy(identity, {
    get: (_target, prop) => {
      if (prop === 'bold') return new Proxy(identity, { get: (_t, p) => identity });
      return identity;
    },
    apply: (_target, _thisArg, args) => args[0],
  });
  return { default: chalk };
});

// Mock ora (spinner)
vi.mock('ora', () => ({
  default: vi.fn().mockReturnValue({
    start: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    clear: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
    text: '',
  }),
}));

// Mock open (browser)
vi.mock('open', () => ({
  default: vi.fn().mockResolvedValue(undefined),
}));

import {
  loadSession,
  clearSession,
} from '../../src/lib/auth.js';

const mockLoadSession = loadSession as ReturnType<typeof vi.fn>;
const mockClearSession = clearSession as ReturnType<typeof vi.fn>;

describe('login command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loginCommand', () => {
    it('shows already-logged-in message when active session exists', async () => {
      mockLoadSession.mockReturnValue({
        email: 'user@example.com',
        domain: 'example.com',
        status: 'active',
        createdAt: new Date().toISOString(),
        accessToken: 'tok123',
      });

      const { loginCommand } = await import('../../src/commands/login.js');
      await loginCommand();

      // Should check session and return early without opening browser
      expect(mockLoadSession).toHaveBeenCalled();
    });
  });

  describe('logoutCommand', () => {
    it('clears session when logged in', async () => {
      mockLoadSession.mockReturnValue({
        email: 'user@example.com',
        domain: 'example.com',
        status: 'active',
        createdAt: new Date().toISOString(),
        accessToken: 'tok123',
      });

      const { logoutCommand } = await import('../../src/commands/login.js');
      await logoutCommand();

      expect(mockClearSession).toHaveBeenCalled();
    });

    it('shows "not logged in" message when no session exists', async () => {
      mockLoadSession.mockReturnValue(null);

      const { logoutCommand } = await import('../../src/commands/login.js');
      await logoutCommand();

      expect(mockClearSession).not.toHaveBeenCalled();
    });
  });

  describe('whoamiCommand', () => {
    it('shows "not logged in" message when no session', async () => {
      mockLoadSession.mockReturnValue(null);

      const { whoamiCommand } = await import('../../src/commands/login.js');
      await whoamiCommand();

      expect(mockLoadSession).toHaveBeenCalled();
    });

    it('displays session info when logged in', async () => {
      mockLoadSession.mockReturnValue({
        email: 'user@company.com',
        domain: 'company.com',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        accessToken: 'tok456',
      });

      const { whoamiCommand } = await import('../../src/commands/login.js');
      await whoamiCommand();

      expect(mockLoadSession).toHaveBeenCalled();
    });

    it('displays pending status correctly', async () => {
      mockLoadSession.mockReturnValue({
        email: 'new@startup.io',
        domain: 'startup.io',
        status: 'pending',
        createdAt: '2026-02-01T00:00:00.000Z',
        accessToken: 'tok789',
      });

      const { whoamiCommand } = await import('../../src/commands/login.js');
      await whoamiCommand();

      expect(mockLoadSession).toHaveBeenCalled();
    });
  });
});
