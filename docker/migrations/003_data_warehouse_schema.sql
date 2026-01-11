-- =============================================================================
-- Squads Data Warehouse Schema v1.0
-- Pro-level schema for analytics, autonomy tracking, and business intelligence
-- =============================================================================

-- =============================================================================
-- DIMENSION TABLES
-- Slowly changing dimensions for reference data
-- =============================================================================

-- Users/Workers - Human and AI actors in the system
CREATE TABLE IF NOT EXISTS squads.dim_users (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) UNIQUE NOT NULL,

    -- Identity
    name VARCHAR(255),
    email VARCHAR(255),
    type VARCHAR(50) NOT NULL DEFAULT 'human', -- human, ai_agent, system

    -- For AI agents
    model_family VARCHAR(50), -- claude, gpt, gemini
    model_version VARCHAR(100), -- opus-4, sonnet-4, etc

    -- Status
    is_active BOOLEAN DEFAULT TRUE,

    -- Timestamps (SCD Type 2)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Squads - Domain-aligned teams
CREATE TABLE IF NOT EXISTS squads.dim_squads (
    id SERIAL PRIMARY KEY,
    squad_name VARCHAR(100) UNIQUE NOT NULL,

    -- Description
    mission TEXT,
    domain VARCHAR(100), -- engineering, research, marketing, etc

    -- Configuration
    default_provider VARCHAR(50) DEFAULT 'anthropic',
    daily_budget NUMERIC(10,2) DEFAULT 50.00,
    cooldown_seconds INTEGER DEFAULT 300,

    -- Status
    is_active BOOLEAN DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Source of truth (SQUAD.md hash for sync detection)
    source_hash VARCHAR(64),

    -- Metadata (providers, permissions, context)
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Agents - Individual workers within squads
CREATE TABLE IF NOT EXISTS squads.dim_agents (
    id SERIAL PRIMARY KEY,
    agent_name VARCHAR(100) NOT NULL,
    squad_id INTEGER REFERENCES squads.dim_squads(id),

    -- Definition
    role TEXT,
    purpose TEXT,

    -- Configuration
    provider VARCHAR(50), -- Override squad default
    trigger_type VARCHAR(50) DEFAULT 'manual', -- manual, scheduled, event, smart

    -- Capabilities
    mcp_servers VARCHAR(100)[], -- MCP servers this agent uses
    skills VARCHAR(100)[], -- Skills this agent uses

    -- Status
    is_active BOOLEAN DEFAULT TRUE,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Source of truth (agent.md hash)
    source_hash VARCHAR(64),

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb,

    UNIQUE(agent_name, squad_id)
);

CREATE INDEX IF NOT EXISTS idx_dim_agents_squad ON squads.dim_agents(squad_id);

-- Schedules - Time-based triggers
CREATE TABLE IF NOT EXISTS squads.dim_schedules (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,

    -- Target
    squad_id INTEGER REFERENCES squads.dim_squads(id),
    agent_id INTEGER REFERENCES squads.dim_agents(id),

    -- Schedule definition
    cron_expression VARCHAR(100), -- Standard cron
    timezone VARCHAR(50) DEFAULT 'UTC',

    -- Execution window
    start_time TIME, -- Daily start time
    end_time TIME, -- Daily end time (for "tonight" mode)

    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    next_run_at TIMESTAMPTZ,

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================================================
-- FACT TABLES
-- Immutable event records
-- =============================================================================

-- Learnings - Extracted insights (separate from conversations)
CREATE TABLE IF NOT EXISTS squads.fact_learnings (
    id SERIAL PRIMARY KEY,

    -- Context
    squad_id INTEGER REFERENCES squads.dim_squads(id),
    agent_id INTEGER REFERENCES squads.dim_agents(id),
    session_id VARCHAR(255),
    task_id VARCHAR(255),

    -- Content
    content TEXT NOT NULL,
    category VARCHAR(50), -- success, failure, pattern, tip, insight
    importance VARCHAR(20) DEFAULT 'normal', -- low, normal, high, critical

    -- Classification
    tags VARCHAR(50)[],

    -- Source
    source_type VARCHAR(50), -- manual, auto_extracted, feedback
    source_ref VARCHAR(500), -- Reference to source (PR URL, issue, etc)

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- For semantic search (optional - add pgvector extension)
    -- embedding vector(1536),

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_fact_learnings_squad ON squads.fact_learnings(squad_id);
CREATE INDEX IF NOT EXISTS idx_fact_learnings_category ON squads.fact_learnings(category);
CREATE INDEX IF NOT EXISTS idx_fact_learnings_importance ON squads.fact_learnings(importance);
CREATE INDEX IF NOT EXISTS idx_fact_learnings_created ON squads.fact_learnings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_learnings_content_search
    ON squads.fact_learnings USING gin(to_tsvector('english', content));

-- KPIs - Squad performance metrics
CREATE TABLE IF NOT EXISTS squads.fact_kpis (
    id SERIAL PRIMARY KEY,

    -- Context
    squad_id INTEGER REFERENCES squads.dim_squads(id),
    kpi_name VARCHAR(100) NOT NULL,

    -- Value
    value NUMERIC NOT NULL,
    unit VARCHAR(50), -- leads, revenue, features, etc

    -- Target
    target_value NUMERIC,
    target_type VARCHAR(20) DEFAULT 'gte', -- gte, lte, eq, range
    target_min NUMERIC, -- For range targets
    target_max NUMERIC,

    -- Period
    period_type VARCHAR(20) NOT NULL, -- daily, weekly, monthly, quarterly
    period_start DATE NOT NULL,
    period_end DATE,

    -- Status
    is_on_track BOOLEAN,
    variance_pct NUMERIC(5,2), -- % difference from target

    -- Timestamps
    recorded_at TIMESTAMPTZ DEFAULT NOW(),

    -- Metadata (trend data, notes)
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_fact_kpis_squad ON squads.fact_kpis(squad_id);
CREATE INDEX IF NOT EXISTS idx_fact_kpis_name ON squads.fact_kpis(kpi_name);
CREATE INDEX IF NOT EXISTS idx_fact_kpis_period ON squads.fact_kpis(period_type, period_start DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_kpis_unique
    ON squads.fact_kpis(squad_id, kpi_name, period_type, period_start);

-- Memories - Persistent state per agent
CREATE TABLE IF NOT EXISTS squads.fact_memories (
    id SERIAL PRIMARY KEY,

    -- Context
    squad_id INTEGER REFERENCES squads.dim_squads(id),
    agent_id INTEGER REFERENCES squads.dim_agents(id),

    -- Content
    memory_type VARCHAR(50) NOT NULL, -- state, context, working_memory
    key VARCHAR(255), -- For key-value style memories
    content TEXT NOT NULL,

    -- Versioning
    version INTEGER DEFAULT 1,
    previous_id INTEGER REFERENCES squads.fact_memories(id),

    -- Source
    session_id VARCHAR(255),

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ, -- Optional TTL

    -- For semantic search
    -- embedding vector(1536),

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_fact_memories_agent ON squads.fact_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_fact_memories_type ON squads.fact_memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_fact_memories_key ON squads.fact_memories(squad_id, agent_id, key);
CREATE INDEX IF NOT EXISTS idx_fact_memories_content_search
    ON squads.fact_memories USING gin(to_tsvector('english', content));

-- Executions - Enhanced execution tracking
CREATE TABLE IF NOT EXISTS squads.fact_executions (
    id SERIAL PRIMARY KEY,
    execution_id VARCHAR(100) UNIQUE NOT NULL,

    -- Context
    squad_id INTEGER REFERENCES squads.dim_squads(id),
    agent_id INTEGER REFERENCES squads.dim_agents(id),
    schedule_id INTEGER REFERENCES squads.dim_schedules(id),
    goal_id INTEGER REFERENCES squads.squad_goals(id),

    -- Execution details
    trigger_type VARCHAR(50) NOT NULL, -- manual, scheduled, event, smart
    provider VARCHAR(50) DEFAULT 'anthropic',

    -- Status
    status VARCHAR(50) DEFAULT 'started', -- started, running, completed, failed, cancelled
    exit_reason VARCHAR(100), -- success, timeout, error, user_cancelled

    -- Output
    output_type VARCHAR(50), -- commit, pr, issue, file, none
    output_ref VARCHAR(500),

    -- Cost tracking
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cost_usd NUMERIC(10,6) DEFAULT 0,

    -- Context utilization
    peak_context_tokens INTEGER DEFAULT 0,
    context_utilization_pct NUMERIC(5,2),

    -- Timing
    started_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,

    -- Preflight results (for autonomy tracking)
    preflight_passed BOOLEAN,
    preflight_gates JSONB DEFAULT '{}'::jsonb, -- {budget: {ok, used, limit}, cooldown: {ok, elapsed}}

    -- Learnings injected
    learnings_injected INTEGER DEFAULT 0,

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_fact_executions_squad ON squads.fact_executions(squad_id);
CREATE INDEX IF NOT EXISTS idx_fact_executions_agent ON squads.fact_executions(agent_id);
CREATE INDEX IF NOT EXISTS idx_fact_executions_status ON squads.fact_executions(status);
CREATE INDEX IF NOT EXISTS idx_fact_executions_started ON squads.fact_executions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_executions_trigger ON squads.fact_executions(trigger_type);

-- =============================================================================
-- AUTONOMY TRACKING
-- Metrics for measuring autonomous operation confidence
-- =============================================================================

-- Autonomy scores - Daily assessment of autonomous capability
CREATE TABLE IF NOT EXISTS squads.fact_autonomy_scores (
    id SERIAL PRIMARY KEY,
    score_date DATE NOT NULL,

    -- Context (NULL for org-wide)
    squad_id INTEGER REFERENCES squads.dim_squads(id),

    -- Component scores (0-100)
    budget_compliance_score INTEGER, -- % of executions within budget
    cooldown_compliance_score INTEGER, -- % respecting cooldown
    quality_score INTEGER, -- Avg feedback score normalized to 100
    success_rate_score INTEGER, -- % successful executions
    learning_utilization_score INTEGER, -- % of executions with learnings injected
    drift_score INTEGER, -- % aligned with goals (future)

    -- Composite score
    overall_score INTEGER, -- Weighted average
    confidence_level VARCHAR(20), -- low (<50), medium (50-75), high (>75)

    -- Execution counts
    total_executions INTEGER DEFAULT 0,
    gated_executions INTEGER DEFAULT 0, -- Passed preflight
    blocked_executions INTEGER DEFAULT 0, -- Failed preflight

    -- Timestamps
    calculated_at TIMESTAMPTZ DEFAULT NOW(),

    -- Metadata
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_autonomy_scores_date
    ON squads.fact_autonomy_scores(score_date, squad_id);

-- =============================================================================
-- VIEWS FOR COMMON QUERIES
-- =============================================================================

-- Active sessions with cost (real-time dashboard)
CREATE OR REPLACE VIEW squads.v_active_sessions AS
SELECT
    s.id as session_id,
    s.squad,
    s.agent,
    s.status,
    s.total_cost_usd,
    s.generation_count,
    s.tool_count,
    s.started_at,
    s.last_activity_at,
    EXTRACT(EPOCH FROM (NOW() - s.started_at)) / 60 as duration_minutes
FROM squads.sessions s
WHERE s.status = 'active'
  AND s.last_activity_at > NOW() - INTERVAL '1 hour';

-- Daily cost by squad
CREATE OR REPLACE VIEW squads.v_daily_cost AS
SELECT
    DATE(created_at) as date,
    squad,
    SUM(cost_usd) as total_cost,
    SUM(input_tokens) as total_input_tokens,
    SUM(output_tokens) as total_output_tokens,
    COUNT(*) as generation_count
FROM squads.llm_generations
WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(created_at), squad
ORDER BY date DESC, total_cost DESC;

-- Agent performance summary
CREATE OR REPLACE VIEW squads.v_agent_performance AS
SELECT
    t.squad,
    t.agent,
    COUNT(*) as total_tasks,
    COUNT(*) FILTER (WHERE t.status = 'completed') as completed_tasks,
    COUNT(*) FILTER (WHERE t.success = true) as successful_tasks,
    ROUND(100.0 * COUNT(*) FILTER (WHERE t.success = true) / NULLIF(COUNT(*), 0), 2) as success_rate,
    AVG(f.quality_score) as avg_quality,
    SUM(t.total_cost_usd) as total_cost,
    AVG(t.duration_ms) / 1000 as avg_duration_sec
FROM squads.tasks t
LEFT JOIN squads.task_feedback f ON t.task_id = f.task_id
WHERE t.started_at >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY t.squad, t.agent;

-- Latest autonomy status
CREATE OR REPLACE VIEW squads.v_autonomy_status AS
SELECT
    COALESCE(ds.squad_name, 'Organization') as entity,
    s.score_date,
    s.overall_score,
    s.confidence_level,
    s.budget_compliance_score,
    s.cooldown_compliance_score,
    s.quality_score,
    s.success_rate_score,
    s.learning_utilization_score,
    s.total_executions,
    s.blocked_executions
FROM squads.fact_autonomy_scores s
LEFT JOIN squads.dim_squads ds ON s.squad_id = ds.id
WHERE s.score_date = CURRENT_DATE
ORDER BY s.overall_score DESC;

-- =============================================================================
-- HELPER FUNCTIONS
-- =============================================================================

-- Calculate daily autonomy score
CREATE OR REPLACE FUNCTION squads.calculate_autonomy_score(p_date DATE, p_squad_id INTEGER DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
    v_budget_score INTEGER;
    v_cooldown_score INTEGER;
    v_quality_score INTEGER;
    v_success_score INTEGER;
    v_learning_score INTEGER;
    v_overall INTEGER;
BEGIN
    -- Budget compliance (from preflight gates)
    SELECT COALESCE(
        ROUND(100.0 * COUNT(*) FILTER (WHERE (preflight_gates->>'budget'->>'ok')::boolean = true)
              / NULLIF(COUNT(*), 0)),
        100
    ) INTO v_budget_score
    FROM squads.fact_executions
    WHERE DATE(started_at) = p_date
      AND (p_squad_id IS NULL OR squad_id = p_squad_id);

    -- Cooldown compliance
    SELECT COALESCE(
        ROUND(100.0 * COUNT(*) FILTER (WHERE (preflight_gates->>'cooldown'->>'ok')::boolean = true)
              / NULLIF(COUNT(*), 0)),
        100
    ) INTO v_cooldown_score
    FROM squads.fact_executions
    WHERE DATE(started_at) = p_date
      AND (p_squad_id IS NULL OR squad_id = p_squad_id);

    -- Quality score (normalized from 1-5 to 0-100)
    SELECT COALESCE(ROUND(AVG(quality_score) * 20), 60) INTO v_quality_score
    FROM squads.task_feedback
    WHERE DATE(created_at) = p_date;

    -- Success rate
    SELECT COALESCE(
        ROUND(100.0 * COUNT(*) FILTER (WHERE status = 'completed' AND success = true)
              / NULLIF(COUNT(*), 0)),
        0
    ) INTO v_success_score
    FROM squads.tasks
    WHERE DATE(started_at) = p_date
      AND (p_squad_id IS NULL OR squad = (SELECT squad_name FROM squads.dim_squads WHERE id = p_squad_id));

    -- Learning utilization
    SELECT COALESCE(
        ROUND(100.0 * COUNT(*) FILTER (WHERE learnings_injected > 0)
              / NULLIF(COUNT(*), 0)),
        0
    ) INTO v_learning_score
    FROM squads.fact_executions
    WHERE DATE(started_at) = p_date
      AND (p_squad_id IS NULL OR squad_id = p_squad_id);

    -- Weighted average (adjust weights as needed)
    v_overall := ROUND(
        v_budget_score * 0.25 +
        v_cooldown_score * 0.15 +
        v_quality_score * 0.25 +
        v_success_score * 0.25 +
        v_learning_score * 0.10
    );

    RETURN v_overall;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- GRANTS
-- =============================================================================

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA squads TO squads;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA squads TO squads;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA squads TO squads;
