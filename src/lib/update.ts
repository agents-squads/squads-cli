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

  if (cache && (now - cache.checkedAt) < CACHE_TTL_MS) {
    // Use cached value
    result.latestVersion = cache.latestVersion;
    result.updateAvailable = isNewerVersion(CURRENT_VERSION, cache.latestVersion);
    return result;
  }

  // Fetch from npm (async-ish via cache)
  const latestVersion = fetchLatestVersion();

  if (latestVersion) {
    writeCache(latestVersion);
    result.latestVersion = latestVersion;
    result.updateAvailable = isNewerVersion(CURRENT_VERSION, latestVersion);
  } else if (cache) {
    // Use stale cache if fetch fails
    result.latestVersion = cache.latestVersion;
    result.updateAvailable = isNewerVersion(CURRENT_VERSION, cache.latestVersion);
  }

  return result;
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
