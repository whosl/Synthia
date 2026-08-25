BEGIN;

-- P4 versioned work, immutable bitstream classification and sealed delivery.
-- No backup/restore or Connector lifecycle state is introduced here.

CREATE TABLE IF NOT EXISTS project_work_version (
    id                       text PRIMARY KEY,
    project_id               text NOT NULL REFERENCES project(id),
    process_instance_id      text NOT NULL,
    version                  integer NOT NULL CHECK (version > 0),
    origin                   text NOT NULL CHECK (origin IN ('initial','change_request')),
    change_request_id        text,
    base_delivery_release_id text,
    start_gate               gate_id NOT NULL,
    current_gate             gate_id NOT NULL,
    state                    text NOT NULL DEFAULT 'working'
                               CHECK (state IN ('working','in_review','released','abandoned')),
    created_by_type          actor_type NOT NULL,
    created_by               text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at               timestamptz NOT NULL DEFAULT now(),
    released_at              timestamptz,
    abandoned_at             timestamptz,
    UNIQUE (id, project_id),
    UNIQUE (id, process_instance_id, project_id),
    UNIQUE (project_id, version),
    UNIQUE (change_request_id),
    FOREIGN KEY (process_instance_id, project_id)
      REFERENCES process_instance(id, project_id),
    CHECK (start_gate::text IN ('G0','G1','G2','G3','G4')),
    CHECK (current_gate::text IN ('G0','G1','G2','G3','G4')),
    CHECK (
      (origin = 'initial' AND change_request_id IS NULL AND base_delivery_release_id IS NULL)
      OR
      (origin = 'change_request' AND change_request_id IS NOT NULL AND base_delivery_release_id IS NOT NULL)
    ),
    CHECK (
      (state IN ('working','in_review') AND released_at IS NULL AND abandoned_at IS NULL)
      OR (state = 'released' AND released_at IS NOT NULL AND abandoned_at IS NULL)
      OR (state = 'abandoned' AND released_at IS NULL AND abandoned_at IS NOT NULL)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS project_work_version_one_active_idx
  ON project_work_version(project_id)
  WHERE state IN ('working','in_review');
CREATE INDEX IF NOT EXISTS project_work_version_project_idx
  ON project_work_version(project_id, version DESC);

-- Existing GJB_REF_V1 projects from 0009 already have a process instance but
-- predate versioned work.  Seed only the initial work-version ownership fact;
-- readiness, approvals, baselines, and releases remain strictly user-driven.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM project p
     WHERE p.process_version_id = 'GJB_REF_V1'
       AND NOT EXISTS (SELECT 1 FROM project_work_version w WHERE w.project_id = p.id)
       AND NOT EXISTS (
         SELECT 1 FROM process_instance pi
          WHERE pi.project_id = p.id AND pi.gate_profile_version = 'GJB_REF_V1'
       )
  ) THEN
    RAISE EXCEPTION 'cannot backfill GJB_REF_V1 work version without process instance'
      USING ERRCODE = '23514';
  END IF;
END;
$$;

WITH seeded_work_version AS (
  INSERT INTO project_work_version
    (id, project_id, process_instance_id, version, origin, start_gate,
     current_gate, state, created_by_type, created_by, created_at)
  SELECT 'wv-migrated-' || encode(digest(p.id || chr(31) || pi.id, 'sha256'), 'hex'),
         p.id, pi.id, 1, 'initial', 'G0', 'G0', 'working',
         'system', 'migration:0011_delivery_release', greatest(p.created_at, pi.created_at)
    FROM project p
    JOIN LATERAL (
      SELECT candidate.id, candidate.created_at
        FROM process_instance candidate
       WHERE candidate.project_id = p.id
         AND candidate.gate_profile_version = 'GJB_REF_V1'
       ORDER BY candidate.created_at, candidate.id
       LIMIT 1
    ) pi ON true
   WHERE p.process_version_id = 'GJB_REF_V1'
     AND NOT EXISTS (SELECT 1 FROM project_work_version w WHERE w.project_id = p.id)
  ON CONFLICT DO NOTHING
  RETURNING process_instance_id
)
UPDATE process_instance pi
   SET current_gate = 'G0'
  FROM seeded_work_version seeded
 WHERE pi.id = seeded.process_instance_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'configuration_snapshot_work_version_project_fk'
       AND conrelid = 'public.configuration_snapshot'::regclass
  ) THEN
    ALTER TABLE configuration_snapshot ADD CONSTRAINT configuration_snapshot_work_version_project_fk
      FOREIGN KEY (work_version_id, project_id)
      REFERENCES project_work_version(id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_submission_work_version_project_fk'
       AND conrelid = 'public.gate_submission'::regclass
  ) THEN
    ALTER TABLE gate_submission ADD CONSTRAINT gate_submission_work_version_project_fk
      FOREIGN KEY (work_version_id, project_id)
      REFERENCES project_work_version(id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_submission_work_process_project_fk'
       AND conrelid = 'public.gate_submission'::regclass
  ) THEN
    ALTER TABLE gate_submission ADD CONSTRAINT gate_submission_work_process_project_fk
      FOREIGN KEY (work_version_id, process_instance_id, project_id)
      REFERENCES project_work_version(id, process_instance_id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_submission_snapshot_work_project_fk'
       AND conrelid = 'public.gate_submission'::regclass
  ) THEN
    ALTER TABLE gate_submission ADD CONSTRAINT gate_submission_snapshot_work_project_fk
      FOREIGN KEY (snapshot_id, work_version_id, project_id)
      REFERENCES configuration_snapshot(id, work_version_id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_check_evaluation_submission_snapshot_work_project_fk'
       AND conrelid = 'public.gate_check_evaluation'::regclass
  ) THEN
    ALTER TABLE gate_check_evaluation ADD CONSTRAINT gate_check_evaluation_submission_snapshot_work_project_fk
      FOREIGN KEY (gate_submission_id, snapshot_id, work_version_id, project_id)
      REFERENCES gate_submission(id, snapshot_id, work_version_id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'formal_input_approval_work_version_project_fk'
       AND conrelid = 'public.formal_input_approval'::regclass
  ) THEN
    ALTER TABLE formal_input_approval ADD CONSTRAINT formal_input_approval_work_version_project_fk
      FOREIGN KEY (work_version_id, project_id)
      REFERENCES project_work_version(id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_readiness_work_version_project_fk'
       AND conrelid = 'public.project_readiness'::regclass
  ) THEN
    ALTER TABLE project_readiness ADD CONSTRAINT project_readiness_work_version_project_fk
      FOREIGN KEY (work_version_id, project_id)
      REFERENCES project_work_version(id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_check_evaluation_work_version_project_fk'
       AND conrelid = 'public.gate_check_evaluation'::regclass
  ) THEN
    ALTER TABLE gate_check_evaluation ADD CONSTRAINT gate_check_evaluation_work_version_project_fk
      FOREIGN KEY (work_version_id, project_id)
      REFERENCES project_work_version(id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_readiness_work_process_project_fk'
       AND conrelid = 'public.project_readiness'::regclass
  ) THEN
    ALTER TABLE project_readiness ADD CONSTRAINT project_readiness_work_process_project_fk
      FOREIGN KEY (work_version_id, process_instance_id, project_id)
      REFERENCES project_work_version(id, process_instance_id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_check_evaluation_work_process_project_fk'
       AND conrelid = 'public.gate_check_evaluation'::regclass
  ) THEN
    ALTER TABLE gate_check_evaluation ADD CONSTRAINT gate_check_evaluation_work_process_project_fk
      FOREIGN KEY (work_version_id, process_instance_id, project_id)
      REFERENCES project_work_version(id, process_instance_id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'formal_input_approval_work_process_project_fk'
       AND conrelid = 'public.formal_input_approval'::regclass
  ) THEN
    ALTER TABLE formal_input_approval ADD CONSTRAINT formal_input_approval_work_process_project_fk
      FOREIGN KEY (work_version_id, process_instance_id, project_id)
      REFERENCES project_work_version(id, process_instance_id, project_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_configuration_snapshot_work_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_version_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
      SELECT 1 FROM project_work_version w
       JOIN project p ON p.id = w.project_id
       WHERE w.id = NEW.work_version_id AND w.project_id = NEW.project_id
         AND w.state IN ('working','in_review')
         AND p.process_version_id = NEW.gate_profile_version
  ) THEN
    RAISE EXCEPTION 'versioned snapshot requires the active project work version'
      USING ERRCODE = '23514';
  END IF;
  IF cardinality(NEW.member_revision_ids) = 0
     OR array_position(NEW.member_revision_ids, NULL) IS NOT NULL
     OR (SELECT count(*) FROM unnest(NEW.member_revision_ids) AS member(member_id))
          <> (SELECT count(DISTINCT member_id) FROM unnest(NEW.member_revision_ids) AS member(member_id))
     OR EXISTS (
       SELECT 1 FROM unnest(NEW.member_revision_ids) AS member(member_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM artifact_revision ar
           WHERE ar.id = member_id AND ar.project_id = NEW.project_id
        )
     ) THEN
    RAISE EXCEPTION 'versioned snapshot members must be unique project revisions'
      USING ERRCODE = '23514';
  END IF;
  IF array_position(NEW.trace_relation_ids, NULL) IS NOT NULL
     OR (SELECT count(*) FROM unnest(NEW.trace_relation_ids) AS relation_ref(relation_id))
          <> (SELECT count(DISTINCT relation_id) FROM unnest(NEW.trace_relation_ids) AS relation_ref(relation_id))
     OR EXISTS (
       SELECT 1 FROM unnest(NEW.trace_relation_ids) AS relation_ref(relation_id)
        WHERE NOT EXISTS (
          SELECT 1 FROM trace_relation relation
           WHERE relation.id = relation_id AND relation.project_id = NEW.project_id
        )
     ) THEN
    RAISE EXCEPTION 'versioned snapshot traces must be unique project relations'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.manifest_hash !~ '^[0-9a-f]{64}$'
     OR NEW.tool_model_policy_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'versioned snapshot hashes must be lowercase SHA-256'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS configuration_snapshot_work_insert_guard ON configuration_snapshot;
