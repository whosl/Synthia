BEGIN;

-- P4 process profile, engineering readiness, frozen gate checks and formal
-- execution inputs.  The G0-G9 enum remains for legacy rows, while this
-- versioned profile is the authoritative data source for the v1 G0-G4 path.

CREATE TABLE IF NOT EXISTS process_gate_definition (
    process_version_id text NOT NULL REFERENCES process_version(id),
    gate               gate_id NOT NULL,
    ordinal            integer NOT NULL CHECK (ordinal BETWEEN 0 AND 4),
    name                text NOT NULL CHECK (btrim(name) <> ''),
    goal                text NOT NULL CHECK (btrim(goal) <> ''),
    activities          jsonb NOT NULL CHECK (jsonb_typeof(activities) = 'array'),
    required_checks     jsonb NOT NULL CHECK (jsonb_typeof(required_checks) = 'array'),
    milestone_baseline  baseline_kind,
    profile_hash        text NOT NULL CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (process_version_id, gate),
    UNIQUE (process_version_id, ordinal),
    CHECK (process_version_id <> 'GJB_REF_V1' OR gate::text = ('G' || ordinal::text)),
    CHECK (
      process_version_id <> 'GJB_REF_V1'
      OR (gate IN ('G0','G2') AND milestone_baseline IS NULL)
      OR (gate = 'G1' AND milestone_baseline = 'B0')
      OR (gate = 'G3' AND milestone_baseline = 'B1')
      OR (gate = 'G4' AND milestone_baseline = 'B2')
    )
);

INSERT INTO process_gate_definition
  (process_version_id, gate, ordinal, name, goal, activities, required_checks,
   milestone_baseline, profile_hash)
SELECT 'GJB_REF_V1', gate::gate_id, ordinal, name, goal, activities::jsonb,
       required_checks::jsonb, milestone_baseline::baseline_kind,
       '0f503a9bf66e0226f2242cfeb6d42b51d2172afc8dc2584f230e0e03f33f3c5e'
  FROM (VALUES
  ('G0', 0, '项目准备', '记录项目边界、器件与工具准备状态',
   '["prepare_project"]',
   '[{"code":"project.engineering","severity":"hard"},{"code":"process.bound","severity":"hard"},{"code":"data_scope.recorded","severity":"hard"},{"code":"target_part.recorded","severity":"hard"},{"code":"board_status.recorded","severity":"hard"},{"code":"source_materials.recorded","severity":"hard"},{"code":"workspace.ready","severity":"hard"},{"code":"toolchain.bound","severity":"hard"}]', NULL),
  ('G1', 1, '需求确认', '确认需求来源、接口、验收目标与关键风险',
   '["intake"]',
   '[{"code":"artifact.development_requirements","severity":"hard"},{"code":"snapshot.members_frozen","severity":"hard"}]', 'B0'),
  ('G2', 2, '行为与验证方案', '确认功能、时序、异常行为及需求对应的验证方法',
   '["behavior_wave","verification_plan"]',
   '[{"code":"artifact.behavior_spec","severity":"hard"},{"code":"artifact.verification_method_map","severity":"hard"},{"code":"snapshot.members_frozen","severity":"hard"}]', NULL),
  ('G3', 3, '设计确认', '确认架构、接口、寄存器、时钟复位、约束策略与关键边界',
   '["architecture","register_spec","constraint_strategy"]',
   '[{"code":"artifact.architecture_design","severity":"hard"},{"code":"artifact.detailed_design","severity":"hard"},{"code":"artifact.constraint_design","severity":"hard"},{"code":"snapshot.members_frozen","severity":"hard"}]', 'B1'),
  ('G4', 4, '实现与交付', '由同一不可变输入生成、验证并交付可追溯的正式结果',
   '["rtl_build","validate","tb","simulate","xdc","implement","delivery"]',
   '[{"code":"artifact.rtl","severity":"hard"},{"code":"artifact.testbench","severity":"hard"},{"code":"artifact.constraints","severity":"hard"},{"code":"formal_input.confirmed","severity":"hard"},{"code":"constraints.complete","severity":"hard"},{"code":"formal_simulation.succeeded","severity":"hard"},{"code":"formal_implementation.succeeded","severity":"hard"},{"code":"drc.clean","severity":"hard"},{"code":"timing.met","severity":"hard"},{"code":"evidence.frozen","severity":"hard"},{"code":"bitstream.formal","severity":"hard"},{"code":"delivery.manifest_sealed","severity":"hard"}]', 'B2')
 ) AS definition(gate, ordinal, name, goal, activities, required_checks, milestone_baseline)
ON CONFLICT (process_version_id, gate) DO NOTHING;

CREATE OR REPLACE FUNCTION synthia_validate_process_gate_definition_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'process gate definition is immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS process_gate_definition_immutable ON process_gate_definition;
CREATE TRIGGER process_gate_definition_immutable
  BEFORE UPDATE OR DELETE ON process_gate_definition
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_process_gate_definition_mutation();

-- Legacy snapshots and submissions predate versioned project work.  Keep the
-- new ownership column nullable for those historical rows; 0011 adds strict
-- work-version foreign keys for the P4 path while legacy inserts remain valid.
ALTER TABLE configuration_snapshot
  ADD COLUMN IF NOT EXISTS work_version_id text;
ALTER TABLE gate_submission
  ADD COLUMN IF NOT EXISTS work_version_id text;
CREATE UNIQUE INDEX IF NOT EXISTS gate_submission_one_active_work_idx
  ON gate_submission(project_id, work_version_id)
  WHERE work_version_id IS NOT NULL
    AND state IN ('preparing','submitted','checking','in_review');
DROP TRIGGER IF EXISTS configuration_snapshot_append_only ON configuration_snapshot;
CREATE TRIGGER configuration_snapshot_append_only
  BEFORE UPDATE OR DELETE ON configuration_snapshot
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

