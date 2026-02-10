/**
 * Cycle Data Sync — stub implementation
 *
 * Syncing cycle data to Postgres is a platform feature (Layer 3).
 * The CLI (Layer 1) stores all data in local markdown/JSON files.
 * These stubs maintain API compatibility for the sync command.
 */

/**
 * Sync result for a single data type
 */
export interface SyncStats {
  synced: number;
  skipped: number;
  errors: number;
}

/**
 * Full sync result
 */
export interface SyncResult {
  goals: SyncStats;
  feedback: SyncStats;
  kpis: SyncStats;
  learnings: SyncStats;
  duration: number;
}

/**
 * Sync all cycle data (no-op without database)
 */
export async function syncAllCycleData(): Promise<SyncResult> {
  return {
    goals: { synced: 0, skipped: 0, errors: 0 },
    feedback: { synced: 0, skipped: 0, errors: 0 },
    kpis: { synced: 0, skipped: 0, errors: 0 },
    learnings: { synced: 0, skipped: 0, errors: 0 },
    duration: 0,
  };
}

/**
 * Check if Postgres is available (always false in CLI-only mode)
 */
export async function isPostgresAvailable(): Promise<boolean> {
  return false;
}

/**
 * Close the connection pool (no-op)
 */
export async function closeCycleSyncPool(): Promise<void> {
  // No-op: no database connection in CLI-only mode
}