CREATE TRIGGER configuration_snapshot_work_insert_guard
  BEFORE INSERT ON configuration_snapshot
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_configuration_snapshot_work_insert();

CREATE OR REPLACE FUNCTION synthia_validate_gate_submission_work_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_version_id IS NOT NULL AND (
    NOT EXISTS (
      SELECT 1 FROM project_work_version w
       WHERE w.id = NEW.work_version_id
         AND w.project_id = NEW.project_id
         AND w.process_instance_id = NEW.process_instance_id
         AND w.state IN ('working','in_review')
    ) OR NOT EXISTS (
      SELECT 1 FROM configuration_snapshot s
       WHERE s.id = NEW.snapshot_id AND s.project_id = NEW.project_id
         AND s.work_version_id = NEW.work_version_id
    )
  ) THEN
    RAISE EXCEPTION 'versioned submission requires one active work-version snapshot'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gate_submission_work_insert_guard ON gate_submission;
CREATE TRIGGER gate_submission_work_insert_guard
  BEFORE INSERT ON gate_submission
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_gate_submission_work_insert();

CREATE OR REPLACE FUNCTION synthia_validate_project_work_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_ordinal integer;
  new_ordinal integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project work version rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.process_instance_id IS DISTINCT FROM NEW.process_instance_id
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.origin IS DISTINCT FROM NEW.origin
     OR OLD.change_request_id IS DISTINCT FROM NEW.change_request_id
     OR OLD.base_delivery_release_id IS DISTINCT FROM NEW.base_delivery_release_id
     OR OLD.start_gate IS DISTINCT FROM NEW.start_gate
     OR OLD.created_by_type IS DISTINCT FROM NEW.created_by_type
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'project work version identity is immutable' USING ERRCODE = '55000';
  END IF;
  old_ordinal := substring(OLD.current_gate::text FROM 2)::integer;
  new_ordinal := substring(NEW.current_gate::text FROM 2)::integer;
  IF new_ordinal < old_ordinal THEN
    RAISE EXCEPTION 'project work version gate cannot move backwards' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'working' AND NEW.state = 'working' THEN
    IF NEW.released_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'working version has invalid terminal timestamps' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state = 'working' AND NEW.state = 'in_review' THEN
    IF NEW.released_at IS NOT NULL OR NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'in-review version has invalid terminal timestamps' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state IN ('working','in_review') AND NEW.state = 'released' THEN
    IF NEW.current_gate <> 'G4' OR NEW.released_at IS NULL OR NEW.abandoned_at IS NOT NULL THEN
      RAISE EXCEPTION 'released work version requires G4 and released_at' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.state IN ('working','in_review') AND NEW.state = 'abandoned' THEN
    IF NEW.abandoned_at IS NULL OR NEW.released_at IS NOT NULL THEN
      RAISE EXCEPTION 'abandoned work version requires abandoned_at' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal work version transition: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS project_work_version_state_guard ON project_work_version;