-- Composite candidate keys are the ownership anchors for every P4 resource.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'configuration_snapshot_id_project_unique'
       AND conrelid = 'public.configuration_snapshot'::regclass
  ) THEN
    ALTER TABLE configuration_snapshot ADD CONSTRAINT configuration_snapshot_id_project_unique
      UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'configuration_snapshot_id_work_project_unique'
       AND conrelid = 'public.configuration_snapshot'::regclass
  ) THEN
    ALTER TABLE configuration_snapshot ADD CONSTRAINT configuration_snapshot_id_work_project_unique
      UNIQUE (id, work_version_id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_submission_id_project_unique'
       AND conrelid = 'public.gate_submission'::regclass
  ) THEN
    ALTER TABLE gate_submission ADD CONSTRAINT gate_submission_id_project_unique
      UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_submission_snapshot_project_unique'
       AND conrelid = 'public.gate_submission'::regclass
  ) THEN
    ALTER TABLE gate_submission ADD CONSTRAINT gate_submission_snapshot_project_unique
      UNIQUE (id, snapshot_id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'gate_submission_snapshot_work_project_unique'
       AND conrelid = 'public.gate_submission'::regclass
  ) THEN
    ALTER TABLE gate_submission ADD CONSTRAINT gate_submission_snapshot_work_project_unique
      UNIQUE (id, snapshot_id, work_version_id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'baseline_id_project_unique'
       AND conrelid = 'public.baseline'::regclass
  ) THEN
    ALTER TABLE baseline ADD CONSTRAINT baseline_id_project_unique
      UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'approval_record_id_project_unique'
       AND conrelid = 'public.approval_record'::regclass
  ) THEN
    ALTER TABLE approval_record ADD CONSTRAINT approval_record_id_project_unique
      UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'approved_gate_result_id_project_unique'
       AND conrelid = 'public.approved_gate_result'::regclass
  ) THEN
    ALTER TABLE approved_gate_result ADD CONSTRAINT approved_gate_result_id_project_unique
      UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tool_run_id_project_unique'
       AND conrelid = 'public.tool_run'::regclass
  ) THEN
    ALTER TABLE tool_run ADD CONSTRAINT tool_run_id_project_unique
      UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'evidence_id_project_unique'
       AND conrelid = 'public.evidence'::regclass
  ) THEN
    ALTER TABLE evidence ADD CONSTRAINT evidence_id_project_unique
      UNIQUE (id, project_id);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS project_readiness (
    id                              text PRIMARY KEY,
    project_id                      text NOT NULL REFERENCES project(id),
    process_instance_id             text NOT NULL,
    process_version_id              text NOT NULL REFERENCES process_version(id),
    profile_definition_hash         text NOT NULL CHECK (profile_definition_hash ~ '^[0-9a-f]{64}$'),
    work_version_id                 text NOT NULL,
    sequence                        integer NOT NULL CHECK (sequence > 0),
    supersedes_readiness_id         text,
    engineering_config              jsonb NOT NULL
                                      CHECK (jsonb_typeof(engineering_config) = 'object'
                                             AND engineering_config->>'schema' = 'engineering-config.v1'),
    engineering_config_hash         text NOT NULL CHECK (engineering_config_hash ~ '^[0-9a-f]{64}$'),
    source_snapshot_ids             text[] NOT NULL DEFAULT '{}',
    workspace_commit                text NOT NULL
                                      CHECK (workspace_commit ~ '^[0-9a-f]{40}$' OR workspace_commit ~ '^[0-9a-f]{64}$'),
    workspace_manifest_hash         text NOT NULL CHECK (workspace_manifest_hash ~ '^[0-9a-f]{64}$'),
    check_results                   jsonb NOT NULL CHECK (jsonb_typeof(check_results) = 'array'),
    result_hash                     text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
    state                           text NOT NULL CHECK (state IN ('ready','blocked')),
    board_ref                       text,
    workspace_ready                 boolean NOT NULL DEFAULT false,
    data_scope_recorded             boolean NOT NULL DEFAULT false,
    source_materials_recorded       boolean NOT NULL DEFAULT false,
    pin_constraints_complete        boolean NOT NULL DEFAULT false,
    electrical_constraints_complete boolean NOT NULL DEFAULT false,
    clock_constraints_complete      boolean NOT NULL DEFAULT false,
    constraint_revision_ids         text[] NOT NULL DEFAULT '{}',
    toolchain_profile_hash          text CHECK (toolchain_profile_hash IS NULL OR toolchain_profile_hash ~ '^[0-9a-f]{64}$'),
    target_part                     text,
    readiness_hash                  text NOT NULL CHECK (readiness_hash ~ '^[0-9a-f]{64}$'),
    generated_by_type               actor_type NOT NULL,
    generated_by                    text NOT NULL CHECK (btrim(generated_by) <> ''),
    generated_at                    timestamptz NOT NULL DEFAULT now(),
    confirmed_by                    text,
    confirmed_at                    timestamptz,
    created_at                      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (project_id, sequence),
    UNIQUE (supersedes_readiness_id),
    UNIQUE (process_instance_id, readiness_hash),
    FOREIGN KEY (process_instance_id, project_id)
      REFERENCES process_instance(id, project_id),
    FOREIGN KEY (supersedes_readiness_id, project_id)
      REFERENCES project_readiness(id, project_id)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (board_ref IS NULL OR btrim(board_ref) <> ''),
    CHECK (target_part IS NULL OR btrim(target_part) <> ''),
    CHECK (array_position(constraint_revision_ids, NULL) IS NULL),
    CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL)),
    CHECK (state = 'blocked' OR toolchain_profile_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS project_readiness_project_created_idx
  ON project_readiness(project_id, created_at DESC);

CREATE OR REPLACE FUNCTION synthia_actor_is_active_human(actor_uid text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_account
     WHERE uid = actor_uid AND actor_type = 'human' AND status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION synthia_validate_project_readiness_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'project readiness rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.process_instance_id IS DISTINCT FROM NEW.process_instance_id
     OR OLD.process_version_id IS DISTINCT FROM NEW.process_version_id
     OR OLD.profile_definition_hash IS DISTINCT FROM NEW.profile_definition_hash
     OR OLD.work_version_id IS DISTINCT FROM NEW.work_version_id
     OR OLD.sequence IS DISTINCT FROM NEW.sequence
     OR OLD.supersedes_readiness_id IS DISTINCT FROM NEW.supersedes_readiness_id
     OR OLD.engineering_config IS DISTINCT FROM NEW.engineering_config
     OR OLD.engineering_config_hash IS DISTINCT FROM NEW.engineering_config_hash
     OR OLD.source_snapshot_ids IS DISTINCT FROM NEW.source_snapshot_ids
     OR OLD.workspace_commit IS DISTINCT FROM NEW.workspace_commit
     OR OLD.workspace_manifest_hash IS DISTINCT FROM NEW.workspace_manifest_hash
     OR OLD.check_results IS DISTINCT FROM NEW.check_results
     OR OLD.result_hash IS DISTINCT FROM NEW.result_hash
     OR OLD.state IS DISTINCT FROM NEW.state
     OR OLD.board_ref IS DISTINCT FROM NEW.board_ref
     OR OLD.workspace_ready IS DISTINCT FROM NEW.workspace_ready
     OR OLD.data_scope_recorded IS DISTINCT FROM NEW.data_scope_recorded
     OR OLD.source_materials_recorded IS DISTINCT FROM NEW.source_materials_recorded
     OR OLD.pin_constraints_complete IS DISTINCT FROM NEW.pin_constraints_complete
     OR OLD.electrical_constraints_complete IS DISTINCT FROM NEW.electrical_constraints_complete
     OR OLD.clock_constraints_complete IS DISTINCT FROM NEW.clock_constraints_complete
     OR OLD.constraint_revision_ids IS DISTINCT FROM NEW.constraint_revision_ids
     OR OLD.toolchain_profile_hash IS DISTINCT FROM NEW.toolchain_profile_hash
     OR OLD.target_part IS DISTINCT FROM NEW.target_part
     OR OLD.readiness_hash IS DISTINCT FROM NEW.readiness_hash
     OR OLD.generated_by_type IS DISTINCT FROM NEW.generated_by_type
     OR OLD.generated_by IS DISTINCT FROM NEW.generated_by
     OR OLD.generated_at IS DISTINCT FROM NEW.generated_at
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.confirmed_by IS NOT NULL
     OR NEW.confirmed_by IS NULL
     OR NEW.confirmed_at IS NULL
     OR NOT synthia_actor_is_active_human(NEW.confirmed_by) THEN
    RAISE EXCEPTION 'project readiness is immutable except one human confirmation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION synthia_validate_project_readiness_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'project readiness must be prepared before human confirmation' USING ERRCODE = '23514';
  END IF;
  IF NEW.sequence = 1 AND NEW.supersedes_readiness_id IS NOT NULL THEN
    RAISE EXCEPTION 'first project readiness cannot supersede another row' USING ERRCODE = '23514';
  END IF;
  IF NEW.sequence > 1 AND NOT EXISTS (
    SELECT 1 FROM project_readiness predecessor
     WHERE predecessor.id = NEW.supersedes_readiness_id
       AND predecessor.project_id = NEW.project_id
       AND predecessor.sequence = NEW.sequence - 1
  ) THEN
    RAISE EXCEPTION 'project readiness must form a monotonic supersession chain' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS project_readiness_prepare_guard ON project_readiness;
CREATE TRIGGER project_readiness_prepare_guard
  BEFORE INSERT ON project_readiness
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_project_readiness_insert();
DROP TRIGGER IF EXISTS project_readiness_state_guard ON project_readiness;
CREATE TRIGGER project_readiness_state_guard
  BEFORE UPDATE OR DELETE ON project_readiness
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_project_readiness_mutation();

CREATE TABLE IF NOT EXISTS gate_check_evaluation (
    id                 text PRIMARY KEY,
    project_id         text NOT NULL REFERENCES project(id),
    process_instance_id text NOT NULL,
    work_version_id    text NOT NULL,
    gate_submission_id text NOT NULL,
    gate               gate_id NOT NULL,
    snapshot_id        text NOT NULL,
    profile_hash       text NOT NULL CHECK (profile_hash ~ '^[0-9a-f]{64}$'),
    profile_definition_hash text NOT NULL CHECK (profile_definition_hash ~ '^[0-9a-f]{64}$'),
    check_set_hash     text NOT NULL CHECK (check_set_hash ~ '^[0-9a-f]{64}$'),
    snapshot_manifest_hash text NOT NULL CHECK (snapshot_manifest_hash ~ '^[0-9a-f]{64}$'),
    input_fact_hash    text NOT NULL CHECK (input_fact_hash ~ '^[0-9a-f]{64}$'),
    result_hash        text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{64}$'),
    passed             boolean NOT NULL,
    state              text NOT NULL CHECK (state IN ('passed','failed')),
    sealed_projection  jsonb CHECK (sealed_projection IS NULL OR jsonb_typeof(sealed_projection) = 'object'),
    sealed_projection_hash text
                         CHECK (sealed_projection_hash IS NULL OR sealed_projection_hash ~ '^[0-9a-f]{64}$'),
    evaluated_at       timestamptz NOT NULL,
    evaluator_version  text NOT NULL CHECK (btrim(evaluator_version) <> ''),
    generated_by_type  actor_type NOT NULL,
    generated_by       text NOT NULL CHECK (btrim(generated_by) <> ''),
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (gate_submission_id, result_hash),
    FOREIGN KEY (gate_submission_id, snapshot_id, project_id)
      REFERENCES gate_submission(id, snapshot_id, project_id),
    FOREIGN KEY (process_instance_id, project_id)
      REFERENCES process_instance(id, project_id)
);

CREATE TABLE IF NOT EXISTS gate_check_item (
    id            text PRIMARY KEY,
    project_id    text NOT NULL REFERENCES project(id),
    evaluation_id text NOT NULL,
    check_code    text NOT NULL CHECK (check_code ~ '^[a-z][a-z0-9_.]{2,95}$'),
    check_version text NOT NULL CHECK (btrim(check_version) <> ''),
    severity      text NOT NULL CHECK (severity IN ('hard','advisory')),
    passed        boolean NOT NULL,
    status        text NOT NULL CHECK (status IN ('passed','failed','not_applicable')),
    fact_hash     text NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
    details       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (evaluation_id, check_code),
    FOREIGN KEY (evaluation_id, project_id)
      REFERENCES gate_check_evaluation(id, project_id)
      DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS gate_check_evaluation_submission_idx
  ON gate_check_evaluation(project_id, gate_submission_id, evaluated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS gate_check_evaluation_one_per_submission_idx
  ON gate_check_evaluation(gate_submission_id);

CREATE OR REPLACE FUNCTION synthia_validate_gate_check_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM gate_check_evaluation WHERE id = NEW.evaluation_id) THEN
    RAISE EXCEPTION 'sealed gate evaluation rejects additional items' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gate_check_item_insert_before_seal ON gate_check_item;
CREATE TRIGGER gate_check_item_insert_before_seal
  BEFORE INSERT ON gate_check_item
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_gate_check_item_insert();
DROP TRIGGER IF EXISTS gate_check_item_append_only ON gate_check_item;
CREATE TRIGGER gate_check_item_append_only
  BEFORE UPDATE OR DELETE ON gate_check_item
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_gate_check_evaluation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  submission_gate gate_id;
  expected_profile_hash text;
  expected_snapshot_hash text;
  expected_process_instance_id text;
BEGIN
  SELECT gs.gate, pgd.profile_hash, snapshot.manifest_hash, gs.process_instance_id
    INTO submission_gate, expected_profile_hash, expected_snapshot_hash, expected_process_instance_id
    FROM gate_submission gs
    JOIN configuration_snapshot snapshot ON snapshot.id = gs.snapshot_id AND snapshot.project_id = gs.project_id
    JOIN project p ON p.id = gs.project_id
    JOIN process_gate_definition pgd
      ON pgd.process_version_id = p.process_version_id AND pgd.gate = gs.gate
   WHERE gs.id = NEW.gate_submission_id
     AND gs.snapshot_id = NEW.snapshot_id
     AND gs.project_id = NEW.project_id;
  IF NOT FOUND OR submission_gate::text NOT IN ('G0','G1','G2','G3','G4')
     OR expected_profile_hash IS DISTINCT FROM NEW.profile_hash
     OR NEW.profile_definition_hash IS DISTINCT FROM expected_profile_hash
     OR NEW.gate IS DISTINCT FROM submission_gate
     OR NEW.process_instance_id IS DISTINCT FROM expected_process_instance_id
     OR NEW.snapshot_manifest_hash IS DISTINCT FROM expected_snapshot_hash
     OR (NEW.passed AND NEW.state <> 'passed')
     OR (NOT NEW.passed AND NEW.state <> 'failed') THEN
    RAISE EXCEPTION 'gate evaluation does not match the frozen project profile' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM gate_check_item i
     WHERE i.evaluation_id = NEW.id AND i.project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'gate evaluation requires check items' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM process_gate_definition pgd,
           LATERAL jsonb_array_elements(pgd.required_checks) required_check(item)
     WHERE pgd.profile_hash = NEW.profile_hash
       AND pgd.gate = submission_gate
       AND NOT EXISTS (
         SELECT 1 FROM gate_check_item i
          WHERE i.evaluation_id = NEW.id
            AND i.project_id = NEW.project_id
            AND i.check_code = required_check.item->>'code'
       )
  ) THEN
    RAISE EXCEPTION 'gate evaluation is missing required checks' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM gate_check_item i
     WHERE i.evaluation_id = NEW.id AND i.project_id = NEW.project_id
       AND (
         (i.passed AND i.status <> 'passed')
         OR (NOT i.passed AND i.status <> 'failed')
         OR NOT EXISTS (
           SELECT 1 FROM process_gate_definition pgd,
                LATERAL jsonb_array_elements(pgd.required_checks) required_check(item)
            WHERE pgd.profile_hash = NEW.profile_hash
              AND pgd.gate = submission_gate
              AND required_check.item->>'code' = i.check_code
              AND required_check.item->>'severity' = i.severity
         )
       )
  ) THEN
    RAISE EXCEPTION 'gate evaluation contains an extra or inconsistent check item' USING ERRCODE = '23514';
  END IF;
  IF NEW.passed AND EXISTS (
    SELECT 1 FROM gate_check_item i
     WHERE i.evaluation_id = NEW.id
       AND i.project_id = NEW.project_id
       AND i.severity = 'hard'
       AND NOT i.passed
  ) THEN
    RAISE EXCEPTION 'passing gate evaluation contains a failed required check' USING ERRCODE = '23514';
  END IF;
  IF submission_gate = 'G4' AND NEW.passed THEN
    IF NEW.sealed_projection IS NULL
       OR NEW.sealed_projection_hash IS NULL
       OR NEW.sealed_projection->>'schema' IS DISTINCT FROM 'delivery-candidate.v1' THEN
      RAISE EXCEPTION 'passing G4 evaluation requires a sealed delivery-candidate.v1 projection' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.sealed_projection IS NOT NULL OR NEW.sealed_projection_hash IS NOT NULL THEN
    RAISE EXCEPTION 'only a passing G4 evaluation may carry a sealed projection' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS gate_check_evaluation_validate ON gate_check_evaluation;
CREATE TRIGGER gate_check_evaluation_validate
  BEFORE INSERT ON gate_check_evaluation
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_gate_check_evaluation_insert();
DROP TRIGGER IF EXISTS gate_check_evaluation_append_only ON gate_check_evaluation;
CREATE TRIGGER gate_check_evaluation_append_only
  BEFORE UPDATE OR DELETE ON gate_check_evaluation
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

-- The old superseded_by column remains readable.  New baselines point to the
-- baseline they replace, while the insert trigger atomically closes the old
-- row and fills its legacy forward pointer.
ALTER TABLE baseline ADD COLUMN IF NOT EXISTS supersedes_baseline_id text;
ALTER TABLE baseline DROP CONSTRAINT IF EXISTS baseline_superseded_by_baseline_id_fkey;
ALTER TABLE baseline DROP CONSTRAINT IF EXISTS baseline_superseded_by_project_fk;
ALTER TABLE baseline ADD CONSTRAINT baseline_superseded_by_project_fk
  FOREIGN KEY (superseded_by_baseline_id, project_id)
  REFERENCES baseline(id, project_id)
  DEFERRABLE INITIALLY DEFERRED;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'baseline_supersedes_project_fk'
       AND conrelid = 'public.baseline'::regclass
  ) THEN
    ALTER TABLE baseline ADD CONSTRAINT baseline_supersedes_project_fk
      FOREIGN KEY (supersedes_baseline_id, project_id)
      REFERENCES baseline(id, project_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;
CREATE UNIQUE INDEX IF NOT EXISTS baseline_unique_superseded_predecessor
  ON baseline(supersedes_baseline_id) WHERE supersedes_baseline_id IS NOT NULL;

CREATE OR REPLACE FUNCTION synthia_validate_baseline_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'baseline rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.kind IS DISTINCT FROM NEW.kind
     OR OLD.approved_gate_result_id IS DISTINCT FROM NEW.approved_gate_result_id
     OR OLD.member_revision_ids IS DISTINCT FROM NEW.member_revision_ids
     OR OLD.trace_relation_ids IS DISTINCT FROM NEW.trace_relation_ids
     OR OLD.manifest_hash IS DISTINCT FROM NEW.manifest_hash
     OR OLD.approval_record_id IS DISTINCT FROM NEW.approval_record_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.supersedes_baseline_id IS DISTINCT FROM NEW.supersedes_baseline_id
     OR OLD.state IS DISTINCT FROM 'active'::baseline_state
     OR NEW.state IS DISTINCT FROM 'superseded'::baseline_state
     OR OLD.superseded_by_baseline_id IS NOT NULL
     OR NEW.superseded_by_baseline_id IS NULL THEN
    RAISE EXCEPTION 'baseline is immutable except active-to-superseded transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS baseline_append_only ON baseline;
DROP TRIGGER IF EXISTS baseline_state_guard ON baseline;
CREATE TRIGGER baseline_state_guard
  BEFORE UPDATE OR DELETE ON baseline
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_baseline_mutation();

CREATE OR REPLACE FUNCTION synthia_supersede_baseline_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  predecessor baseline%ROWTYPE;
BEGIN
  IF NEW.state IS DISTINCT FROM 'active'::baseline_state THEN
    RETURN NEW;
  END IF;
  IF NEW.supersedes_baseline_id IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM baseline
       WHERE project_id = NEW.project_id AND kind = NEW.kind AND state = 'active'
    ) THEN
      RAISE EXCEPTION 'active baseline already exists; supersedes_baseline_id is required' USING ERRCODE = '23505';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO predecessor FROM baseline
   WHERE id = NEW.supersedes_baseline_id
   FOR UPDATE;
  IF NOT FOUND
     OR predecessor.project_id IS DISTINCT FROM NEW.project_id
     OR predecessor.kind IS DISTINCT FROM NEW.kind
     OR predecessor.state IS DISTINCT FROM 'active'::baseline_state THEN
    RAISE EXCEPTION 'baseline predecessor must be the active same-kind baseline' USING ERRCODE = '23514';
  END IF;
  UPDATE baseline
     SET state = 'superseded', superseded_by_baseline_id = NEW.id
   WHERE id = predecessor.id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS baseline_supersede_before_insert ON baseline;
