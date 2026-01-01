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

-- Grant permissions
GRANT ALL PRIVILEGES ON SCHEMA squads TO squads;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA squads TO squads;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA squads TO squads;