CREATE TRIGGER project_work_version_state_guard
  BEFORE UPDATE OR DELETE ON project_work_version
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_project_work_version_mutation();

CREATE TABLE IF NOT EXISTS bitstream_result (
    id                         text PRIMARY KEY,
    project_id                 text NOT NULL REFERENCES project(id),
    work_version_id            text NOT NULL,
    tool_run_id                text NOT NULL,
    evidence_manifest_id       text NOT NULL,
    evidence_manifest_hash     text NOT NULL CHECK (evidence_manifest_hash ~ '^[0-9a-f]{64}$'),
    evidence_entry_name        text NOT NULL CHECK (btrim(evidence_entry_name) <> ''),
    class                      text NOT NULL CHECK (class IN ('trial','formal')),
    formal_input_approval_id   text,
    snapshot_id                text,
    readiness_id               text,
    input_hash                 text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    engineering_config_hash    text CHECK (engineering_config_hash IS NULL OR engineering_config_hash ~ '^[0-9a-f]{64}$'),
    prerequisite_baseline_id   text,
    target_part                text NOT NULL CHECK (btrim(target_part) <> ''),
    toolchain_profile_hash     text NOT NULL CHECK (toolchain_profile_hash ~ '^[0-9a-f]{64}$'),
    constraint_hash            text CHECK (constraint_hash IS NULL OR constraint_hash ~ '^[0-9a-f]{64}$'),
    sha256                     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes                 bigint NOT NULL CHECK (size_bytes > 0),
    storage_uri                text NOT NULL CHECK (btrim(storage_uri) <> ''),
    generated_by_type          actor_type NOT NULL,
    generated_by               text NOT NULL CHECK (btrim(generated_by) <> ''),
    generated_at               timestamptz NOT NULL,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (tool_run_id, evidence_entry_name),
    FOREIGN KEY (work_version_id, project_id)
      REFERENCES project_work_version(id, project_id),
    FOREIGN KEY (tool_run_id, project_id)
      REFERENCES tool_run(id, project_id),
    FOREIGN KEY (evidence_manifest_id, tool_run_id, project_id)
      REFERENCES tool_run_evidence_manifest(id, tool_run_id, project_id),
    FOREIGN KEY (formal_input_approval_id, project_id)
      REFERENCES formal_input_approval(id, project_id),
    FOREIGN KEY (snapshot_id, project_id)
      REFERENCES configuration_snapshot(id, project_id),
    FOREIGN KEY (readiness_id, project_id)
      REFERENCES project_readiness(id, project_id),
    FOREIGN KEY (prerequisite_baseline_id, project_id)
      REFERENCES baseline(id, project_id),
    CHECK (
      class = 'trial'
      OR (
        formal_input_approval_id IS NOT NULL
        AND snapshot_id IS NOT NULL
        AND readiness_id IS NOT NULL
        AND engineering_config_hash IS NOT NULL
        AND prerequisite_baseline_id IS NOT NULL
        AND constraint_hash IS NOT NULL
      )
    )
);
CREATE INDEX IF NOT EXISTS bitstream_result_project_created_idx
  ON bitstream_result(project_id, created_at DESC);

