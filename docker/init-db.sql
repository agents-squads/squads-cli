-- Squads Local Database Initialization
-- Creates additional schemas/tables beyond what Langfuse creates

-- Schema for squads-specific data (separate from Langfuse)
CREATE SCHEMA IF NOT EXISTS squads;

-- GitHub metrics table - tracks git activity over time
CREATE TABLE IF NOT EXISTS squads.github_metrics (
    id SERIAL PRIMARY KEY,
    org VARCHAR(255) NOT NULL,
    repo VARCHAR(255) NOT NULL,
    metric_date DATE NOT NULL,

    -- Activity counts
    commits INTEGER DEFAULT 0,
    prs_opened INTEGER DEFAULT 0,
    prs_merged INTEGER DEFAULT 0,
    prs_closed INTEGER DEFAULT 0,
    issues_opened INTEGER DEFAULT 0,
    issues_closed INTEGER DEFAULT 0,
    reviews INTEGER DEFAULT 0,

    -- Code metrics
    additions INTEGER DEFAULT 0,
    deletions INTEGER DEFAULT 0,

    -- Quality signals
    avg_pr_cycle_hours NUMERIC(10,2),
    review_pass_rate NUMERIC(5,2),

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    UNIQUE(org, repo, metric_date)
);

-- Agent execution metrics - links to Langfuse traces
CREATE TABLE IF NOT EXISTS squads.agent_executions (
    id SERIAL PRIMARY KEY,
    squad VARCHAR(100) NOT NULL,
    agent VARCHAR(100) NOT NULL,
    execution_id VARCHAR(255), -- Links to Langfuse trace_id

    -- Timing
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    duration_ms INTEGER,

    -- Results
    status VARCHAR(50) DEFAULT 'running', -- running, completed, failed
    output_type VARCHAR(50), -- commit, pr, issue, file, etc
    output_ref VARCHAR(255), -- PR URL, commit SHA, etc

    -- Cost tracking (backup to Langfuse)
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd NUMERIC(10,6) DEFAULT 0,

    -- Metadata
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Baseline snapshots - for before/after comparison
CREATE TABLE IF NOT EXISTS squads.baselines (
    id SERIAL PRIMARY KEY,
    org VARCHAR(255) NOT NULL,
    name VARCHAR(100) NOT NULL,
    captured_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- 30-day metrics at capture time
    commits_30d INTEGER DEFAULT 0,
    prs_30d INTEGER DEFAULT 0,
    issues_30d INTEGER DEFAULT 0,
    avg_pr_cycle_hours NUMERIC(10,2),

    -- Metadata
    notes TEXT,

    UNIQUE(org, name)
);

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_github_metrics_date ON squads.github_metrics(metric_date DESC);
CREATE INDEX IF NOT EXISTS idx_github_metrics_repo ON squads.github_metrics(org, repo);
CREATE INDEX IF NOT EXISTS idx_agent_executions_squad ON squads.agent_executions(squad, agent);
CREATE INDEX IF NOT EXISTS idx_agent_executions_status ON squads.agent_executions(status);

-- Dashboard snapshots - full dashboard state over time
CREATE TABLE IF NOT EXISTS squads.dashboard_snapshots (
    id SERIAL PRIMARY KEY,
    captured_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Top-level metrics
    total_squads INTEGER DEFAULT 0,
    total_commits INTEGER DEFAULT 0,
    total_prs_merged INTEGER DEFAULT 0,
    total_issues_closed INTEGER DEFAULT 0,
    total_issues_open INTEGER DEFAULT 0,
    goal_progress_pct INTEGER DEFAULT 0,

    -- Cost metrics (from Langfuse)
    cost_usd NUMERIC(10,4) DEFAULT 0,
    daily_budget_usd NUMERIC(10,2) DEFAULT 50,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,

    -- Git activity
    commits_30d INTEGER DEFAULT 0,
    avg_commits_per_day NUMERIC(5,1) DEFAULT 0,
    active_days INTEGER DEFAULT 0,
    peak_commits INTEGER DEFAULT 0,
    peak_date DATE,

    -- Squad breakdown (JSONB for flexibility)
    squads_data JSONB DEFAULT '[]'::jsonb,
    -- Format: [{ name, commits, prs, issues_closed, issues_open, goals_active, goals_total, progress }]

    -- Authors breakdown
    authors_data JSONB DEFAULT '[]'::jsonb,
    -- Format: [{ name, commits }]

    -- Repos breakdown
    repos_data JSONB DEFAULT '[]'::jsonb
    -- Format: [{ name, commits }]
);

-- Index for time-series queries
CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_date ON squads.dashboard_snapshots(captured_at DESC);

-- =============================================================================
-- Telemetry Tables - Primary data store (Langfuse is optional forwarding)
-- =============================================================================

-- LLM generations - every API call to Claude/OpenAI
CREATE TABLE IF NOT EXISTS squads.llm_generations (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    trace_id VARCHAR(255),

    -- Context
    squad VARCHAR(100) DEFAULT 'hq',
    agent VARCHAR(100) DEFAULT 'coo',
    user_id VARCHAR(255),

    -- Model info
    model VARCHAR(100) NOT NULL,

    -- Token counts
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,

    -- Cost
    cost_usd NUMERIC(10,6) DEFAULT 0,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    duration_ms INTEGER,

    -- Metadata (prompt summary, response summary, etc)
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Tool executions - every tool call
CREATE TABLE IF NOT EXISTS squads.tool_executions (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255) NOT NULL,
    trace_id VARCHAR(255),

    -- Context
    squad VARCHAR(100) DEFAULT 'hq',
    agent VARCHAR(100) DEFAULT 'coo',

    -- Tool info
    tool_name VARCHAR(255) NOT NULL,
    success BOOLEAN DEFAULT true,

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    duration_ms INTEGER,

    -- Metadata (parameters, result summary)
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Sessions - groups related generations/tools
CREATE TABLE IF NOT EXISTS squads.sessions (
    id VARCHAR(255) PRIMARY KEY,
    squad VARCHAR(100) DEFAULT 'hq',
    agent VARCHAR(100) DEFAULT 'coo',
    user_id VARCHAR(255),

    -- Aggregated metrics (updated on each event)
    total_input_tokens INTEGER DEFAULT 0,
    total_output_tokens INTEGER DEFAULT 0,
    total_cost_usd NUMERIC(10,6) DEFAULT 0,
    generation_count INTEGER DEFAULT 0,
    tool_count INTEGER DEFAULT 0,

    -- Timing
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_activity_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Status
    status VARCHAR(50) DEFAULT 'active' -- active, completed, failed
);

-- Indexes for telemetry queries
CREATE INDEX IF NOT EXISTS idx_llm_generations_session ON squads.llm_generations(session_id);
CREATE INDEX IF NOT EXISTS idx_llm_generations_squad ON squads.llm_generations(squad, agent);
CREATE INDEX IF NOT EXISTS idx_llm_generations_created ON squads.llm_generations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON squads.tool_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_executions_tool ON squads.tool_executions(tool_name);
CREATE INDEX IF NOT EXISTS idx_sessions_squad ON squads.sessions(squad, agent);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON squads.sessions(status);

-- =============================================================================
-- Conversations - Captured from Claude Code sessions (engram hook)
-- =============================================================================

-- Conversations/memories from Claude Code sessions
CREATE TABLE IF NOT EXISTS squads.conversations (
    id SERIAL PRIMARY KEY,
    session_id VARCHAR(255),
    user_id VARCHAR(255) DEFAULT 'local',

    -- Content
    role VARCHAR(50) NOT NULL, -- user, assistant, thinking
    content TEXT NOT NULL,

    -- Classification
    message_type VARCHAR(50) DEFAULT 'message', -- message, thinking, decision, learning
    importance VARCHAR(20) DEFAULT 'normal', -- low, normal, high

    -- Context
    squad VARCHAR(100),
    agent VARCHAR(100),
    working_dir VARCHAR(500),

    -- Timing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Metadata (hook info, extracted entities, etc)
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Full-text search on content
CREATE INDEX IF NOT EXISTS idx_conversations_content_search
    ON squads.conversations USING gin(to_tsvector('english', content));
CREATE INDEX IF NOT EXISTS idx_conversations_session ON squads.conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON squads.conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_created ON squads.conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_type ON squads.conversations(message_type);
CREATE INDEX IF NOT EXISTS idx_conversations_importance ON squads.conversations(importance);

-- =============================================================================
-- CLI Events - Anonymous telemetry from squads-cli
-- =============================================================================

CREATE TABLE IF NOT EXISTS squads.cli_events (
    id SERIAL PRIMARY KEY,
    received_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

    -- Anonymous identification
    anonymous_id VARCHAR(100),

    -- Event data
    event_name VARCHAR(100) NOT NULL,
    cli_version VARCHAR(20),

    -- Properties (flexible JSON)
    properties JSONB DEFAULT '{}'::jsonb
);

-- Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_cli_events_name ON squads.cli_events(event_name);
CREATE INDEX IF NOT EXISTS idx_cli_events_received ON squads.cli_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_cli_events_anonymous ON squads.cli_events(anonymous_id);

-- Grant permissions
GRANT ALL PRIVILEGES ON SCHEMA squads TO squads;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA squads TO squads;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA squads TO squads;