CREATE TRIGGER baseline_supersede_before_insert
  BEFORE INSERT ON baseline
  FOR EACH ROW EXECUTE FUNCTION synthia_supersede_baseline_before_insert();

-- Core-owned immutable bytes backing formal-input.v1 storage_uri values.  The
-- project component prevents a digest learned in one project from becoming an
-- accidental cross-project content handle; sha256 remains the addressing key
-- within that boundary.  Rows are append-only because an approved formal input
-- may outlive its originating workspace and artifact revision.
CREATE TABLE IF NOT EXISTS formal_input_content (
    project_id      text NOT NULL REFERENCES project(id),
    sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
    managed_content bytea NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, sha256),
    CHECK (octet_length(managed_content) = size_bytes)
);

CREATE OR REPLACE FUNCTION synthia_validate_formal_input_content_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF encode(digest(NEW.managed_content, 'sha256'), 'hex') IS DISTINCT FROM NEW.sha256 THEN
    RAISE EXCEPTION 'managed formal input bytes do not match sha256' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS formal_input_content_validate ON formal_input_content;
CREATE TRIGGER formal_input_content_validate
  BEFORE INSERT ON formal_input_content
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_formal_input_content_insert();

CREATE OR REPLACE FUNCTION synthia_reject_formal_input_content_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'managed formal input content is append-only' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS formal_input_content_append_only ON formal_input_content;
CREATE TRIGGER formal_input_content_append_only
  BEFORE UPDATE OR DELETE ON formal_input_content
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_formal_input_content_mutation();