CREATE OR REPLACE FUNCTION synthia_validate_bitstream_result_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM tool_run r
      JOIN tool_run_evidence_manifest m
        ON m.tool_run_id = r.id AND m.project_id = r.project_id
      JOIN tool_run_evidence_entry e
        ON e.manifest_id = m.id AND e.tool_run_id = r.id AND e.project_id = r.project_id
     WHERE r.id = NEW.tool_run_id
       AND r.project_id = NEW.project_id
       AND r.state = 'succeeded'
       AND r.operation = 'implement'
       AND r.input_hash = NEW.input_hash
       AND m.id = NEW.evidence_manifest_id
       AND m.manifest_hash = NEW.evidence_manifest_hash
       AND e.name = NEW.evidence_entry_name
       AND e.evidence_kind = 'bitstream'
       AND e.sha256 = NEW.sha256
       AND e.size_bytes = NEW.size_bytes
       AND e.uri = NEW.storage_uri
  ) THEN
    RAISE EXCEPTION 'bitstream does not match frozen implement evidence' USING ERRCODE = '23514';
  END IF;
  IF NEW.class = 'formal' AND NOT EXISTS (
    SELECT 1
      FROM formal_input_approval f
      JOIN baseline b ON b.id = f.baseline_id AND b.project_id = f.project_id
      JOIN tool_run r ON r.formal_input_approval_id = f.id AND r.project_id = f.project_id
     WHERE f.id = NEW.formal_input_approval_id
       AND f.project_id = NEW.project_id
       AND f.work_version_id = NEW.work_version_id
       AND f.confirmed_by IS NOT NULL
       AND f.snapshot_id = NEW.snapshot_id
       AND f.readiness_id = NEW.readiness_id
       AND f.input_hash = NEW.input_hash
       AND f.engineering_config_hash = NEW.engineering_config_hash
       AND f.target_part = NEW.target_part
       AND f.toolchain_profile_hash = NEW.toolchain_profile_hash
       AND f.constraint_hash = NEW.constraint_hash
       AND f.baseline_id = NEW.prerequisite_baseline_id
       AND b.kind = 'B1' AND b.state = 'active'
       AND r.id = NEW.tool_run_id
       AND r.run_class = 'formal'
       AND r.operation = 'implement'
       AND r.state = 'succeeded'
  ) THEN
    RAISE EXCEPTION 'formal bitstream requires a live confirmed formal binding' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS bitstream_result_validate ON bitstream_result;
CREATE TRIGGER bitstream_result_validate
  BEFORE INSERT ON bitstream_result
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_bitstream_result_insert();
DROP TRIGGER IF EXISTS bitstream_result_append_only ON bitstream_result;
CREATE TRIGGER bitstream_result_append_only
  BEFORE UPDATE OR DELETE ON bitstream_result
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

