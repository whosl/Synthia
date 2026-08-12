BEGIN;

-- Synthia Core — ToolRun execution-result columns (IF-002 run/connector slice)
-- Adds the terminal-state persistence columns the Core↔Connector run API writes
-- when it proxies Connector job status and evidence:
--   - error_code      : connector-reported failure code (terminal failure states)
--   - output_sha256   : SHA-256 of the connector-produced primary output artifact
--   - evidence        : frozen evidence manifest (jsonb) for a terminal job
-- These are NULL on creation (POST /jobs creates a run in state 'submitted') and
-- are filled by GET /jobs/:id (status refresh) and GET /jobs/:id/evidence.
-- Safe to re-run; fully transactional. Depends on 0000 (tool_run table).
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS output_sha256 text;
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS evidence jsonb;

INSERT INTO schema_migrations(version) VALUES ('0004_tool_run_evidence') ON CONFLICT (version) DO NOTHING;
COMMIT;
