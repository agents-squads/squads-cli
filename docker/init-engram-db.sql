-- =============================================================================
-- Engram Database Initialization
-- =============================================================================
-- Creates the engram database with pgvector extension for memory storage
-- This script runs after init-db.sql (squads schema)

-- Create engram database
SELECT 'CREATE DATABASE engram'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'engram')\gexec

-- Connect to engram database and set up extensions
\c engram

-- Enable pgvector for vector similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Enable pg_trgm for fuzzy text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create engram schema
CREATE SCHEMA IF NOT EXISTS engram;

-- =============================================================================
-- Auth Tables - Token-based authentication for MCP server
-- =============================================================================

-- Users table
CREATE TABLE IF NOT EXISTS engram.users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- API tokens table
CREATE TABLE IF NOT EXISTS engram.tokens (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES engram.users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    last_used_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    revoked_at TIMESTAMP WITH TIME ZONE
);

-- Token usage audit log
CREATE TABLE IF NOT EXISTS engram.token_usage (
    id SERIAL PRIMARY KEY,
    token_id INTEGER REFERENCES engram.tokens(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES engram.users(id) ON DELETE SET NULL,
    endpoint VARCHAR(255),
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- Memory Tables - Core memory storage
-- =============================================================================

-- Note: mem0 creates its own tables for memory storage
-- These are additional tables for Engram-specific features

-- Memory metadata (extends mem0 memories)
CREATE TABLE IF NOT EXISTS engram.memory_metadata (
    id SERIAL PRIMARY KEY,
    memory_id VARCHAR(255) UNIQUE NOT NULL,  -- Links to mem0 memory
    user_id INTEGER REFERENCES engram.users(id),
    project_id VARCHAR(255),
    importance FLOAT DEFAULT 0.5,
    access_count INTEGER DEFAULT 0,
    last_accessed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Memory chunks (for large text chunking)
CREATE TABLE IF NOT EXISTS engram.memory_chunks (
    id SERIAL PRIMARY KEY,
    parent_memory_id VARCHAR(255) NOT NULL,
    chunk_index INTEGER NOT NULL,
    total_chunks INTEGER NOT NULL,
    chunk_size INTEGER NOT NULL,
    has_overlap BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(parent_memory_id, chunk_index)
);

-- =============================================================================
-- Graph Sync Tables - Tracks Neo4j synchronization
-- =============================================================================

CREATE TABLE IF NOT EXISTS engram.graph_sync_log (
    id SERIAL PRIMARY KEY,
    memory_id VARCHAR(255) NOT NULL,
    sync_type VARCHAR(50) NOT NULL,  -- 'create', 'update', 'delete', 'link'
    status VARCHAR(50) NOT NULL,      -- 'pending', 'synced', 'failed'
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    synced_at TIMESTAMP WITH TIME ZONE
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Auth indexes
CREATE INDEX IF NOT EXISTS idx_tokens_user ON engram.tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON engram.tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_token_usage_token ON engram.token_usage(token_id);
CREATE INDEX IF NOT EXISTS idx_token_usage_created ON engram.token_usage(created_at DESC);

-- Memory indexes
CREATE INDEX IF NOT EXISTS idx_memory_metadata_user ON engram.memory_metadata(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_metadata_project ON engram.memory_metadata(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_metadata_importance ON engram.memory_metadata(importance DESC);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_parent ON engram.memory_chunks(parent_memory_id);

-- Graph sync indexes
CREATE INDEX IF NOT EXISTS idx_graph_sync_memory ON engram.graph_sync_log(memory_id);
CREATE INDEX IF NOT EXISTS idx_graph_sync_status ON engram.graph_sync_log(status);
CREATE INDEX IF NOT EXISTS idx_graph_sync_pending ON engram.graph_sync_log(status) WHERE status = 'pending';

-- =============================================================================
-- Default User (for local development)
-- =============================================================================

INSERT INTO engram.users (email, name)
VALUES ('local@squads.dev', 'Local Development User')
ON CONFLICT (email) DO NOTHING;

-- Grant permissions
GRANT ALL PRIVILEGES ON SCHEMA engram TO squads;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA engram TO squads;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA engram TO squads;

-- =============================================================================
-- Verify setup
-- =============================================================================

DO $$
BEGIN
    RAISE NOTICE 'Engram database initialized successfully';
    RAISE NOTICE 'Extensions: vector, pg_trgm';
    RAISE NOTICE 'Schema: engram';
END $$;
