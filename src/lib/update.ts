/**
 * Update checker for squads-cli
 * Checks npm registry for newer versions and caches result
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

// Get current version from package.json
function getPackageVersion(): string {
  try {
    // Try to find package.json relative to this module
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // Look up from dist/lib to find package.json
    const possiblePaths = [
      join(__dirname, '..', '..', 'package.json'),  // From dist/lib/
      join(__dirname, '..', 'package.json'),         // From dist/
      join(__dirname, 'package.json'),               // Same dir
    ];

    for (const pkgPath of possiblePaths) {
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.0.0';
      }
    }
  } catch {
    // Ignore errors
  }
  return '0.0.0';
}

const CURRENT_VERSION = getPackageVersion();

// Cache settings
const CACHE_DIR = join(homedir(), '.squads');
const CACHE_FILE = join(CACHE_DIR, 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCache {
  latestVersion: string;
  checkedAt: number;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}

/**
 * Compare semantic versions
 * Returns true if v2 > v1
 */
function isNewerVersion(v1: string, v2: string): boolean {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p2 > p1) return true;
    if (p2 < p1) return false;
  }
  return false;
}

/**
 * Read cached update info
 */
function readCache(): UpdateCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    return data as UpdateCache;
  } catch {
    return null;
  }
}

/**
 * Write update info to cache
 */
function writeCache(latestVersion: string): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    const cache: UpdateCache = {
      latestVersion,
      checkedAt: Date.now(),
    };
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore cache write errors
  }
}

/**
 * Fetch latest version from npm registry
 */
function fetchLatestVersion(): string | null {
  try {
    const result = execSync('npm view squads-cli version 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Check for updates (uses cache to avoid frequent npm calls)
 * Non-blocking: returns cached data immediately, triggers background refresh if stale
 */
export function checkForUpdate(): UpdateInfo {
  const result: UpdateInfo = {
    currentVersion: CURRENT_VERSION,
    latestVersion: CURRENT_VERSION,
    updateAvailable: false,
  };

  // Check cache first
  const cache = readCache();
  const now = Date.now();

  if (cache) {
    // Always use cached value immediately for fast response
    result.latestVersion = cache.latestVersion;
    result.updateAvailable = isNewerVersion(CURRENT_VERSION, cache.latestVersion);

    // If cache is stale, trigger background refresh (non-blocking)
    if ((now - cache.checkedAt) >= CACHE_TTL_MS) {
      // Fire and forget - don't await
      triggerBackgroundRefresh();
    }
    return result;
  }

  // No cache at all - trigger background refresh and return defaults
  triggerBackgroundRefresh();
  return result;
}

/**
 * Trigger a background version check that doesn't block the CLI
 * Uses spawn to run npm in a detached process
 */
function triggerBackgroundRefresh(): void {
  try {
    // Use spawn with detached: true to run in background
    // This won't block the main process
    const { spawn } = require('child_process') as typeof import('child_process');
    const child = spawn('npm', ['view', 'squads-cli', 'version'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: true,
    });

    // Collect output
    let output = '';
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    child.on('close', () => {
      const version = output.trim();
      if (version && /^\d+\.\d+\.\d+/.test(version)) {
        writeCache(version);
      }
    });

    // Unref to allow main process to exit
    child.unref();
  } catch {
    // Ignore errors - background refresh is best effort
  }
}

/**
 * Get current version
 */
export function getCurrentVersion(): string {
  return CURRENT_VERSION;
}

/**
 * Perform the actual update via npm
 * Returns true if successful
 */
export function performUpdate(): { success: boolean; error?: string } {
  try {
    execSync('npm update -g squads-cli', {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 120000, // 2 minutes
    });
    // Clear cache so next check fetches fresh
    try {
      unlinkSync(CACHE_FILE);
    } catch {
      // Ignore
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Force refresh the version cache (bypass TTL)
 */
export function refreshVersionCache(): UpdateInfo {
  const latestVersion = fetchLatestVersion();
  if (latestVersion) {
    writeCache(latestVersion);
    return {
      currentVersion: CURRENT_VERSION,
      latestVersion,
      updateAvailable: isNewerVersion(CURRENT_VERSION, latestVersion),
    };
  }
  return checkForUpdate();
}

// Auto-update settings
const AUTO_UPDATE_CACHE_FILE = join(CACHE_DIR, 'auto-update.json');
const AUTO_UPDATE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour cooldown between auto-update attempts

interface AutoUpdateCache {
  lastAttempt: number;
  lastSuccess?: number;
}

function readAutoUpdateCache(): AutoUpdateCache | null {
  try {
    if (!existsSync(AUTO_UPDATE_CACHE_FILE)) return null;
    return JSON.parse(readFileSync(AUTO_UPDATE_CACHE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeAutoUpdateCache(cache: AutoUpdateCache): void {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    writeFileSync(AUTO_UPDATE_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Ignore errors
  }
}

/**
 * Seamless auto-update on CLI startup (like Gemini CLI)
 * Checks for updates and auto-installs without prompting.
 * Shows a message on success: "Update successful! The new version will be used on your next run."
 *
 * @param silent - If true, don't show any output (for background checks)
 * @returns Promise that resolves when check/update is complete
 */
export async function autoUpdateOnStartup(silent = false): Promise<void> {
  // Skip in CI or if auto-update disabled
  if (process.env.CI || process.env.SQUADS_NO_AUTO_UPDATE) return;

  // Check cooldown - don't spam npm
  const autoCache = readAutoUpdateCache();
  const now = Date.now();
  if (autoCache && (now - autoCache.lastAttempt) < AUTO_UPDATE_COOLDOWN_MS) {
    return; // Too soon since last attempt
  }

  // Check if update is available
  const info = checkForUpdate();
  if (!info.updateAvailable) return;

  // Write attempt timestamp before trying
  writeAutoUpdateCache({ lastAttempt: now, lastSuccess: autoCache?.lastSuccess });

  // Perform update silently in background using spawn
  try {
    const { spawn } = await import('child_process');

    // Run npm update in background
    const child = spawn('npm', ['update', '-g', 'squads-cli'], {
      detached: true,
      stdio: silent ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    if (!silent && child.stdout) {
      // Wait for completion and check result
      await new Promise<void>((resolve) => {
        child.on('close', (code) => {
          if (code === 0) {
            // Success - show Gemini-style message
            console.log(`\n  \x1b[32m✓\x1b[0m Update successful! v${info.latestVersion} will be used on your next run.\n`);
            writeAutoUpdateCache({ lastAttempt: now, lastSuccess: now });
            // Clear version cache so next startup detects new version
            try { unlinkSync(CACHE_FILE); } catch { /* ignore */ }
          }
          resolve();
        });

        // Timeout after 30 seconds
        setTimeout(() => resolve(), 30000);
      });
    } else {
      // Silent mode - just fire and forget
      child.unref();
    }
  } catch {
    // Ignore errors - auto-update is best effort
  }
}