-- work_version_id gets its composite FK in 0011 after project_work_version is
-- created.  It is already required here so no P4 formal input can be unversioned.
CREATE TABLE IF NOT EXISTS formal_input_approval (
    id                       text PRIMARY KEY,
    project_id               text NOT NULL REFERENCES project(id),
    process_instance_id      text NOT NULL,
    snapshot_id              text NOT NULL,
    baseline_id              text NOT NULL,
    readiness_id             text NOT NULL,
    manifest_hash            text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    input_hash               text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    engineering_config_hash  text NOT NULL CHECK (engineering_config_hash ~ '^[0-9a-f]{64}$'),
    baseline_manifest_hash   text NOT NULL CHECK (baseline_manifest_hash ~ '^[0-9a-f]{64}$'),
    toolchain_profile_hash   text NOT NULL CHECK (toolchain_profile_hash ~ '^[0-9a-f]{64}$'),
    connector_id             text NOT NULL CHECK (btrim(connector_id) <> ''),
    target_part              text NOT NULL CHECK (btrim(target_part) <> ''),
    constraint_hash          text NOT NULL CHECK (constraint_hash ~ '^[0-9a-f]{64}$'),
    constraints_complete     boolean NOT NULL CHECK (constraints_complete),
    purpose                  text NOT NULL CHECK (purpose = 'g4_delivery'),
    target_gate              gate_id NOT NULL DEFAULT 'G4' CHECK (target_gate = 'G4'),
    allowed_operations       text[] NOT NULL CHECK (cardinality(allowed_operations) > 0),
    authorized_task_id       text NOT NULL,
    runtime_actor_id         text NOT NULL CHECK (btrim(runtime_actor_id) <> ''),
    input_manifest           jsonb NOT NULL
                               CHECK (jsonb_typeof(input_manifest) = 'object'
                                      AND input_manifest->>'schema' = 'formal-input.v1'),
    preview_hash             text NOT NULL CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
    authoritative_inputs     jsonb NOT NULL
                               CHECK (jsonb_typeof(authoritative_inputs) = 'array'
                                      AND jsonb_array_length(authoritative_inputs) > 0),
    generated_by_type        actor_type NOT NULL,
    generated_by             text NOT NULL CHECK (btrim(generated_by) <> ''),
    generated_at             timestamptz NOT NULL DEFAULT now(),
    confirmed_by             text CHECK (confirmed_by IS NULL OR btrim(confirmed_by) <> ''),
    confirmed_at             timestamptz,
    work_version_id          text NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (project_id, work_version_id, input_hash),
    FOREIGN KEY (process_instance_id, project_id)
      REFERENCES process_instance(id, project_id),
    FOREIGN KEY (snapshot_id, project_id)
      REFERENCES configuration_snapshot(id, project_id),
    FOREIGN KEY (baseline_id, project_id)
      REFERENCES baseline(id, project_id),
    FOREIGN KEY (readiness_id, project_id)
      REFERENCES project_readiness(id, project_id),
    FOREIGN KEY (authorized_task_id, project_id)
      REFERENCES agent_task(id, project_id),
    CHECK (array_position(allowed_operations, NULL) IS NULL),
    CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS formal_input_approval_project_created_idx
  ON formal_input_approval(project_id, created_at DESC);

CREATE OR REPLACE FUNCTION synthia_validate_formal_input_approval_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.confirmed_by IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'formal input must be prepared before human confirmation' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM project p
      JOIN process_instance pi ON pi.project_id = p.id
      JOIN configuration_snapshot s ON s.project_id = p.id
      JOIN baseline b ON b.project_id = p.id
      JOIN approved_gate_result agr
        ON agr.id = b.approved_gate_result_id AND agr.project_id = b.project_id
     WHERE p.id = NEW.project_id
       AND p.project_type = 'engineering'
       AND p.process_version_id = 'GJB_REF_V1'
       AND p.target_part = NEW.target_part
       AND pi.id = NEW.process_instance_id
       AND pi.gate_profile_version = p.process_profile_version
       AND s.id = NEW.snapshot_id
       AND s.gate_profile_version = p.process_profile_version
       AND s.manifest_hash = NEW.manifest_hash
       AND b.id = NEW.baseline_id
       AND b.kind = 'B1'
       AND b.state = 'active'
       AND b.manifest_hash = NEW.baseline_manifest_hash
       AND agr.gate = 'G3'
       AND NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(NEW.authoritative_inputs) formal_member(item)
          WHERE COALESCE(formal_member.item->>'revision_id', formal_member.item->>'revisionId') IS NULL
             OR NOT EXISTS (
               SELECT 1 FROM artifact_revision ar
                WHERE ar.id = COALESCE(formal_member.item->>'revision_id', formal_member.item->>'revisionId')
                  AND ar.project_id = NEW.project_id
                  AND ar.id = ANY(s.member_revision_ids)
                  AND ar.content_hash = formal_member.item->>'sha256'
             )
             OR NOT EXISTS (
               SELECT 1 FROM formal_input_content content
                WHERE content.project_id = NEW.project_id
                  AND content.sha256 = formal_member.item->>'sha256'
                  AND content.size_bytes = (formal_member.item->>'size_bytes')::bigint
             )
       )
  ) THEN
    RAISE EXCEPTION 'formal input must bind the approved G3 snapshot and active B1 baseline' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM project_readiness r
    JOIN configuration_snapshot s
      ON s.id = NEW.snapshot_id AND s.project_id = r.project_id
     WHERE r.project_id = NEW.project_id
       AND r.id = NEW.readiness_id
       AND r.work_version_id = NEW.work_version_id
       AND r.process_instance_id = NEW.process_instance_id
       AND r.confirmed_by IS NOT NULL
       AND r.state = 'ready'
       AND r.engineering_config_hash = NEW.engineering_config_hash
       AND r.workspace_ready
       AND r.data_scope_recorded
       AND r.source_materials_recorded
       AND r.pin_constraints_complete
       AND r.electrical_constraints_complete
       AND r.clock_constraints_complete
       AND cardinality(r.constraint_revision_ids) > 0
       AND r.toolchain_profile_hash = NEW.toolchain_profile_hash
       AND r.target_part = NEW.target_part
       AND r.constraint_revision_ids <@ s.member_revision_ids
       AND NOT EXISTS (
         SELECT 1 FROM unnest(r.constraint_revision_ids) constraint_revision_id
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(NEW.authoritative_inputs) formal_member(item)
             WHERE COALESCE(formal_member.item->>'revision_id', formal_member.item->>'revisionId') = constraint_revision_id
          )
       )
  ) THEN
    RAISE EXCEPTION 'formal input requires confirmed complete engineering readiness' USING ERRCODE = '23514';
  END IF;
  IF NEW.allowed_operations IS DISTINCT FROM ARRAY['implement','simulate','synthesize','validate_sources']::text[] THEN
    RAISE EXCEPTION 'formal input allowed operations must be the frozen G4 set' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM agent_task task
     WHERE task.id = NEW.authorized_task_id
       AND task.project_id = NEW.project_id
       AND task.project_type = 'engineering'
       AND task.kind = 'main'
       AND task.process_instance_id = NEW.process_instance_id
       AND task.runtime_actor_id = NEW.runtime_actor_id
       AND task.status IN ('queued','running','awaiting_user')
  ) THEN
    RAISE EXCEPTION 'formal input requires the active engineering main task' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS formal_input_approval_validate ON formal_input_approval;