CREATE TABLE IF NOT EXISTS delivery_release (
    id                       text PRIMARY KEY,
    project_id               text NOT NULL REFERENCES project(id),
    version                  integer NOT NULL CHECK (version > 0),
    supersedes_release_id    text,
    process_version_id       text NOT NULL REFERENCES process_version(id),
    process_instance_id      text NOT NULL,
    work_version_id          text NOT NULL,
    gate_submission_id       text NOT NULL,
    gate_check_evaluation_id text NOT NULL,
    candidate_manifest_hash  text NOT NULL CHECK (candidate_manifest_hash ~ '^[0-9a-f]{64}$'),
    approval_record_id       text NOT NULL,
    approved_gate_result_id  text NOT NULL,
    baseline_id              text NOT NULL,
    formal_input_approval_id text NOT NULL,
    bitstream_result_id      text NOT NULL,
    schema_version           text NOT NULL DEFAULT 'delivery-manifest.v1'
                               CHECK (schema_version = 'delivery-manifest.v1'),
    manifest                 jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    manifest_hash            text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    item_count               integer NOT NULL CHECK (item_count > 0),
    state                    text NOT NULL DEFAULT 'sealed'
                               CHECK (state = 'sealed'),
    generated_by_type        actor_type NOT NULL,
    generated_by             text NOT NULL CHECK (btrim(generated_by) <> ''),
    generated_at             timestamptz NOT NULL DEFAULT now(),
    confirmed_by             text NOT NULL CHECK (btrim(confirmed_by) <> ''),
    confirmed_at             timestamptz NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    released_at              timestamptz NOT NULL,
    UNIQUE (id, project_id),
    UNIQUE (project_id, version),
    UNIQUE (project_id, manifest_hash),
    UNIQUE (work_version_id),
    UNIQUE (gate_check_evaluation_id),
    UNIQUE (bitstream_result_id),
    FOREIGN KEY (process_instance_id, project_id)
      REFERENCES process_instance(id, project_id),
    FOREIGN KEY (work_version_id, project_id)
      REFERENCES project_work_version(id, project_id),
    FOREIGN KEY (gate_submission_id, project_id)
      REFERENCES gate_submission(id, project_id),
    FOREIGN KEY (gate_check_evaluation_id, project_id)
      REFERENCES gate_check_evaluation(id, project_id),
    FOREIGN KEY (approval_record_id, project_id)
      REFERENCES approval_record(id, project_id),
    FOREIGN KEY (approved_gate_result_id, project_id)
      REFERENCES approved_gate_result(id, project_id),
    FOREIGN KEY (baseline_id, project_id) REFERENCES baseline(id, project_id),
    FOREIGN KEY (formal_input_approval_id, project_id)
      REFERENCES formal_input_approval(id, project_id),
    FOREIGN KEY (bitstream_result_id, project_id)
      REFERENCES bitstream_result(id, project_id),
    FOREIGN KEY (supersedes_release_id, project_id)
      REFERENCES delivery_release(id, project_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (released_at >= confirmed_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_release_unique_predecessor_idx
  ON delivery_release(supersedes_release_id) WHERE supersedes_release_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS delivery_release_item (
    id          text PRIMARY KEY,
    project_id  text NOT NULL REFERENCES project(id),
    release_id  text NOT NULL,
    category    text NOT NULL CHECK (category IN (
                  'rtl','tb','constraint','document','run_result','raw_evidence',
                  'confirmation','source','bitstream'
                )),
    path        text NOT NULL
                  CHECK (path <> '' AND path !~ '^/' AND path !~ '(^|/)\.\.?(/|$)'),
    source_type text NOT NULL CHECK (btrim(source_type) <> ''),
    source_id   text NOT NULL CHECK (btrim(source_id) <> ''),
    sha256      text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),
    media_type  text NOT NULL CHECK (btrim(media_type) <> ''),
    storage_uri text NOT NULL CHECK (btrim(storage_uri) <> ''),
    provenance  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provenance) = 'object'),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (release_id, path),
    FOREIGN KEY (release_id, project_id)
      REFERENCES delivery_release(id, project_id)
);
CREATE INDEX IF NOT EXISTS delivery_release_project_version_idx
  ON delivery_release(project_id, version DESC);

CREATE OR REPLACE FUNCTION synthia_validate_delivery_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM delivery_release r
     WHERE r.id = NEW.release_id
       AND r.project_id = NEW.project_id
       AND r.state = 'sealed'
       AND r.xmin = pg_current_xact_id()::text::xid
  ) THEN
    RAISE EXCEPTION 'delivery items can only be inserted in the release creation transaction' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS delivery_release_item_creation_guard ON delivery_release_item;
CREATE TRIGGER delivery_release_item_creation_guard
  BEFORE INSERT ON delivery_release_item
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_delivery_item_insert();
DROP TRIGGER IF EXISTS delivery_release_item_append_only ON delivery_release_item;
CREATE TRIGGER delivery_release_item_append_only
  BEFORE UPDATE OR DELETE ON delivery_release_item
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_delivery_release_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  predecessor_id text;
  predecessor_version integer;
