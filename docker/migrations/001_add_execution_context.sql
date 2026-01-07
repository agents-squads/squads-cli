-- Migration: Add execution context columns for per-agent cost tracking
-- Issue: hq#101 - Agent execution value metrics
-- Date: 2026-01-07

-- Add execution context columns to llm_generations
ALTER TABLE squads.llm_generations
ADD COLUMN IF NOT EXISTS task_type VARCHAR(50) DEFAULT 'execution';

ALTER TABLE squads.llm_generations
ADD COLUMN IF NOT EXISTS trigger_source VARCHAR(50) DEFAULT 'manual';

ALTER TABLE squads.llm_generations
ADD COLUMN IF NOT EXISTS execution_id VARCHAR(100);

-- Add indexes for filtering
CREATE INDEX IF NOT EXISTS idx_llm_generations_task_type
ON squads.llm_generations(task_type);

CREATE INDEX IF NOT EXISTS idx_llm_generations_execution
ON squads.llm_generations(execution_id) WHERE execution_id IS NOT NULL;

-- Verify columns added
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_schema = 'squads'
  AND table_name = 'llm_generations'
  AND column_name IN ('task_type', 'trigger_source', 'execution_id');
