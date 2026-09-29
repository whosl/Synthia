-- Human regeneralization derives an immutable version from an existing parent.
-- Automated versions still require exactly one distiller/curator provenance.
BEGIN;

ALTER TABLE learned_skill_version
  DROP CONSTRAINT IF EXISTS learned_skill_version_check;
ALTER TABLE learned_skill_version
  DROP CONSTRAINT IF EXISTS learned_skill_version_origin_check;
ALTER TABLE learned_skill_version
  ADD CONSTRAINT learned_skill_version_origin_check CHECK (
    num_nonnulls(distillation_run_id, curator_run_id) = 1
    OR (
      num_nonnulls(distillation_run_id, curator_run_id) = 0
      AND created_by_type = 'human'
      AND parent_version_id IS NOT NULL
    )
  );

INSERT INTO schema_migrations(version)
VALUES ('0038_learned_skill_manual_version') ON CONFLICT (version) DO NOTHING;
COMMIT;
