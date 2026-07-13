import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/auth.js', () => ({
  loadSession: vi.fn(),
  isLoggedIn: vi.fn(),
}));

vi.mock('../../src/lib/env-config.js', () => ({
  getApiUrl: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: { dim: '', red: '', green: '', yellow: '', cyan: '', white: '' },
  bold: '',
  RESET: '',
  dim: '',
}));

import { briefCommand } from '../../src/commands/brief.js';
import { loadSession, isLoggedIn } from '../../src/lib/auth.js';
import { getApiUrl } from '../../src/lib/env-config.js';
import { writeLine } from '../../src/lib/terminal.js';

const mockLoadSession = vi.mocked(loadSession);
const mockIsLoggedIn = vi.mocked(isLoggedIn);
const mockGetApiUrl = vi.mocked(getApiUrl);
const mockWriteLine = vi.mocked(writeLine);

describe('brief command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows not connected message when not logged in', async () => {
    mockIsLoggedIn.mockReturnValue(false);
    await briefCommand({ json: false });
    expect(mockWriteLine).toHaveBeenCalledWith(
      expect.stringContaining('Not connected to squads API')
    );
  });

  it('shows not connected message when API URL is empty', async () => {
    mockIsLoggedIn.mockReturnValue(true);
    mockLoadSession.mockReturnValue({
      email: 'test@example.com',
      domain: 'example.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'token',
    });
    mockGetApiUrl.mockReturnValue('');

    await briefCommand({ json: false });

    expect(mockWriteLine).toHaveBeenCalledWith(
      expect.stringContaining('Not connected to squads API')
    );
  });

  it('shows not connected message when API request fails', async () => {
    mockIsLoggedIn.mockReturnValue(true);
    mockLoadSession.mockReturnValue({
      email: 'test@example.com',
      domain: 'example.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'token',
    });
    mockGetApiUrl.mockReturnValue('https://api.agents-squads.com');

    // Mock fetch to fail
    global.fetch = vi.fn(() => Promise.resolve(new Response('Unauthorized', { status: 401 })));

    await briefCommand({ json: false });

    expect(mockWriteLine).toHaveBeenCalledWith(
      expect.stringContaining('Not connected to squads API')
    );
  });

  it('renders brief successfully when API returns data', async () => {
    mockIsLoggedIn.mockReturnValue(true);
    mockLoadSession.mockReturnValue({
      email: 'test@example.com',
      domain: 'example.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'token',
    });
    mockGetApiUrl.mockReturnValue('https://api.agents-squads.com');

    const mockData = {
      cost_today_usd: 1.23,
      pending_approvals: 2,
      recent_activity: [
        {
          timestamp: new Date().toISOString(),
          title: 'Test approval',
          type: 'approval',
          status: 'pending',
          squad: 'cli',
          agent: 'solver',
        },
        {
          timestamp: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
          title: 'Completed task',
          type: 'task',
          status: 'completed',
          squad: 'cli',
          agent: 'builder',
        },
      ],
      running_agents: 3,
      squads_active: 4,
      squads_total: 5,
    };

    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => mockData,
      } as Response)
    );

    await briefCommand({ json: false });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.agents-squads.com/api/dashboard/summary',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token',
        }),
      })
    );
  });

  it('outputs JSON when --json flag is provided', async () => {
    mockIsLoggedIn.mockReturnValue(true);
    mockLoadSession.mockReturnValue({
      email: 'test@example.com',
      domain: 'example.com',
      status: 'active',
      createdAt: '2024-01-01',
      accessToken: 'token',
    });
    mockGetApiUrl.mockReturnValue('https://api.agents-squads.com');

    const mockData = {
      cost_today_usd: 1.23,
      pending_approvals: 0,
      recent_activity: [
        {
          timestamp: new Date().toISOString(),
          title: 'Test task',
          type: 'task',
          status: 'completed',
          squad: 'cli',
        },
      ],
      running_agents: 1,
      squads_active: 2,
      squads_total: 3,
    };

    global.fetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => mockData,
      } as Response)
    );

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await briefCommand({ json: true });

    expect(consoleLogSpy).toHaveBeenCalled();
    const jsonOutput = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
    expect(jsonOutput).toHaveProperty('delivered');
    expect(jsonOutput).toHaveProperty('needsYou');
    expect(jsonOutput).toHaveProperty('pending');
    expect(jsonOutput).toHaveProperty('summary');

    consoleLogSpy.mockRestore();
  });
});
