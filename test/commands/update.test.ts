import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/update.js', () => ({
  refreshVersionCache: vi.fn(),
  performUpdate: vi.fn(),
}));

vi.mock('../../src/lib/terminal.js', () => ({
  colors: { dim: '', cyan: '', green: '', red: '', yellow: '' },
  RESET: '',
  gradient: (s: string) => s,
  icons: { success: '✓', error: '✗' },
  writeLine: vi.fn(),
  bold: (s: string) => s,
  padEnd: (s: string, n: number) => s.padEnd(n),
  truncate: (s: string) => s,
}));

import { updateCommand } from '../../src/commands/update.js';
import { refreshVersionCache, performUpdate } from '../../src/lib/update.js';

const mockRefreshVersionCache = vi.mocked(refreshVersionCache);
const mockPerformUpdate = vi.mocked(performUpdate);

describe('updateCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('--check mode', () => {
    it('reports when already on latest version', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '1.0.0',
        updateAvailable: false,
      });

      await expect(updateCommand({ check: true })).resolves.toBeUndefined();
      expect(mockRefreshVersionCache).toHaveBeenCalledOnce();
      expect(mockPerformUpdate).not.toHaveBeenCalled();
    });

    it('reports when update is available', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '1.2.0',
        updateAvailable: true,
      });

      await expect(updateCommand({ check: true })).resolves.toBeUndefined();
      expect(mockRefreshVersionCache).toHaveBeenCalledOnce();
      expect(mockPerformUpdate).not.toHaveBeenCalled();
    });
  });

  describe('update flow', () => {
    it('exits early when already on latest version', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '2.0.0',
        latestVersion: '2.0.0',
        updateAvailable: false,
      });

      await expect(updateCommand({})).resolves.toBeUndefined();
      expect(mockPerformUpdate).not.toHaveBeenCalled();
    });

    it('performs update when --yes flag provided and update available', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
      });
      mockPerformUpdate.mockReturnValue({ success: true });

      await expect(updateCommand({ yes: true })).resolves.toBeUndefined();
      expect(mockPerformUpdate).toHaveBeenCalledOnce();
    });

    it('handles update failure gracefully', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '1.0.0',
        latestVersion: '2.0.0',
        updateAvailable: true,
      });
      mockPerformUpdate.mockReturnValue({ success: false, error: 'permission denied' });

      await expect(updateCommand({ yes: true })).resolves.toBeUndefined();
      expect(mockPerformUpdate).toHaveBeenCalledOnce();
    });

    it('does nothing when called with no options and already latest', async () => {
      mockRefreshVersionCache.mockReturnValue({
        currentVersion: '3.0.0',
        latestVersion: '3.0.0',
        updateAvailable: false,
      });

      await expect(updateCommand()).resolves.toBeUndefined();
      expect(mockRefreshVersionCache).toHaveBeenCalledOnce();
      expect(mockPerformUpdate).not.toHaveBeenCalled();
    });
  });
});
