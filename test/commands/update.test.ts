import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock lib/update.js before any imports
vi.mock('../../src/lib/update.js', () => ({
  refreshVersionCache: vi.fn(),
  performUpdate: vi.fn(),
}));

// Mock terminal output to suppress noise
vi.mock('../../src/lib/terminal.js', () => ({
  writeLine: vi.fn(),
  colors: {
    dim: '',
    cyan: '',
    green: '',
    red: '',
  },
  RESET: '',
  gradient: (s: string) => s,
  icons: { success: '✓', error: '✗' },
}));

import { updateCommand } from '../../src/commands/update.js';
import { refreshVersionCache, performUpdate } from '../../src/lib/update.js';

const mockRefreshVersionCache = refreshVersionCache as ReturnType<typeof vi.fn>;
const mockPerformUpdate = performUpdate as ReturnType<typeof vi.fn>;

describe('updateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('--check mode', () => {
    it('shows up-to-date message when no update available', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
      });

      await updateCommand({ check: true });

      expect(mockRefreshVersionCache).toHaveBeenCalledOnce();
      expect(mockPerformUpdate).not.toHaveBeenCalled();
    });

    it('shows update available message when newer version exists', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        updateAvailable: true,
      });

      await updateCommand({ check: true });

      expect(mockRefreshVersionCache).toHaveBeenCalledOnce();
      expect(mockPerformUpdate).not.toHaveBeenCalled();
    });
  });

  describe('update mode', () => {
    it('exits early when already on latest version', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
      });

      await updateCommand({});

      expect(mockRefreshVersionCache).toHaveBeenCalledOnce();
      expect(mockPerformUpdate).not.toHaveBeenCalled();
    });

    it('performs update when --yes flag is set and update is available', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        updateAvailable: true,
      });
      mockPerformUpdate.mockReturnValue({ success: true });

      await updateCommand({ yes: true });

      expect(mockRefreshVersionCache).toHaveBeenCalledOnce();
      expect(mockPerformUpdate).toHaveBeenCalledOnce();
    });

    it('shows error message when update fails', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '1.1.0',
        updateAvailable: true,
      });
      mockPerformUpdate.mockReturnValue({
        success: false,
        error: 'permission denied',
      });

      await updateCommand({ yes: true });

      expect(mockPerformUpdate).toHaveBeenCalledOnce();
    });

    it('skips update when user declines (options.yes = false, no update)', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
      });

      await updateCommand({ yes: false });

      expect(mockPerformUpdate).not.toHaveBeenCalled();
    });
  });
});
