/**
 * Cycle Data Sync
 *
 * Syncs cycle data (goals, feedback, KPIs, learnings) from file storage to Postgres.
 * Enables analytics and cross-session insights.
 */

import { createRequire } from 'module';
import { findSquadsDir, listSquads, loadSquad } from './squad-parser.js';
import { loadKpiStore, parseKpiDefinitions } from './kpi.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';

const require = createRequire(import.meta.url);
const pg = require('pg');
const { Pool } = pg;

// Connection config from environment or defaults
const DATABASE_URL = process.env.SQUADS_DATABASE_URL ||
  'postgresql://user:password@localhost:5432/squads';

let pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 3000,
    });
  }
  return pool;
}

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
 * Ensure required tables exist
 *
 * Note: squad_goals already exists with different schema, we adapt to it.
 * For feedback and learnings, we create cycle-specific tables since existing
 * task_feedback and agent_insights have incompatible schemas.
 */
async function ensureTables(): Promise<void> {
  const client = await getPool().connect();

  try {
    await client.query(`
      -- Cycle feedback table (separate from task_feedback which is per-task)
      CREATE TABLE IF NOT EXISTS squads.cycle_feedback (
        id SERIAL PRIMARY KEY,
        squad TEXT NOT NULL,
        agent TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        quality_score INT CHECK (quality_score BETWEEN 1 AND 5),
        feedback_text TEXT,
        learnings JSONB DEFAULT '[]',
        tags JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(squad, timestamp)
      );

      -- Cycle learnings table (separate from agent_insights which is aggregated metrics)
      CREATE TABLE IF NOT EXISTS squads.cycle_learnings (
        id SERIAL PRIMARY KEY,
        squad TEXT NOT NULL,
        agent TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        insight TEXT NOT NULL,
        category TEXT,  -- success, failure, pattern, tip
        tags JSONB DEFAULT '[]',
        context TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(squad, timestamp, insight)
      );
    `);

    // Create indexes separately (IF NOT EXISTS is implicit for indexes)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_cycle_feedback_squad ON squads.cycle_feedback(squad);
      CREATE INDEX IF NOT EXISTS idx_cycle_learnings_squad ON squads.cycle_learnings(squad);
    `);
  } finally {
    client.release();
  }
}

/**
 * Sync goals from SQUAD.md to Postgres
 * Uses existing squad_goals table schema (squad column, not squad_name)
 */
export async function syncGoals(squadName: string): Promise<SyncStats> {
  const stats: SyncStats = { synced: 0, skipped: 0, errors: 0 };

  const squad = loadSquad(squadName);
  if (!squad || squad.goals.length === 0) {
    return stats;
  }

  const client = await getPool().connect();

  try {
    for (let i = 0; i < squad.goals.length; i++) {
      const goal = squad.goals[i];

      try {
        // Check if goal exists by squad + description (since there's no goal_index in existing schema)
        const existing = await client.query(
          `SELECT id FROM squads.squad_goals WHERE squad = $1 AND description = $2`,
          [squadName, goal.description]
        );

        if (existing.rows.length > 0) {
          // Update existing
          await client.query(`
            UPDATE squads.squad_goals
            SET completed = $1, progress_text = $2, status = $3, updated_at = NOW()
            WHERE id = $4
          `, [
            goal.completed || false,
            goal.progress || null,
            goal.completed ? 'completed' : 'active',
            existing.rows[0].id,
          ]);
        } else {
          // Insert new
          await client.query(`
            INSERT INTO squads.squad_goals (squad, description, completed, progress_text, status, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
          `, [
            squadName,
            goal.description,
            goal.completed || false,
            goal.progress || null,
            goal.completed ? 'completed' : 'active',
          ]);
        }
        stats.synced++;
      } catch (err) {
        stats.errors++;
        if (process.env.DEBUG) console.error('Goal sync error:', err);
      }
    }
  } finally {
    client.release();
  }

  return stats;
}

/**
 * Load feedback from memory file
 */
interface FeedbackEntry {
  timestamp: string;
  rating: number;
  feedback: string;
  learnings?: string[];
  agent?: string;
}

interface FeedbackStore {
  entries: FeedbackEntry[];
}

function loadFeedbackStore(squadName: string): FeedbackStore {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return { entries: [] };

  const memoryDir = join(dirname(squadsDir), 'memory', squadName);
  const feedbackPath = join(memoryDir, 'feedback.json');

  if (!existsSync(feedbackPath)) return { entries: [] };

  try {
    const content = readFileSync(feedbackPath, 'utf-8');
    return JSON.parse(content) as FeedbackStore;
  } catch {
    return { entries: [] };
  }
}

/**
 * Sync feedback from memory file to Postgres
 * Uses cycle_feedback table (separate from task_feedback)
 */
export async function syncFeedback(squadName: string): Promise<SyncStats> {
  const stats: SyncStats = { synced: 0, skipped: 0, errors: 0 };

  const store = loadFeedbackStore(squadName);
  if (store.entries.length === 0) {
    return stats;
  }

  const client = await getPool().connect();

  try {
    for (const entry of store.entries) {
      try {
        await client.query(`
          INSERT INTO squads.cycle_feedback (squad, agent, timestamp, quality_score, feedback_text, learnings)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (squad, timestamp) DO NOTHING
        `, [
          squadName,
          entry.agent || null,
          entry.timestamp,
          entry.rating,
          entry.feedback,
          JSON.stringify(entry.learnings || []),
        ]);
        stats.synced++;
      } catch (err) {
        stats.errors++;
        if (process.env.DEBUG) console.error('Feedback sync error:', err);
      }
    }
  } finally {
    client.release();
  }

  return stats;
}

/**
 * Sync KPIs from kpis.json to metrics table
 */
export async function syncKpis(squadName: string): Promise<SyncStats> {
  const stats: SyncStats = { synced: 0, skipped: 0, errors: 0 };

  const squad = loadSquad(squadName);
  if (!squad) return stats;

  const definitions = parseKpiDefinitions(squad.frontmatter);
  if (definitions.length === 0) return stats;

  const kpiStore = loadKpiStore(squadName);
  const client = await getPool().connect();

  try {
    for (const def of definitions) {
      const values = kpiStore.kpis[def.name] || [];

      for (const value of values) {
        try {
          // Use squads.metrics table (already exists)
          await client.query(`
            INSERT INTO squads.metrics (name, squad, value, unit, dimensions, recorded_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING
          `, [
            def.name,
            squadName,
            value.value,
            def.unit,
            JSON.stringify({ period: def.period, source: def.source || 'manual', note: value.note || null }),
            value.timestamp,
          ]);
          stats.synced++;
        } catch (err) {
          stats.errors++;
          if (process.env.DEBUG) console.error('KPI sync error:', err);
        }
      }
    }
  } finally {
    client.release();
  }

  return stats;
}

/**
 * Load learnings from memory file
 */
interface LearningEntry {
  timestamp: string;
  insight: string;
  category?: string;
  tags?: string[];
  context?: string;
  agent?: string;
}

interface LearningsStore {
  entries: LearningEntry[];
}

function loadLearningsStore(squadName: string): LearningsStore {
  const squadsDir = findSquadsDir();
  if (!squadsDir) return { entries: [] };

  const memoryDir = join(dirname(squadsDir), 'memory', squadName);
  const learningsPath = join(memoryDir, 'learnings.json');

  if (!existsSync(learningsPath)) return { entries: [] };

  try {
    const content = readFileSync(learningsPath, 'utf-8');
    return JSON.parse(content) as LearningsStore;
  } catch {
    return { entries: [] };
  }
}

/**
 * Sync learnings from memory file to Postgres
 * Uses cycle_learnings table (separate from agent_insights which is aggregated)
 */
export async function syncLearnings(squadName: string): Promise<SyncStats> {
  const stats: SyncStats = { synced: 0, skipped: 0, errors: 0 };

  const store = loadLearningsStore(squadName);
  if (store.entries.length === 0) {
    return stats;
  }

  const client = await getPool().connect();

  try {
    for (const entry of store.entries) {
      try {
        await client.query(`
          INSERT INTO squads.cycle_learnings (squad, agent, timestamp, insight, category, tags, context)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (squad, timestamp, insight) DO NOTHING
        `, [
          squadName,
          entry.agent || null,
          entry.timestamp,
          entry.insight,
          entry.category || null,
          JSON.stringify(entry.tags || []),
          entry.context || null,
        ]);
        stats.synced++;
      } catch (err) {
        stats.errors++;
        if (process.env.DEBUG) console.error('Learning sync error:', err);
      }
    }
  } finally {
    client.release();
  }

  return stats;
}

/**
 * Sync all cycle data for a single squad
 */
export async function syncSquadCycleData(squadName: string): Promise<{
  goals: SyncStats;
  feedback: SyncStats;
  kpis: SyncStats;
  learnings: SyncStats;
}> {
  const goals = await syncGoals(squadName);
  const feedback = await syncFeedback(squadName);
  const kpis = await syncKpis(squadName);
  const learnings = await syncLearnings(squadName);

  return { goals, feedback, kpis, learnings };
}

/**
 * Sync all cycle data for all squads
 */
export async function syncAllCycleData(): Promise<SyncResult> {
  const start = Date.now();

  // Ensure tables exist
  await ensureTables();

  const result: SyncResult = {
    goals: { synced: 0, skipped: 0, errors: 0 },
    feedback: { synced: 0, skipped: 0, errors: 0 },
    kpis: { synced: 0, skipped: 0, errors: 0 },
    learnings: { synced: 0, skipped: 0, errors: 0 },
    duration: 0,
  };

  const squadsDir = findSquadsDir();
  if (!squadsDir) {
    result.duration = Date.now() - start;
    return result;
  }

  const squads = listSquads(squadsDir);

  for (const squadName of squads) {
    const squadResult = await syncSquadCycleData(squadName);

    result.goals.synced += squadResult.goals.synced;
    result.goals.errors += squadResult.goals.errors;

    result.feedback.synced += squadResult.feedback.synced;
    result.feedback.errors += squadResult.feedback.errors;

    result.kpis.synced += squadResult.kpis.synced;
    result.kpis.errors += squadResult.kpis.errors;

    result.learnings.synced += squadResult.learnings.synced;
    result.learnings.errors += squadResult.learnings.errors;
  }

  result.duration = Date.now() - start;
  return result;
}

/**
 * Check if Postgres is available
 */
export async function isPostgresAvailable(): Promise<boolean> {
  try {
    const client = await getPool().connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}

/**
 * Close the connection pool
 */
export async function closeCycleSyncPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