BEGIN
  IF NEW.state <> 'sealed' THEN
    RAISE EXCEPTION 'delivery release state must be sealed' USING ERRCODE = '23514';
  END IF;
  IF NOT synthia_actor_is_active_human(NEW.confirmed_by) THEN
    RAISE EXCEPTION 'delivery release requires active human confirmation' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM project p
      JOIN project_work_version w ON w.project_id = p.id
      JOIN gate_submission gs ON gs.project_id = p.id
      JOIN gate_check_evaluation ge
        ON ge.gate_submission_id = gs.id AND ge.project_id = gs.project_id
      JOIN formal_input_approval f ON f.project_id = p.id
      JOIN baseline input_bl
        ON input_bl.id = f.baseline_id AND input_bl.project_id = f.project_id
      JOIN bitstream_result bs ON bs.project_id = p.id
      JOIN approval_record ar ON ar.project_id = p.id
      JOIN approved_gate_result agr
        ON agr.approval_record_id = ar.id AND agr.project_id = ar.project_id
      JOIN baseline bl
        ON bl.approved_gate_result_id = agr.id AND bl.project_id = agr.project_id
     WHERE p.id = NEW.project_id
       AND p.process_version_id = NEW.process_version_id
       AND w.id = NEW.work_version_id
       AND w.process_instance_id = NEW.process_instance_id
       AND w.state IN ('working','in_review')
       AND w.current_gate = 'G4'
       AND gs.id = NEW.gate_submission_id AND gs.gate = 'G4'
       AND gs.process_instance_id = w.process_instance_id
       AND gs.work_version_id = w.id
       AND gs.state IN ('in_review','approved')
       AND ge.id = NEW.gate_check_evaluation_id AND ge.passed
       AND ge.gate = 'G4'
       AND ge.work_version_id = w.id
       AND ge.process_instance_id = w.process_instance_id
       AND ge.sealed_projection IS NOT NULL
       AND ge.sealed_projection_hash = NEW.candidate_manifest_hash
       AND ge.sealed_projection->>'releaseId' = NEW.id
       AND (ge.sealed_projection->>'releaseVersion')::integer = NEW.version
       AND ge.sealed_projection->>'workVersionId' = w.id
       AND ge.sealed_projection->>'formalInputApprovalId' = f.id
       AND ge.sealed_projection->>'bitstreamResultId' = bs.id
       AND ge.sealed_projection->>'plannedApprovalRecordId' = ar.id
       AND (ge.sealed_projection->>'supersedesReleaseId')
             IS NOT DISTINCT FROM NEW.supersedes_release_id
       AND f.id = NEW.formal_input_approval_id
       AND f.work_version_id = w.id
       AND f.process_instance_id = w.process_instance_id
       AND f.confirmed_by IS NOT NULL
       AND synthia_actor_is_active_human(f.confirmed_by)
       AND input_bl.kind = 'B1' AND input_bl.state = 'active'
       AND bs.id = NEW.bitstream_result_id
       AND bs.work_version_id = w.id AND bs.class = 'formal'
       AND bs.formal_input_approval_id = f.id
       AND bs.input_hash = f.input_hash
       AND ar.id = NEW.approval_record_id
       AND ar.gate_submission_id = gs.id
       AND ar.decision = 'approve'
       AND ar.approver_id = NEW.confirmed_by
       AND ar.approved_gate_result_id = agr.id
       AND agr.id = NEW.approved_gate_result_id
       AND agr.gate_submission_id = gs.id
       AND agr.gate = 'G4'
       AND agr.snapshot_id = ge.snapshot_id
       AND bl.id = NEW.baseline_id
       AND bl.approval_record_id = ar.id
       AND bl.kind = 'B2' AND bl.state = 'active'
  ) THEN
    RAISE EXCEPTION 'sealed delivery facts do not form one approved G4 input' USING ERRCODE = '23514';
  END IF;
  SELECT predecessor.id, predecessor.version
    INTO predecessor_id, predecessor_version
    FROM delivery_release predecessor
   WHERE predecessor.project_id = NEW.project_id
     AND predecessor.state = 'sealed'
   ORDER BY predecessor.version DESC
   LIMIT 1
   FOR UPDATE;
  IF predecessor_id IS NULL THEN
    IF NEW.version <> 1 OR NEW.supersedes_release_id IS NOT NULL THEN
      RAISE EXCEPTION 'first delivery release must be version 1 without predecessor' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.version <> predecessor_version + 1
     OR NEW.supersedes_release_id IS DISTINCT FROM predecessor_id THEN
    RAISE EXCEPTION 'delivery predecessor must be the latest sealed project release' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS delivery_release_insert_guard ON delivery_release;
CREATE TRIGGER delivery_release_insert_guard
  BEFORE INSERT ON delivery_release
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_delivery_release_insert();

CREATE OR REPLACE FUNCTION synthia_validate_delivery_release_complete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_count integer;
  missing_categories integer;
  manifest_count integer;