CREATE TRIGGER formal_input_approval_validate
  BEFORE INSERT ON formal_input_approval
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_formal_input_approval_insert();
CREATE OR REPLACE FUNCTION synthia_validate_formal_input_approval_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'formal input approval rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.process_instance_id IS DISTINCT FROM NEW.process_instance_id
     OR OLD.snapshot_id IS DISTINCT FROM NEW.snapshot_id
     OR OLD.baseline_id IS DISTINCT FROM NEW.baseline_id
     OR OLD.readiness_id IS DISTINCT FROM NEW.readiness_id
     OR OLD.manifest_hash IS DISTINCT FROM NEW.manifest_hash
     OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
     OR OLD.engineering_config_hash IS DISTINCT FROM NEW.engineering_config_hash
     OR OLD.baseline_manifest_hash IS DISTINCT FROM NEW.baseline_manifest_hash
     OR OLD.toolchain_profile_hash IS DISTINCT FROM NEW.toolchain_profile_hash
     OR OLD.connector_id IS DISTINCT FROM NEW.connector_id
     OR OLD.target_part IS DISTINCT FROM NEW.target_part
     OR OLD.constraint_hash IS DISTINCT FROM NEW.constraint_hash
     OR OLD.constraints_complete IS DISTINCT FROM NEW.constraints_complete
     OR OLD.purpose IS DISTINCT FROM NEW.purpose
     OR OLD.target_gate IS DISTINCT FROM NEW.target_gate
     OR OLD.allowed_operations IS DISTINCT FROM NEW.allowed_operations
     OR OLD.authorized_task_id IS DISTINCT FROM NEW.authorized_task_id
     OR OLD.runtime_actor_id IS DISTINCT FROM NEW.runtime_actor_id
     OR OLD.input_manifest IS DISTINCT FROM NEW.input_manifest
     OR OLD.preview_hash IS DISTINCT FROM NEW.preview_hash
     OR OLD.authoritative_inputs IS DISTINCT FROM NEW.authoritative_inputs
     OR OLD.generated_by_type IS DISTINCT FROM NEW.generated_by_type
     OR OLD.generated_by IS DISTINCT FROM NEW.generated_by
     OR OLD.generated_at IS DISTINCT FROM NEW.generated_at
     OR OLD.work_version_id IS DISTINCT FROM NEW.work_version_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.confirmed_by IS NOT NULL
     OR NEW.confirmed_by IS NULL
     OR NEW.confirmed_at IS NULL
     OR NOT synthia_actor_is_active_human(NEW.confirmed_by) THEN
    RAISE EXCEPTION 'formal input is immutable except one human confirmation' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS formal_input_approval_append_only ON formal_input_approval;
