BEGIN;

-- Forward hardening for deployments that already recorded the original 0006.
-- Only the two frozen v1 shapes are legal: modern GJB_REF_V1 or historical
-- LEGACY_COMPAT. Free projects carry no process binding at all.
ALTER TABLE project DROP CONSTRAINT IF EXISTS project_process_binding_check;
ALTER TABLE project ADD CONSTRAINT project_process_binding_check CHECK (
  (
    project_type = 'free'
    AND process_version_id IS NULL
    AND process_profile_id IS NULL
    AND process_profile_version IS NULL
    AND process_profile_name IS NULL
  )
  OR
  (
    project_type = 'engineering'
    AND process_version_id IS NOT NULL
    AND process_profile_id IS NOT NULL
    AND process_profile_version IS NOT NULL
    AND process_profile_name IS NOT NULL
    AND (
      (
        process_version_id = 'GJB_REF_V1'
        AND process_profile_id = 'GJB_REF_V1'
        AND process_profile_version = 'GJB_REF_V1'
        AND process_profile_name = 'GJB 参考流程 v1'
      )
      OR
      (
        process_version_id = 'LEGACY_COMPAT'
        AND process_profile_id = 'LEGACY_COMPAT'
        AND process_profile_version = 'LEGACY_COMPAT'
        AND process_profile_name = '兼容旧流程'
      )
    )
  )
);

CREATE OR REPLACE FUNCTION synthia_reject_process_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'process version is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.profile_id IS DISTINCT FROM NEW.profile_id
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.name IS DISTINCT FROM NEW.name
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.status = 'retired' AND NEW.status IS DISTINCT FROM 'retired') THEN
    RAISE EXCEPTION 'process version is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS process_version_immutable ON process_version;
CREATE TRIGGER process_version_immutable BEFORE UPDATE OR DELETE ON process_version
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_process_version_mutation();

-- Keep the numbered-migration path semantically aligned with schema.sql.
-- These project ownership FKs and lookup indexes have always existed in the
-- fresh-install snapshot, but the original 0000 migration omitted them.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tool_run_project_id_fkey'
       AND conrelid = 'tool_run'::regclass
  ) THEN
    ALTER TABLE tool_run
      ADD CONSTRAINT tool_run_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES project(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'evidence_project_id_fkey'
       AND conrelid = 'evidence'::regclass
  ) THEN
    ALTER TABLE evidence
      ADD CONSTRAINT evidence_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES project(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'trace_relation_project_id_fkey'
       AND conrelid = 'trace_relation'::regclass
  ) THEN
    ALTER TABLE trace_relation
      ADD CONSTRAINT trace_relation_project_id_fkey
      FOREIGN KEY (project_id) REFERENCES project(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_revision_artifact
  ON artifact_revision (artifact_id, version);
CREATE INDEX IF NOT EXISTS idx_revision_project_state
  ON artifact_revision (project_id, state);
CREATE INDEX IF NOT EXISTS idx_submission_project_gate
  ON gate_submission (project_id, gate);
CREATE INDEX IF NOT EXISTS idx_approval_submission
  ON approval_record (gate_submission_id);
CREATE INDEX IF NOT EXISTS idx_baseline_project_kind
  ON baseline (project_id, kind) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_toolrun_project
  ON tool_run (project_id, state);
CREATE INDEX IF NOT EXISTS idx_evidence_run
  ON evidence (tool_run_id);
CREATE INDEX IF NOT EXISTS idx_trace_source
  ON trace_relation (project_id, source_id);
CREATE INDEX IF NOT EXISTS idx_trace_target
  ON trace_relation (project_id, target_id);
CREATE INDEX IF NOT EXISTS idx_trace_search
  ON trace_relation USING gin (source_id gin_trgm_ops, target_id gin_trgm_ops);

-- P1 formalization records only the project-level source relation. Artifacts,
-- revisions, roles, process instances and workspace content are deliberately
-- outside this relation and are not copied by the Core endpoint.
CREATE TABLE IF NOT EXISTS project_source_relation (
  target_project_id text PRIMARY KEY REFERENCES project(id),
  source_project_id text NOT NULL REFERENCES project(id),
  relation_kind text NOT NULL CHECK (relation_kind = 'copied_as_engineering'),
  created_by_type actor_type NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_project_id <> target_project_id)
);
CREATE INDEX IF NOT EXISTS project_source_relation_source_idx
  ON project_source_relation(source_project_id, created_at);
DROP TRIGGER IF EXISTS project_source_relation_append_only ON project_source_relation;
CREATE TRIGGER project_source_relation_append_only BEFORE UPDATE OR DELETE ON project_source_relation
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

INSERT INTO schema_migrations(version) VALUES ('0007_project_profile_constraints') ON CONFLICT (version) DO NOTHING;
COMMIT;