BEGIN
  IF NEW.manifest->>'schema' IS DISTINCT FROM NEW.schema_version
     OR NEW.manifest->>'project_id' IS DISTINCT FROM NEW.project_id
     OR NEW.manifest->>'release_id' IS DISTINCT FROM NEW.id
     OR (NEW.manifest->>'version')::integer IS DISTINCT FROM NEW.version
     OR NEW.manifest->>'work_version_id' IS DISTINCT FROM NEW.work_version_id
     OR NOT EXISTS (
       SELECT 1 FROM formal_input_approval f
        WHERE f.id = NEW.formal_input_approval_id
          AND f.project_id = NEW.project_id
          AND NEW.manifest->>'input_hash' = f.input_hash
     ) THEN
    RAISE EXCEPTION 'delivery manifest identity does not match the sealed release' USING ERRCODE = '23514';
  END IF;
  IF jsonb_typeof(NEW.manifest->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'delivery manifest items must be an array' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer INTO actual_count
    FROM delivery_release_item
   WHERE release_id = NEW.id AND project_id = NEW.project_id;
  manifest_count := jsonb_array_length(NEW.manifest->'items');
  SELECT count(*)::integer INTO missing_categories
    FROM unnest(ARRAY['rtl','tb','constraint','document','run_result','raw_evidence','confirmation','source','bitstream']) required(category)
   WHERE NOT EXISTS (
     SELECT 1 FROM delivery_release_item i
      WHERE i.release_id = NEW.id AND i.project_id = NEW.project_id
        AND i.category = required.category
   );
  IF actual_count IS DISTINCT FROM NEW.item_count
     OR manifest_count IS DISTINCT FROM NEW.item_count
     OR missing_categories <> 0 THEN
    RAISE EXCEPTION 'sealed delivery release item set is incomplete' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM delivery_release_item i
     WHERE i.release_id = NEW.id AND i.project_id = NEW.project_id
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(NEW.manifest->'items') manifest_item
          WHERE manifest_item->>'category' = i.category
            AND manifest_item->>'path' = i.path
            AND manifest_item->>'source_type' = i.source_type
            AND manifest_item->>'source_id' = i.source_id
            AND manifest_item->>'sha256' = i.sha256
            AND (manifest_item->>'size_bytes')::bigint = i.size_bytes
            AND manifest_item->>'media_type' = i.media_type
            AND manifest_item->>'storage_uri' = i.storage_uri
            AND manifest_item->'provenance' = i.provenance
       )
  ) THEN
    RAISE EXCEPTION 'delivery manifest does not match sealed release items' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM delivery_release_item i
       JOIN bitstream_result b
         ON b.id = i.source_id AND b.project_id = i.project_id
      WHERE i.release_id = NEW.id AND i.project_id = NEW.project_id
        AND i.category = 'bitstream'
        AND i.source_type = 'bitstream_result'
        AND i.source_id = NEW.bitstream_result_id
        AND i.sha256 = b.sha256
        AND i.size_bytes = b.size_bytes
        AND b.class = 'formal') <> 1 THEN
    RAISE EXCEPTION 'delivery release requires exactly one bound formal bitstream item' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM formal_input_approval f
     WHERE f.id = NEW.formal_input_approval_id AND f.project_id = NEW.project_id
       AND EXISTS (
         SELECT 1 FROM delivery_release_item i
          WHERE i.release_id = NEW.id AND i.project_id = NEW.project_id
            AND i.category = 'confirmation'
            AND i.source_type = 'project_readiness' AND i.source_id = f.readiness_id
       )
       AND EXISTS (
         SELECT 1 FROM delivery_release_item i
          WHERE i.release_id = NEW.id AND i.project_id = NEW.project_id
            AND i.category = 'confirmation'
            AND i.source_type = 'formal_input_approval' AND i.source_id = f.id
       )
       AND EXISTS (
         SELECT 1 FROM delivery_release_item i
          WHERE i.release_id = NEW.id AND i.project_id = NEW.project_id
            AND i.category = 'confirmation'
            AND i.source_type = 'approval_record' AND i.source_id = NEW.approval_record_id
       )
  ) THEN
    RAISE EXCEPTION 'delivery release requires readiness, input, and gate confirmations' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS delivery_release_append_only ON delivery_release;
CREATE TRIGGER delivery_release_append_only
  BEFORE UPDATE OR DELETE ON delivery_release
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS delivery_release_complete_guard ON delivery_release;
CREATE CONSTRAINT TRIGGER delivery_release_complete_guard
  AFTER INSERT ON delivery_release
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_delivery_release_complete();