DROP TRIGGER IF EXISTS formal_input_approval_state_guard ON formal_input_approval;
CREATE TRIGGER formal_input_approval_state_guard
  BEFORE UPDATE OR DELETE ON formal_input_approval
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_formal_input_approval_mutation();

ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS formal_input_approval_id text;
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS submitted_by_type actor_type;
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS submitted_by text;
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS input_hash text;
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS binding_version text NOT NULL DEFAULT 'legacy';
CREATE UNIQUE INDEX IF NOT EXISTS tool_run_one_formal_operation_idx
  ON tool_run(project_id, formal_input_approval_id, operation)
  WHERE binding_version = 'formal-input.v1';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tool_run_formal_input_project_fk'
       AND conrelid = 'public.tool_run'::regclass
  ) THEN
    ALTER TABLE tool_run ADD CONSTRAINT tool_run_formal_input_project_fk
      FOREIGN KEY (formal_input_approval_id, project_id)
      REFERENCES formal_input_approval(id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tool_run_input_hash_check'
       AND conrelid = 'public.tool_run'::regclass
  ) THEN
    ALTER TABLE tool_run ADD CONSTRAINT tool_run_input_hash_check
      CHECK (input_hash IS NULL OR input_hash ~ '^[0-9a-f]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tool_run_submitter_shape'
       AND conrelid = 'public.tool_run'::regclass
  ) THEN
    ALTER TABLE tool_run ADD CONSTRAINT tool_run_submitter_shape
      CHECK ((submitted_by_type IS NULL) = (submitted_by IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tool_run_binding_version_check'
       AND conrelid = 'public.tool_run'::regclass
  ) THEN
    ALTER TABLE tool_run ADD CONSTRAINT tool_run_binding_version_check
      CHECK (binding_version IN ('legacy','formal-input.v1'));
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_tool_run_formal_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
       OLD.formal_input_approval_id IS DISTINCT FROM NEW.formal_input_approval_id
       OR OLD.project_id IS DISTINCT FROM NEW.project_id
       OR OLD.run_class IS DISTINCT FROM NEW.run_class
       OR OLD.operation IS DISTINCT FROM NEW.operation
       OR OLD.input_snapshot_id IS DISTINCT FROM NEW.input_snapshot_id
       OR OLD.input_manifest_hash IS DISTINCT FROM NEW.input_manifest_hash
       OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
       OR OLD.toolchain_profile_hash IS DISTINCT FROM NEW.toolchain_profile_hash
       OR OLD.submitted_by_type IS DISTINCT FROM NEW.submitted_by_type
       OR OLD.submitted_by IS DISTINCT FROM NEW.submitted_by
       OR OLD.binding_version IS DISTINCT FROM NEW.binding_version
     ) THEN
    RAISE EXCEPTION 'tool run input binding is immutable' USING ERRCODE = '55000';
  END IF;
  -- NULL is retained for pre-P4/legacy runs.  Once a P4 approval is supplied,
  -- every duplicated binding field must agree and cannot be partially spoofed.
  IF NEW.formal_input_approval_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM formal_input_approval f
     JOIN baseline b ON b.id = f.baseline_id AND b.project_id = f.project_id
     WHERE f.id = NEW.formal_input_approval_id
       AND f.project_id = NEW.project_id
       AND b.kind = 'B1' AND b.state = 'active'
       AND NEW.run_class = 'formal'
       AND NEW.binding_version = 'formal-input.v1'
       AND NEW.operation = ANY(f.allowed_operations)
       AND NEW.input_snapshot_id = f.snapshot_id
       AND NEW.input_manifest_hash = f.manifest_hash
       AND NEW.input_hash = f.input_hash
       AND NEW.toolchain_profile_hash = f.toolchain_profile_hash
       AND f.confirmed_by IS NOT NULL
       AND f.confirmed_at IS NOT NULL
       AND NEW.submitted_by_type IS NOT NULL
       AND NEW.submitted_by IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'tool run formal input binding mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tool_run_formal_binding_guard ON tool_run;
