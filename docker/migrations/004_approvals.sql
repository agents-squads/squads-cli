-- =============================================================================
-- 004_approvals.sql - Slack approval workflow for autonomous agents
-- =============================================================================

-- Ensure schema exists
CREATE SCHEMA IF NOT EXISTS squads;

-- Approval types
DO $$ BEGIN
    CREATE TYPE squads.approval_type AS ENUM (
        'issue',      -- Agent wants to create GitHub issue
        'pr',         -- Agent created PR, needs merge approval
        'content',    -- Content draft ready for publishing
        'run',        -- Pre-execution approval for scheduled runs
        'brief'       -- Intelligence brief ready for action
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Approval status (state machine: pending -> approved/rejected/expired/cancelled)
DO $$ BEGIN
    CREATE TYPE squads.approval_status AS ENUM (
        'pending',
        'approved',
        'rejected',
        'expired',
        'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Main approvals table
CREATE TABLE IF NOT EXISTS squads.approvals (
    id SERIAL PRIMARY KEY,
    approval_id VARCHAR(100) UNIQUE NOT NULL,  -- appr_<timestamp>_<random>

    -- Type and source
    type squads.approval_type NOT NULL,
    squad VARCHAR(100) NOT NULL,
    agent VARCHAR(100),

    -- What needs approval
    title TEXT NOT NULL,
    description TEXT,
    payload JSONB NOT NULL DEFAULT '{}',

    -- Slack message tracking
    slack_channel VARCHAR(100),
    slack_ts VARCHAR(50),

    -- Status
    status squads.approval_status NOT NULL DEFAULT 'pending',

    -- Decision tracking
    decided_by VARCHAR(100),
    decided_at TIMESTAMPTZ,
    decision_reason TEXT,

    -- Outcome
    outcome_ref VARCHAR(500),
    outcome_details JSONB,

    -- Timing
    priority INT DEFAULT 5,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_approvals_pending
    ON squads.approvals(status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_type
    ON squads.approvals(type, status);
CREATE INDEX IF NOT EXISTS idx_approvals_squad
    ON squads.approvals(squad, agent);
CREATE INDEX IF NOT EXISTS idx_approvals_expires
    ON squads.approvals(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_slack_ts
    ON squads.approvals(slack_ts) WHERE slack_ts IS NOT NULL;

-- Audit trail
CREATE TABLE IF NOT EXISTS squads.approval_events (
    id SERIAL PRIMARY KEY,
    approval_id VARCHAR(100) REFERENCES squads.approvals(approval_id) ON DELETE CASCADE,
    event_type VARCHAR(50) NOT NULL,  -- created, approved, rejected, expired, reminded
    actor VARCHAR(100),
    actor_type VARCHAR(20) DEFAULT 'human',
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_events_approval
    ON squads.approval_events(approval_id);

-- View for pending approvals with timing info
CREATE OR REPLACE VIEW squads.pending_approvals AS
SELECT
    a.*,
    EXTRACT(EPOCH FROM (NOW() - a.created_at)) / 3600 as age_hours,
    EXTRACT(EPOCH FROM (a.expires_at - NOW())) / 3600 as hours_remaining
FROM squads.approvals a
WHERE a.status = 'pending'
ORDER BY a.priority ASC, a.created_at ASC;

-- Grant permissions
GRANT ALL PRIVILEGES ON squads.approvals TO squads;
GRANT ALL PRIVILEGES ON squads.approval_events TO squads;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA squads TO squads;
