/**
 * Distributed locking for safe concurrent file access
 * Uses Redis when available, falls back to file-based locks
 */

import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import type Redis from 'ioredis';

// Lock configuration
const LOCK_TTL_MS = 30000; // 30 seconds max lock hold time
const LOCK_RETRY_DELAY_MS = 100;
const LOCK_MAX_RETRIES = 50; // 5 seconds max wait

// Singleton Redis client
let redisClient: Redis | null = null;
let redisAvailable: boolean | null = null;

/**
 * Get or create Redis client
 * Lazy-loads ioredis only when Redis is actually needed
 */
async function getRedis(): Promise<Redis | null> {
  if (redisAvailable === false) return null;

  if (!redisClient) {
    try {
      // Lazy-load ioredis to avoid startup penalty
      const { default: RedisConstructor } = await import('ioredis');

      redisClient = new RedisConstructor({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        connectTimeout: 1000,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
      });

      await redisClient.connect();
      redisAvailable = true;
    } catch {
      redisAvailable = false;
      redisClient = null;
      return null;
    }
  }

  return redisClient;
}

/**
 * Generate a unique lock ID for this process
 */
function generateLockId(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Hash a file path to create a lock key
 */
function getLockKey(filePath: string): string {
  const hash = createHash('md5').update(filePath).digest('hex').slice(0, 12);
  return `squads:lock:${hash}`;
}

/**
 * Get file lock path for fallback locking
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
 * Acquire a distributed lock using Redis
 */
async function acquireRedisLock(key: string, lockId: string): Promise<boolean> {
  const redis = await getRedis();
  if (!redis) return false;

  try {
    // SET key lockId NX PX ttl - atomic set-if-not-exists with expiry
    const result = await redis.set(key, lockId, 'PX', LOCK_TTL_MS, 'NX');
    return result === 'OK';
  } catch {
    return false;
  }
}

/**
 * Release a Redis lock (only if we own it)
 */
async function releaseRedisLock(key: string, lockId: string): Promise<boolean> {
  const redis = await getRedis();
  if (!redis) return false;

  try {
    // Lua script to atomically check and delete
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    const result = await redis.eval(script, 1, key, lockId);
    return result === 1;
  } catch {
    return false;
  }
}

/**
 * Acquire a file-based lock (fallback when Redis unavailable)
 */
function acquireFileLock(lockPath: string, lockId: string): boolean {
  try {
    const lockDir = dirname(lockPath);
    if (!existsSync(lockDir)) {
      mkdirSync(lockDir, { recursive: true });
    }

    // Check if lock exists and is still valid
    if (existsSync(lockPath)) {
      const { statSync } = require('fs');
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
    const { openSync, closeSync } = require('fs');
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

    const { readFileSync } = require('fs');
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
  const redisKey = getLockKey(filePath);
  const fileLockPath = getFileLockPath(filePath);

  let useRedis = false;

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    // Try Redis first
    if (await acquireRedisLock(redisKey, lockId)) {
      useRedis = true;
      break;
    }

    // Fall back to file lock if Redis unavailable
    if (redisAvailable === false && acquireFileLock(fileLockPath, lockId)) {
      useRedis = false;
      break;
    }

    // Wait and retry
    if (attempt < LOCK_MAX_RETRIES - 1) {
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

  // Check if we got the lock
  const redis = await getRedis();
  let gotLock = false;

  if (redis) {
    try {
      const currentOwner = await redis.get(redisKey);
      gotLock = currentOwner === lockId;
    } catch {
      gotLock = false;
    }
  } else {
    // Check file lock
    try {
      if (existsSync(fileLockPath)) {
        const { readFileSync } = require('fs');
        const currentId = readFileSync(fileLockPath, 'utf-8').trim();
        gotLock = currentId === lockId;
      }
    } catch {
      gotLock = false;
    }
  }

  if (!gotLock) {
    return null;
  }

  // Return release function
  return async () => {
    if (useRedis) {
      await releaseRedisLock(redisKey, lockId);
    } else {
      releaseFileLock(fileLockPath, lockId);
    }
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
 * Graceful shutdown - close Redis connection
 */
export async function closeLockClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    redisAvailable = null;
  }
}