CREATE TRIGGER tool_run_formal_binding_guard
  BEFORE INSERT OR UPDATE OF formal_input_approval_id, project_id, run_class,
    operation, input_snapshot_id, input_manifest_hash, input_hash,
    toolchain_profile_hash, submitted_by_type, submitted_by, binding_version
  ON tool_run
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_tool_run_formal_binding();

-- Evidence entries are inserted first in the same transaction and reference a
-- not-yet-inserted manifest through a deferred FK.  Inserting the manifest
-- seals the exact set; later entry inserts are rejected.
CREATE TABLE IF NOT EXISTS tool_run_evidence_manifest (
    id                text PRIMARY KEY,
    project_id        text NOT NULL REFERENCES project(id),
    tool_run_id       text NOT NULL,
    schema_version    text NOT NULL DEFAULT 'evidence-manifest.v1'
                        CHECK (schema_version = 'evidence-manifest.v1'),
    run_state         tool_run_state NOT NULL,
    operation         text NOT NULL CHECK (btrim(operation) <> ''),
    run_class         run_class NOT NULL,
    manifest_hash     text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    input_hash        text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    toolchain_profile_hash text NOT NULL CHECK (toolchain_profile_hash ~ '^[0-9a-f]{64}$'),
    parser_version    text NOT NULL CHECK (btrim(parser_version) <> ''),
    verdicts          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(verdicts) = 'object'),
    entry_count       integer NOT NULL CHECK (entry_count > 0),
    generated_by_type actor_type NOT NULL,
    generated_by      text NOT NULL CHECK (btrim(generated_by) <> ''),
    sealed_at         timestamptz NOT NULL,
    frozen_at         timestamptz NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (id, tool_run_id, project_id),
    UNIQUE (tool_run_id),
    FOREIGN KEY (tool_run_id, project_id)
      REFERENCES tool_run(id, project_id)
);

