/**
 * Database utilities for local PostgreSQL persistence
 * Connects to the squads schema for storing metrics and snapshots
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pg = require('pg');
const { Pool } = pg;

// Connection config from environment
// No hardcoded fallback - database is optional, use env var to configure
const DATABASE_URL = process.env.SQUADS_DATABASE_URL;

let pool: InstanceType<typeof Pool> | null = null;

/**
 * Get or create the connection pool
 * Returns null if DATABASE_URL is not configured
 */
function getPool(): InstanceType<typeof Pool> | null {
  if (!DATABASE_URL) {
    return null;
  }

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
  const pool = getPool();
  if (!pool) {
    return false;
  }
  let client: Awaited<ReturnType<typeof pool.connect>> | null = null;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return true;
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('DB availability check failed:', err);
    }
    return false;
  } finally {
    if (client) {
      client.release();
    }
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
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const client = await pool.connect();

  try {
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

    return result.rows[0]?.id ?? null;
  } catch (err) {
    // Log error for debugging, but don't crash
    if (process.env.DEBUG) {
      console.error('DB save error:', err);
    }
    return null;
  } finally {
    client.release();
  }
}

/**
 * Get recent dashboard snapshots for trend analysis
 */
export async function getDashboardHistory(limit: number = 30): Promise<DashboardSnapshot[]> {
  const pool = getPool();
  if (!pool) {
    return [];
  }
  const client = await pool.connect();

  try {
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
  } finally {
    client.release();
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

// === Baseline Storage for ROI Tracking ===

/**
 * Baseline metrics snapshot for before/after comparison
 */
export interface BaselineSnapshot {
  id?: number;
  name: string; // User-defined name for this baseline
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
 * Save a baseline snapshot for ROI comparison
 */
export async function saveBaseline(baseline: BaselineSnapshot): Promise<number | null> {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const client = await pool.connect();

  try {
    // First, ensure the baseline table exists (create if not)
    await client.query(`
      CREATE TABLE IF NOT EXISTS squads.baselines (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        captured_at TIMESTAMPTZ DEFAULT NOW(),
        cost_usd NUMERIC(12,4) DEFAULT 0,
        goals_completed INT DEFAULT 0,
        goals_active INT DEFAULT 0,
        commits INT DEFAULT 0,
        prs_merged INT DEFAULT 0,
        issues_closed INT DEFAULT 0,
        input_tokens BIGINT DEFAULT 0,
        output_tokens BIGINT DEFAULT 0,
        squad_metrics JSONB DEFAULT '[]'
      )
    `);

    const result = await client.query(`
      INSERT INTO squads.baselines (
        name, cost_usd, goals_completed, goals_active, commits,
        prs_merged, issues_closed, input_tokens, output_tokens, squad_metrics
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [
      baseline.name,
      baseline.costUsd,
      baseline.goalsCompleted,
      baseline.goalsActive,
      baseline.commits,
      baseline.prsMerged,
      baseline.issuesClosed,
      baseline.inputTokens,
      baseline.outputTokens,
      JSON.stringify(baseline.squadMetrics),
    ]);

    return result.rows[0]?.id ?? null;
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('DB save baseline error:', err);
    }
    return null;
  } finally {
    client.release();
  }
}

/**
 * Get the most recent baseline
 */
export async function getLatestBaseline(): Promise<BaselineSnapshot | null> {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT
        id, name, captured_at, cost_usd, goals_completed, goals_active,
        commits, prs_merged, issues_closed, input_tokens, output_tokens, squad_metrics
      FROM squads.baselines
      ORDER BY captured_at DESC
      LIMIT 1
    `);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row.id as number,
      name: row.name as string,
      capturedAt: (row.captured_at as Date).toISOString(),
      costUsd: parseFloat(String(row.cost_usd)),
      goalsCompleted: row.goals_completed as number,
      goalsActive: row.goals_active as number,
      commits: row.commits as number,
      prsMerged: row.prs_merged as number,
      issuesClosed: row.issues_closed as number,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      squadMetrics: (row.squad_metrics as Array<{squad: string; costUsd: number; goals: number; commits: number; prs: number}>) || [],
    };
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('Failed to get baseline from database:', err);
    }
    return null;
  } finally {
    client.release();
  }
}

/**
 * Get a baseline by name
 */
export async function getBaselineByName(name: string): Promise<BaselineSnapshot | null> {
  const pool = getPool();
  if (!pool) {
    return null;
  }
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT
        id, name, captured_at, cost_usd, goals_completed, goals_active,
        commits, prs_merged, issues_closed, input_tokens, output_tokens, squad_metrics
      FROM squads.baselines
      WHERE name = $1
      ORDER BY captured_at DESC
      LIMIT 1
    `, [name]);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0] as Record<string, unknown>;
    return {
      id: row.id as number,
      name: row.name as string,
      capturedAt: (row.captured_at as Date).toISOString(),
      costUsd: parseFloat(String(row.cost_usd)),
      goalsCompleted: row.goals_completed as number,
      goalsActive: row.goals_active as number,
      commits: row.commits as number,
      prsMerged: row.prs_merged as number,
      issuesClosed: row.issues_closed as number,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      squadMetrics: (row.squad_metrics as Array<{squad: string; costUsd: number; goals: number; commits: number; prs: number}>) || [],
    };
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('Failed to get baseline by name:', err);
    }
    return null;
  } finally {
    client.release();
  }
}

/**
 * List all baselines
 */
export async function listBaselines(limit: number = 10): Promise<BaselineSnapshot[]> {
  const pool = getPool();
  if (!pool) {
    return [];
  }
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT
        id, name, captured_at, cost_usd, goals_completed, goals_active,
        commits, prs_merged, issues_closed, input_tokens, output_tokens, squad_metrics
      FROM squads.baselines
      ORDER BY captured_at DESC
      LIMIT $1
    `, [limit]);

    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as number,
      name: row.name as string,
      capturedAt: (row.captured_at as Date).toISOString(),
      costUsd: parseFloat(String(row.cost_usd)),
      goalsCompleted: row.goals_completed as number,
      goalsActive: row.goals_active as number,
      commits: row.commits as number,
      prsMerged: row.prs_merged as number,
      issuesClosed: row.issues_closed as number,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      squadMetrics: (row.squad_metrics as Array<{squad: string; costUsd: number; goals: number; commits: number; prs: number}>) || [],
    }));
  } catch (err) {
    if (process.env.DEBUG) {
      console.error('Failed to list baselines:', err);
    }
    return [];
  } finally {
    client.release();
  }
}