CREATE TABLE IF NOT EXISTS change_request (
    id                       text PRIMARY KEY,
    project_id               text NOT NULL REFERENCES project(id),
    base_delivery_release_id text NOT NULL,
    project_work_version_id  text NOT NULL,
    reason                   text NOT NULL CHECK (btrim(reason) <> ''),
    affected_paths           text[] NOT NULL CHECK (cardinality(affected_paths) > 0),
    impact_gate              gate_id NOT NULL CHECK (impact_gate::text IN ('G1','G2','G3','G4')),
    request_hash             text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    state                    text NOT NULL DEFAULT 'open'
                               CHECK (state IN ('open','released','withdrawn')),
    proposed_by_type         actor_type NOT NULL,
    proposed_by              text NOT NULL CHECK (btrim(proposed_by) <> ''),
    proposed_at              timestamptz NOT NULL DEFAULT now(),
    confirmed_by             text NOT NULL CHECK (btrim(confirmed_by) <> ''),
    confirmed_at             timestamptz NOT NULL,
    released_at              timestamptz,
    withdrawn_at             timestamptz,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (project_work_version_id),
    UNIQUE (project_id, request_hash),
    CHECK (array_position(affected_paths, NULL) IS NULL),
    CHECK (
      (state = 'open' AND released_at IS NULL AND withdrawn_at IS NULL)
      OR (state = 'released' AND released_at IS NOT NULL AND withdrawn_at IS NULL)
      OR (state = 'withdrawn' AND released_at IS NULL AND withdrawn_at IS NOT NULL)
    )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'change_request_release_project_fk'
       AND conrelid = 'public.change_request'::regclass
  ) THEN
    ALTER TABLE change_request ADD CONSTRAINT change_request_release_project_fk
      FOREIGN KEY (base_delivery_release_id, project_id)
      REFERENCES delivery_release(id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'change_request_work_version_project_fk'
       AND conrelid = 'public.change_request'::regclass
  ) THEN
    ALTER TABLE change_request ADD CONSTRAINT change_request_work_version_project_fk
      FOREIGN KEY (project_work_version_id, project_id)
      REFERENCES project_work_version(id, project_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_work_version_change_request_project_fk'
       AND conrelid = 'public.project_work_version'::regclass
  ) THEN
    ALTER TABLE project_work_version ADD CONSTRAINT project_work_version_change_request_project_fk
      FOREIGN KEY (change_request_id, project_id)
      REFERENCES change_request(id, project_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_work_version_base_release_project_fk'
       AND conrelid = 'public.project_work_version'::regclass
  ) THEN
    ALTER TABLE project_work_version ADD CONSTRAINT project_work_version_base_release_project_fk
      FOREIGN KEY (base_delivery_release_id, project_id)
      REFERENCES delivery_release(id, project_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_change_request_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT synthia_actor_is_active_human(NEW.confirmed_by) THEN
    RAISE EXCEPTION 'change request requires active human confirmation' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM delivery_release r
     WHERE r.id = NEW.base_delivery_release_id
       AND r.project_id = NEW.project_id
       AND r.state = 'sealed'
       AND NOT EXISTS (
         SELECT 1 FROM delivery_release newer
          WHERE newer.project_id = r.project_id
            AND newer.state = 'sealed'
            AND newer.version > r.version
       )
  ) THEN
    RAISE EXCEPTION 'change request must bind the latest sealed delivery' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM project_work_version
     WHERE project_id = NEW.project_id AND state IN ('working','in_review')
  ) THEN
    RAISE EXCEPTION 'project already has an active work version' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS change_request_insert_guard ON change_request;
CREATE TRIGGER change_request_insert_guard
  BEFORE INSERT ON change_request
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_change_request_insert();

CREATE OR REPLACE FUNCTION synthia_validate_change_request_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'change request rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.base_delivery_release_id IS DISTINCT FROM NEW.base_delivery_release_id
     OR OLD.project_work_version_id IS DISTINCT FROM NEW.project_work_version_id
     OR OLD.reason IS DISTINCT FROM NEW.reason
     OR OLD.affected_paths IS DISTINCT FROM NEW.affected_paths
     OR OLD.impact_gate IS DISTINCT FROM NEW.impact_gate
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
     OR OLD.proposed_by_type IS DISTINCT FROM NEW.proposed_by_type
     OR OLD.proposed_by IS DISTINCT FROM NEW.proposed_by
     OR OLD.proposed_at IS DISTINCT FROM NEW.proposed_at
     OR OLD.confirmed_by IS DISTINCT FROM NEW.confirmed_by
     OR OLD.confirmed_at IS DISTINCT FROM NEW.confirmed_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'change request content is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'open' AND NEW.state = 'released'
     AND NEW.released_at IS NOT NULL AND NEW.withdrawn_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'open' AND NEW.state = 'withdrawn'
     AND NEW.withdrawn_at IS NOT NULL AND NEW.released_at IS NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal change request transition: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS change_request_state_guard ON change_request;
CREATE TRIGGER change_request_state_guard
  BEFORE UPDATE OR DELETE ON change_request
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_change_request_mutation();

INSERT INTO schema_migrations(version)
  VALUES ('0011_delivery_release')
  ON CONFLICT (version) DO NOTHING;
COMMIT;