CREATE TABLE IF NOT EXISTS tool_run_evidence_entry (
    id            text PRIMARY KEY,
    project_id    text NOT NULL REFERENCES project(id),
    manifest_id   text NOT NULL,
    tool_run_id   text NOT NULL,
    name          text NOT NULL CHECK (btrim(name) <> ''),
    role          text NOT NULL CHECK (btrim(role) <> ''),
    evidence_kind text NOT NULL CHECK (evidence_kind IN (
                    'rtl','testbench','constraint','simulation','synthesis',
                    'implementation','drc','timing','bitstream','log','report',
                    'document','confirmation','source_version','other'
                  )),
    uri           text NOT NULL CHECK (btrim(uri) <> ''),
    sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes    bigint NOT NULL CHECK (size_bytes >= 0),
    media_type    text NOT NULL CHECK (btrim(media_type) <> ''),
    completeness  text NOT NULL DEFAULT 'full' CHECK (completeness IN ('full','partial')),
    corrupt       boolean NOT NULL DEFAULT false,
    verdict       jsonb CHECK (verdict IS NULL OR jsonb_typeof(verdict) = 'object'),
    source_entry_names text[] NOT NULL DEFAULT '{}',
    managed_content bytea NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (manifest_id, name),
    FOREIGN KEY (manifest_id, tool_run_id, project_id)
      REFERENCES tool_run_evidence_manifest(id, tool_run_id, project_id)
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tool_run_id, project_id)
      REFERENCES tool_run(id, project_id),
    CHECK (array_position(source_entry_names, NULL) IS NULL),
    CHECK (octet_length(managed_content) = size_bytes)
);
CREATE INDEX IF NOT EXISTS tool_run_evidence_manifest_project_idx
  ON tool_run_evidence_manifest(project_id, sealed_at DESC);

CREATE OR REPLACE FUNCTION synthia_validate_evidence_entry_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF encode(digest(NEW.managed_content, 'sha256'), 'hex') IS DISTINCT FROM NEW.sha256 THEN
    RAISE EXCEPTION 'managed evidence bytes do not match sha256' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM tool_run_evidence_manifest WHERE id = NEW.manifest_id) THEN
    RAISE EXCEPTION 'sealed evidence manifest rejects additional entries' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tool_run_evidence_entry_before_seal ON tool_run_evidence_entry;
CREATE TRIGGER tool_run_evidence_entry_before_seal
  BEFORE INSERT ON tool_run_evidence_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evidence_entry_insert();
DROP TRIGGER IF EXISTS tool_run_evidence_entry_append_only ON tool_run_evidence_entry;
CREATE TRIGGER tool_run_evidence_entry_append_only
  BEFORE UPDATE OR DELETE ON tool_run_evidence_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_evidence_manifest_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_count integer;
  actual_hash text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tool_run r
     WHERE r.id = NEW.tool_run_id
       AND r.project_id = NEW.project_id
       AND r.state IN ('rejected','succeeded','failed','cancelled','timeout','lost','unknown_effect')
       AND r.input_hash = NEW.input_hash
       AND NEW.run_state = r.state
       AND NEW.operation = r.operation
       AND NEW.run_class = r.run_class
       AND NEW.toolchain_profile_hash = r.toolchain_profile_hash
       AND NEW.frozen_at = NEW.sealed_at
  ) THEN
    RAISE EXCEPTION 'evidence manifest requires a terminal run with the same binding' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer,
         encode(digest(convert_to(COALESCE(string_agg(
           e.name || ':' || e.sha256 || ':' || e.size_bytes::text || ':' || e.evidence_kind,
           E'\n' ORDER BY e.name COLLATE "C"
         ), ''), 'UTF8'), 'sha256'), 'hex')
    INTO actual_count, actual_hash
    FROM tool_run_evidence_entry e
   WHERE e.manifest_id = NEW.id
     AND e.tool_run_id = NEW.tool_run_id
     AND e.project_id = NEW.project_id;
  IF actual_count IS DISTINCT FROM NEW.entry_count
     OR actual_hash IS DISTINCT FROM NEW.manifest_hash THEN
    RAISE EXCEPTION 'evidence manifest count or hash mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tool_run_evidence_manifest_validate ON tool_run_evidence_manifest;
CREATE TRIGGER tool_run_evidence_manifest_validate
  BEFORE INSERT ON tool_run_evidence_manifest
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evidence_manifest_insert();
DROP TRIGGER IF EXISTS tool_run_evidence_manifest_append_only ON tool_run_evidence_manifest;
CREATE TRIGGER tool_run_evidence_manifest_append_only
  BEFORE UPDATE OR DELETE ON tool_run_evidence_manifest
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

INSERT INTO schema_migrations(version)
  VALUES ('0010_process_gate_checks')
  ON CONFLICT (version) DO NOTHING;
COMMIT;
