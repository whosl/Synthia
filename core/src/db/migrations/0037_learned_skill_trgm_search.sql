-- Learned-skill search recall: agents query in Chinese while slugs/names
-- are English compounds, and the previous ILIKE-only match never bridged
-- that gap. pg_trgm similarity over name/summary/applicability_summary
-- lets a symptom-phrased query hit the Chinese summaries distillation
-- actually writes.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS learned_skill_name_trgm_idx
  ON learned_skill USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS learned_skill_summary_trgm_idx
  ON learned_skill USING gin (summary gin_trgm_ops);
CREATE INDEX IF NOT EXISTS learned_skill_applicability_trgm_idx
  ON learned_skill USING gin (applicability_summary gin_trgm_ops);

INSERT INTO schema_migrations(version) VALUES ('0037_learned_skill_trgm_search') ON CONFLICT (version) DO NOTHING;
