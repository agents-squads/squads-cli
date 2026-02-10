/**
 * Database utilities — stub implementation
 *
 * Database persistence is a platform feature (Layer 3).
 * The CLI (Layer 1) operates entirely on the local file system.
 * These stubs maintain API compatibility for commands that reference db functions.
 */

/**
 * Check if database is available (always false in CLI-only mode)
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  return false;
}

/**
 * Dashboard snapshot data structure
 */
export interface DashboardSnapshot {
  totalSquads: number;
  totalCommits: number;
  totalPrsMerged: number;
  totalIssuesClosed: number;
  totalIssuesOpen: number;
  goalProgressPct: number;
  costUsd: number;
  dailyBudgetUsd: number;
  inputTokens: number;
  outputTokens: number;
  commits30d: number;
  avgCommitsPerDay: number;
  activeDays: number;
  peakCommits: number;
  peakDate: string | null;
  squadsData: SquadSnapshotData[];
  authorsData: { name: string; commits: number }[];
  reposData: { name: string; commits: number }[];
}

export interface SquadSnapshotData {
  name: string;
  commits: number;
  prsOpened: number;
  prsMerged: number;
  issuesClosed: number;
  issuesOpen: number;
  goalsActive: number;
  goalsTotal: number;
  progress: number;
}

/**
 * Save a dashboard snapshot (no-op without database)
 */
export async function saveDashboardSnapshot(_snapshot: DashboardSnapshot): Promise<number | null> {
  return null;
}

/**
 * Get recent dashboard snapshots (empty without database)
 */
export async function getDashboardHistory(_limit: number = 30): Promise<DashboardSnapshot[]> {
  return [];
}

/**
 * Close the database connection pool (no-op)
 */
export async function closeDatabase(): Promise<void> {
  // No-op: no database connection in CLI-only mode
}

// === Baseline Storage for ROI Tracking ===

export interface BaselineSnapshot {
  id?: number;
  name: string;
  capturedAt: string;
  costUsd: number;
  goalsCompleted: number;
  goalsActive: number;
  commits: number;
  prsMerged: number;
  issuesClosed: number;
  inputTokens: number;
  outputTokens: number;
  squadMetrics: Array<{
    squad: string;
    costUsd: number;
    goals: number;
    commits: number;
    prs: number;
  }>;
}

/**
 * Save a baseline snapshot (no-op without database)
 */
export async function saveBaseline(_baseline: BaselineSnapshot): Promise<number | null> {
  return null;
}

/**
 * Get the most recent baseline (null without database)
 */
export async function getLatestBaseline(): Promise<BaselineSnapshot | null> {
  return null;
}

/**
 * Get a baseline by name (null without database)
 */
export async function getBaselineByName(_name: string): Promise<BaselineSnapshot | null> {
  return null;
}

/**
 * List all baselines (empty without database)
 */
export async function listBaselines(_limit: number = 10): Promise<BaselineSnapshot[]> {
  return [];
}
