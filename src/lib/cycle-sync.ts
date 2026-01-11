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
 */
async function ensureTables(): Promise<void> {
  const client = await getPool().connect();

  try {
    await client.query(`
      -- Goals table
      CREATE TABLE IF NOT EXISTS squads.squad_goals (
        id SERIAL PRIMARY KEY,
        squad_name TEXT NOT NULL,
        goal_index INT NOT NULL,
        description TEXT NOT NULL,
        status TEXT DEFAULT 'active',  -- active, completed
        progress TEXT,
        target_value NUMERIC,
        target_unit TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(squad_name, goal_index)
      );
      CREATE INDEX IF NOT EXISTS idx_squad_goals_squad ON squads.squad_goals(squad_name);

      -- Feedback table
      CREATE TABLE IF NOT EXISTS squads.task_feedback (
        id SERIAL PRIMARY KEY,
        squad_name TEXT NOT NULL,
        agent_name TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        quality_score INT CHECK (quality_score BETWEEN 1 AND 5),
        feedback_text TEXT,
        learnings JSONB DEFAULT '[]',
        tags JSONB DEFAULT '[]',
        UNIQUE(squad_name, timestamp)
      );
      CREATE INDEX IF NOT EXISTS idx_task_feedback_squad ON squads.task_feedback(squad_name);

      -- Learnings table (insights)
      CREATE TABLE IF NOT EXISTS squads.agent_insights (
        id SERIAL PRIMARY KEY,
        squad_name TEXT NOT NULL,
        agent_name TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        insight TEXT NOT NULL,
        category TEXT,  -- success, failure, pattern, tip
        tags JSONB DEFAULT '[]',
        context TEXT,
        UNIQUE(squad_name, timestamp, insight)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_insights_squad ON squads.agent_insights(squad_name);
    `);
  } finally {
    client.release();
  }
}

/**
 * Sync goals from SQUAD.md to Postgres
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
        await client.query(`
          INSERT INTO squads.squad_goals (squad_name, goal_index, description, status, progress, updated_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (squad_name, goal_index)
          DO UPDATE SET
            description = EXCLUDED.description,
            status = EXCLUDED.status,
            progress = EXCLUDED.progress,
            updated_at = NOW()
        `, [
          squadName,
          i + 1,
          goal.description,
          goal.completed ? 'completed' : 'active',
          goal.progress || null,
        ]);
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
          INSERT INTO squads.task_feedback (squad_name, agent_name, timestamp, quality_score, feedback_text, learnings)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (squad_name, timestamp) DO NOTHING
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
          INSERT INTO squads.agent_insights (squad_name, agent_name, timestamp, insight, category, tags, context)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (squad_name, timestamp, insight) DO NOTHING
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
