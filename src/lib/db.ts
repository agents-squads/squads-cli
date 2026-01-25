/**
 * Database utilities for local PostgreSQL persistence
 * Connects to the squads schema for storing metrics and snapshots
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const { Pool } = pg;

// Connection config from environment or defaults
const DATABASE_URL = process.env.SQUADS_DATABASE_URL ||
  'postgresql://squads:squads_local_dev@localhost:5433/squads';

let pool: InstanceType<typeof Pool> | null = null;

/**
 * Get or create the connection pool
 */
function getPool(): InstanceType<typeof Pool> {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 1500, // Fast timeout for CLI responsiveness
    });

    // Handle pool errors
    pool.on('error', (err: Error) => {
      console.error('Unexpected database pool error:', err);
    });
  }
  return pool;
}

/**
 * Check if database is available
 */
export async function isDatabaseAvailable(): Promise<boolean> {
  try {
    const pool = getPool();
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('DB availability check failed:', err);
    }
    return false;
  }
}

/**
 * Dashboard snapshot data structure
 */
export interface DashboardSnapshot {
  // Top-level metrics
  totalSquads: number;
  totalCommits: number;
  totalPrsMerged: number;
  totalIssuesClosed: number;
  totalIssuesOpen: number;
  goalProgressPct: number;

  // Cost metrics
  costUsd: number;
  dailyBudgetUsd: number;
  inputTokens: number;
  outputTokens: number;

  // Git activity
  commits30d: number;
  avgCommitsPerDay: number;
  activeDays: number;
  peakCommits: number;
  peakDate: string | null;

  // Detailed breakdowns (stored as JSONB)
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
 * Save a dashboard snapshot to the database
 */
export async function saveDashboardSnapshot(snapshot: DashboardSnapshot): Promise<number | null> {
  try {
    const pool = getPool();
    const client = await pool.connect();

    const result = await client.query(`
      INSERT INTO squads.dashboard_snapshots (
        total_squads, total_commits, total_prs_merged, total_issues_closed, total_issues_open,
        goal_progress_pct, cost_usd, daily_budget_usd, input_tokens, output_tokens,
        commits_30d, avg_commits_per_day, active_days, peak_commits, peak_date,
        squads_data, authors_data, repos_data
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
      ) RETURNING id
    `, [
      snapshot.totalSquads,
      snapshot.totalCommits,
      snapshot.totalPrsMerged,
      snapshot.totalIssuesClosed,
      snapshot.totalIssuesOpen,
      snapshot.goalProgressPct,
      snapshot.costUsd,
      snapshot.dailyBudgetUsd,
      snapshot.inputTokens,
      snapshot.outputTokens,
      snapshot.commits30d,
      snapshot.avgCommitsPerDay,
      snapshot.activeDays,
      snapshot.peakCommits,
      snapshot.peakDate,
      JSON.stringify(snapshot.squadsData),
      JSON.stringify(snapshot.authorsData),
      JSON.stringify(snapshot.reposData),
    ]);

    client.release();
    return result.rows[0]?.id ?? null;
  } catch (err) {
    // Log error for debugging, but don't crash
    if (process.env.DEBUG) {
      console.error('DB save error:', err);
    }
    return null;
  }
}

/**
 * Get recent dashboard snapshots for trend analysis
 */
export async function getDashboardHistory(limit: number = 30): Promise<DashboardSnapshot[]> {
  try {
    const client = await getPool().connect();

    const result = await client.query(`
      SELECT
        total_squads, total_commits, total_prs_merged, total_issues_closed, total_issues_open,
        goal_progress_pct, cost_usd, daily_budget_usd, input_tokens, output_tokens,
        commits_30d, avg_commits_per_day, active_days, peak_commits, peak_date,
        squads_data, authors_data, repos_data, captured_at
      FROM squads.dashboard_snapshots
      ORDER BY captured_at DESC
      LIMIT $1
    `, [limit]);

    client.release();

    return result.rows.map((row: Record<string, unknown>) => ({
      totalSquads: row.total_squads,
      totalCommits: row.total_commits,
      totalPrsMerged: row.total_prs_merged,
      totalIssuesClosed: row.total_issues_closed,
      totalIssuesOpen: row.total_issues_open,
      goalProgressPct: row.goal_progress_pct,
      costUsd: parseFloat(String(row.cost_usd)),
      dailyBudgetUsd: parseFloat(String(row.daily_budget_usd)),
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      commits30d: row.commits_30d,
      avgCommitsPerDay: parseFloat(String(row.avg_commits_per_day)),
      activeDays: row.active_days,
      peakCommits: row.peak_commits,
      peakDate: row.peak_date,
      squadsData: row.squads_data || [],
      authorsData: row.authors_data || [],
      reposData: row.repos_data || [],
    }));
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('Failed to get snapshots from database:', err);
    }
    return [];
  }
}

/**
 * Close the database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
