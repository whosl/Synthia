-- 0014: tool_timing_metrics — sta.rpt 摘要的解析缓存（tool-summary 端点供给）。
-- 每条成功 implement 的 sta.rpt 只解析一次；之后端点纯 DB 供给。
-- job_id 为主键：一个 job 的时序结论是历史事实，不随重解析变化（重跑
-- implement 产生新 job_id，自然获得新行）。

CREATE TABLE IF NOT EXISTS tool_timing_metrics (
  job_id     TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  wns        NUMERIC,
  tns        NUMERIC,
  whs        NUMERIC,
  status     TEXT NOT NULL,
  clocks     JSONB NOT NULL DEFAULT '[]'::jsonb,
  parsed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tool_timing_metrics_project_parsed_idx
  ON tool_timing_metrics (project_id, parsed_at DESC);

INSERT INTO schema_migrations(version) VALUES ('0014_tool_timing_metrics') ON CONFLICT (version) DO NOTHING;
