/**
 * File-based locking for safe concurrent file access
 */

import { existsSync, writeFileSync, unlinkSync, mkdirSync, statSync, readFileSync, openSync, closeSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

// Lock configuration
const LOCK_TTL_MS = 30000; // 30 seconds max lock hold time
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_MAX_RETRIES = 50; // 5 seconds max wait

/**
 * Generate a unique lock ID for this process
 */
function generateLockId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Get file lock path
 */
function getFileLockPath(filePath: string): string {
  const lockDir = join(dirname(filePath), '.locks');
  const hash = createHash('md5').update(filePath).digest('hex').slice(0, 12);
  return join(lockDir, `${hash}.lock`);
}

/**
 * Sleep helper
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Acquire a file-based lock
 */
function acquireFileLock(lockPath: string, lockId: string): boolean {
  try {
    const lockDir = dirname(lockPath);
    if (!existsSync(lockDir)) {
      mkdirSync(lockDir, { recursive: true });
    }

    // Check if lock exists and is still valid
    if (existsSync(lockPath)) {
      const stats = statSync(lockPath);
      const ageMs = Date.now() - stats.mtimeMs;

      // Lock expired - clean it up
      if (ageMs > LOCK_TTL_MS) {
        unlinkSync(lockPath);
      } else {
        return false; // Lock held by another process
      }
    }

    // Create lock file atomically using O_EXCL flag
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, lockId);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Release a file-based lock
 */
function releaseFileLock(lockPath: string, lockId: string): boolean {
  try {
    if (!existsSync(lockPath)) return true;

    const currentId = readFileSync(lockPath, 'utf-8').trim();

    if (currentId === lockId) {
      unlinkSync(lockPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Acquire a lock for a file path
 * Returns a release function, or null if lock couldn't be acquired
 */
export async function acquireLock(filePath: string): Promise<(() => Promise<void>) | null> {
  const lockId = generateLockId();
  const fileLockPath = getFileLockPath(filePath);

  let gotLock = false;

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    if (acquireFileLock(fileLockPath, lockId)) {
      gotLock = true;
      break;
    }

    // Wait and retry
    if (attempt < LOCK_MAX_RETRIES - 1) {
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  if (!gotLock) {
    return null;
  }

  // Return release function
  return async () => {
    releaseFileLock(fileLockPath, lockId);
  };
}

/**
 * Execute a function while holding a lock
 * Automatically acquires and releases the lock
 */
export async function withLock<T>(
  filePath: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const release = await acquireLock(filePath);

  if (!release) {
    throw new Error(`Failed to acquire lock for: ${filePath}`);
  }

  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Graceful shutdown - no-op (file locks don't need explicit cleanup)
 */
export async function closeLockClient(): Promise<void> {
  // No-op: file-based locks are self-cleaning via TTL
}
