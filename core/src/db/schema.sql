-- Synthia Core — D1 Schema
-- PostgreSQL 14+
-- Maps to SYNTHIA-ARC-002 domain entities.
-- RPO/RTO 1h/1h: enable WAL + replication in D6.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";      -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";        -- trace search

-- ── enums ─────────────────────────────────────────────────────────────────────

DO $$ BEGIN CREATE TYPE gate_id AS ENUM ('G0','G1','G2','G3','G4','G5','G6','G7','G8','G9'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE baseline_kind AS ENUM ('B0','B1','B2','B3','B4'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE artifact_rev_state AS ENUM ('candidate','in_review','approved','rejected','superseded','invalidated'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gate_sub_state AS ENUM ('preparing','submitted','checking','in_review','approved','rejected','withdrawn'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE baseline_state AS ENUM ('active','superseded','invalidated','retired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tool_run_state AS ENUM ('submitted','rejected','queued','preparing','running','succeeded','failed','cancelling','cancelled','timeout','lost','unknown_effect'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE run_class AS ENUM ('exploratory','gate_check','formal'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE trace_state AS ENUM ('candidate','in_review','approved','rejected','review_required','superseded','invalidated'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE approval_decision AS ENUM ('approve','reject','approve_with_actions','request_changes','revoke','confirm_no_impact','accept_waiver'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE actor_type AS ENUM ('human','agent','connector','system','service'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- 0003: widen an existing actor_type enum (re-run / upgrade path) with 'service'.
ALTER TYPE actor_type ADD VALUE IF NOT EXISTS 'service';
DO $$ BEGIN CREATE TYPE data_classification AS ENUM ('UNCLASSIFIED','D1','D2','D3','D4'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── project & process ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS process_definition (
    id text PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS process_version (
    id text PRIMARY KEY,
    profile_id text NOT NULL REFERENCES process_definition(id),
    version text NOT NULL,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (profile_id, version)
);

INSERT INTO process_definition(id,name,description) VALUES ('GJB_REF_V1','GJB 参考流程 v1','GJB 参考流程，首版开放 G0-G4') ON CONFLICT (id) DO NOTHING;
INSERT INTO process_definition(id,name,description) VALUES ('LEGACY_COMPAT','兼容旧流程','仅用于标记迁移前项目和旧 API 请求') ON CONFLICT (id) DO NOTHING;
INSERT INTO process_version(id,profile_id,version,name,status) VALUES ('GJB_REF_V1','GJB_REF_V1','GJB_REF_V1','GJB 参考流程 v1','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO process_version(id,profile_id,version,name,status) VALUES ('LEGACY_COMPAT','LEGACY_COMPAT','LEGACY_COMPAT','兼容旧流程','retired') ON CONFLICT (id) DO NOTHING;

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

CREATE TABLE IF NOT EXISTS project (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    scope           text NOT NULL DEFAULT '',
    data_classification data_classification NOT NULL DEFAULT 'D1',
    standard_version text NOT NULL DEFAULT 'GB/T 33781-2017',
    target_part     text,
    -- Defaults preserve the old API/direct-insert shape as an explicitly
    -- labelled compatibility project. Modern creation always writes these
    -- columns, including explicit NULL process fields for free projects.
    project_type    text NOT NULL DEFAULT 'engineering' CHECK (project_type IN ('free','engineering')),
    process_version_id text DEFAULT 'LEGACY_COMPAT',
    process_profile_id text DEFAULT 'LEGACY_COMPAT',
    process_profile_version text DEFAULT 'LEGACY_COMPAT',
    process_profile_name text DEFAULT '兼容旧流程',
    toolchain_profile_ref text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    status          text NOT NULL DEFAULT 'active',
    CONSTRAINT project_id_project_type_unique UNIQUE (id, project_type),
    CONSTRAINT project_process_version_fk
      FOREIGN KEY (process_version_id) REFERENCES process_version(id),
    CONSTRAINT project_process_binding_check CHECK (
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
    )
);

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

CREATE TABLE IF NOT EXISTS process_instance (
    id                  text PRIMARY KEY,
    project_id          text NOT NULL REFERENCES project(id),
    gate_profile_version text NOT NULL,
    current_gate        gate_id NOT NULL DEFAULT 'G0',
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT process_instance_id_project_unique UNIQUE (id, project_id)
);

CREATE OR REPLACE FUNCTION synthia_reject_process_profile_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_type IS DISTINCT FROM NEW.project_type
     OR OLD.process_version_id IS DISTINCT FROM NEW.process_version_id
     OR OLD.process_profile_id IS DISTINCT FROM NEW.process_profile_id
     OR OLD.process_profile_version IS DISTINCT FROM NEW.process_profile_version
     OR OLD.process_profile_name IS DISTINCT FROM NEW.process_profile_name THEN
    RAISE EXCEPTION 'project process profile is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS project_process_profile_immutable ON project;
CREATE TRIGGER project_process_profile_immutable BEFORE UPDATE ON project
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_process_profile_change();

CREATE TABLE IF NOT EXISTS role_assignment (
    id          text PRIMARY KEY,
    project_id  text NOT NULL REFERENCES project(id),
    actor_type  actor_type NOT NULL,
    actor_id    text NOT NULL,
    role        text NOT NULL,
    permissions jsonb NOT NULL DEFAULT '{}',
    assigned_at timestamptz NOT NULL DEFAULT now()
);

-- ── content ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS artifact (
    id           text PRIMARY KEY,
    project_id   text NOT NULL REFERENCES project(id),
    artifact_type text NOT NULL,
    title        text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT artifact_id_project_unique UNIQUE (id, project_id)
);

CREATE TABLE IF NOT EXISTS artifact_revision (
    id            text PRIMARY KEY,
    artifact_id   text NOT NULL REFERENCES artifact(id),
    project_id    text NOT NULL REFERENCES project(id),
    version       integer NOT NULL,
    state         artifact_rev_state NOT NULL DEFAULT 'candidate',
    parent_revision_id text REFERENCES artifact_revision(id),
    content_hash  text NOT NULL,
    content_location text NOT NULL,
    content       text,
    schema_version text NOT NULL DEFAULT 'v1',
    source_ids    text[] NOT NULL DEFAULT '{}',
    data_classification data_classification NOT NULL DEFAULT 'D1',
    tool_model_provenance jsonb,
    change_reason text NOT NULL DEFAULT '',
    created_by    text NOT NULL,
    created_by_type actor_type NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    review_ids    text[] NOT NULL DEFAULT '{}',
    UNIQUE (artifact_id, version),
    CONSTRAINT artifact_revision_id_artifact_project_unique
      UNIQUE (id, artifact_id, project_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS artifact_revision_id_project_unique_idx
  ON artifact_revision(id, project_id);

-- ── historical material imports (P2) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS import_snapshot (
    id                 text PRIMARY KEY,
    project_id         text NOT NULL REFERENCES project(id),
    status             text NOT NULL DEFAULT 'pending_confirmation'
                         CHECK (status IN ('pending_confirmation','confirmed','denied','failed','expired')),
    source_kind        text NOT NULL
                         CHECK (source_kind IN ('project','local_directory','zip')),
    source_project_id  text REFERENCES project(id),
    source_name        text NOT NULL DEFAULT '',
    source_locator     text,
    source_commit      text,
    source_hash        text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    expires_at         timestamptz,
    created_by_type    actor_type NOT NULL,
    created_by         text NOT NULL,
    confirmed_by       text,
    confirmed_at       timestamptz,
    denial_reason      text,
    denied_at          timestamptz,
    failure_reason     text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (id, source_project_id),
    CHECK (source_kind <> 'project' OR source_project_id IS NOT NULL),
    CHECK (source_kind = 'project' OR source_project_id IS NULL),
    CHECK (source_project_id IS NULL OR source_project_id <> project_id)
);

CREATE TABLE IF NOT EXISTS import_source (
    id                 text PRIMARY KEY,
    snapshot_id        text NOT NULL UNIQUE REFERENCES import_snapshot(id),
    source_kind        text NOT NULL
                         CHECK (source_kind IN ('project','local_directory','zip')),
    source_project_id  text REFERENCES project(id),
    source_name        text NOT NULL DEFAULT '',
    source_locator     text,
    source_commit      text,
    source_hash        text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    created_at         timestamptz NOT NULL DEFAULT now(),
    CHECK (source_kind <> 'project' OR source_project_id IS NOT NULL),
    CHECK (source_kind = 'project' OR source_project_id IS NULL)
);

CREATE TABLE IF NOT EXISTS import_file_entry (
    id             text PRIMARY KEY,
    snapshot_id    text NOT NULL REFERENCES import_snapshot(id) ON DELETE CASCADE,
    path           text NOT NULL,
    content        bytea NOT NULL,
    content_text   text,
    content_hash   text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    size_bytes     bigint NOT NULL CHECK (size_bytes >= 0),
    media_type     text NOT NULL DEFAULT 'text/plain',
    valid          boolean NOT NULL DEFAULT true,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, snapshot_id),
    UNIQUE (snapshot_id, path)
);

CREATE TABLE IF NOT EXISTS import_source_relation (
    id                 text PRIMARY KEY,
    project_id         text NOT NULL REFERENCES project(id),
    snapshot_id        text NOT NULL REFERENCES import_snapshot(id),
    entry_id           text NOT NULL REFERENCES import_file_entry(id),
    source_project_id  text REFERENCES project(id),
    target_revision_id text NOT NULL REFERENCES artifact_revision(id),
    source_hash        text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    relation_kind      text NOT NULL DEFAULT 'imported_candidate'
                         CHECK (relation_kind = 'imported_candidate'),
    created_by_type    actor_type NOT NULL,
    created_by         text NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),
    UNIQUE (target_revision_id),
    FOREIGN KEY (snapshot_id, project_id) REFERENCES import_snapshot(id, project_id),
    FOREIGN KEY (snapshot_id, source_project_id) REFERENCES import_snapshot(id, source_project_id),
    FOREIGN KEY (entry_id, snapshot_id) REFERENCES import_file_entry(id, snapshot_id),
    FOREIGN KEY (target_revision_id, project_id) REFERENCES artifact_revision(id, project_id)
);

CREATE TABLE IF NOT EXISTS import_audit_event (
    id          text PRIMARY KEY,
    project_id  text NOT NULL REFERENCES project(id),
    snapshot_id text NOT NULL REFERENCES import_snapshot(id),
    entry_id    text REFERENCES import_file_entry(id),
    action      text NOT NULL CHECK (action IN ('imported','confirmed','denied','failed','expired','copied')),
    actor_type  actor_type NOT NULL,
    actor_id    text NOT NULL,
    details     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (snapshot_id, project_id) REFERENCES import_snapshot(id, project_id),
    FOREIGN KEY (entry_id, snapshot_id) REFERENCES import_file_entry(id, snapshot_id)
);

CREATE INDEX IF NOT EXISTS import_snapshot_project_created_idx
  ON import_snapshot(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS import_snapshot_project_status_idx
  ON import_snapshot(project_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS import_file_entry_snapshot_path_idx
  ON import_file_entry(snapshot_id, path);
CREATE INDEX IF NOT EXISTS import_file_entry_hash_idx
  ON import_file_entry(content_hash);
CREATE INDEX IF NOT EXISTS import_source_project_idx
  ON import_source(source_project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS import_source_relation_project_idx
  ON import_source_relation(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS import_audit_snapshot_idx
  ON import_audit_event(snapshot_id, created_at);

-- ── configuration & governance ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS configuration_snapshot (
    id              text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES project(id),
    member_revision_ids text[] NOT NULL,
    trace_relation_ids text[] NOT NULL DEFAULT '{}',
    gate_profile_version text NOT NULL,
    tool_model_policy_hash text NOT NULL,
    manifest_hash   text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      text NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_submission (
    id              text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES project(id),
    process_instance_id text NOT NULL REFERENCES process_instance(id),
    gate            gate_id NOT NULL,
    snapshot_id     text NOT NULL REFERENCES configuration_snapshot(id),
    state           gate_sub_state NOT NULL DEFAULT 'preparing',
    submitter_id    text NOT NULL,
    check_results   jsonb,
    issues          text[] NOT NULL DEFAULT '{}',
    created_at      timestamptz NOT NULL DEFAULT now(),
    submitted_at    timestamptz
);

CREATE TABLE IF NOT EXISTS approval_record (
    id                  text PRIMARY KEY,
    project_id          text NOT NULL REFERENCES project(id),
    gate_submission_id  text NOT NULL REFERENCES gate_submission(id),
    decision            approval_decision NOT NULL,
    approver_id         text NOT NULL,
    approver_role       text NOT NULL,
    authorization_basis text NOT NULL,
    reason              text NOT NULL,
    issues              text[] NOT NULL DEFAULT '{}',
    risks               text[] NOT NULL DEFAULT '{}',
    waivers             text[] NOT NULL DEFAULT '{}',
    check_results_hash  text NOT NULL,
    signed_at           timestamptz NOT NULL,
    signature_method    text NOT NULL DEFAULT 'platform_token',
    client_audit_digest text,
    approved_gate_result_id text,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approved_gate_result (
    id              text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES project(id),
    gate            gate_id NOT NULL,
    gate_submission_id text NOT NULL REFERENCES gate_submission(id),
    approval_record_id text NOT NULL REFERENCES approval_record(id),
    snapshot_id     text NOT NULL REFERENCES configuration_snapshot(id),
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS baseline (
    id              text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES project(id),
    kind            baseline_kind NOT NULL,
    state           baseline_state NOT NULL DEFAULT 'active',
    approved_gate_result_id text NOT NULL REFERENCES approved_gate_result(id),
    member_revision_ids text[] NOT NULL,
    trace_relation_ids text[] NOT NULL DEFAULT '{}',
    manifest_hash   text NOT NULL,
    approval_record_id text NOT NULL REFERENCES approval_record(id),
    created_at      timestamptz NOT NULL DEFAULT now(),
    superseded_by_baseline_id text REFERENCES baseline(id)
);

-- ── execution ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tool_run (
    id              text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES project(id),
    operation       text NOT NULL,
    capability_version text NOT NULL DEFAULT 'v1',
    run_class       run_class NOT NULL,
    state           tool_run_state NOT NULL DEFAULT 'submitted',
    input_snapshot_id text REFERENCES configuration_snapshot(id),
    input_manifest_hash text,
    authorization_context jsonb NOT NULL DEFAULT '{}',
    toolchain_profile_hash text,
    connector_id    text,
    worker_id       text,
    command         text,
    parameters      jsonb,
    return_code     integer,
    start_time      timestamptz,
    end_time        timestamptz,
    error_code      text,                       -- 0004: connector-reported failure code (terminal)
    output_sha256   text,                       -- 0004: SHA-256 of connector primary output (terminal)
    evidence        jsonb,                       -- 0004: frozen terminal evidence manifest
    correlation_id  text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evidence (
    id              text PRIMARY KEY,
    tool_run_id     text NOT NULL REFERENCES tool_run(id),
    project_id      text NOT NULL REFERENCES project(id),
    artifact_id     text NOT NULL,   -- = SHA-256 (content-addressed in MinIO)
    uri             text NOT NULL,
    sha256          text NOT NULL,
    size_bytes      bigint NOT NULL,
    media_type      text NOT NULL,
    completeness    text NOT NULL DEFAULT 'full' CHECK (completeness IN ('full','partial')),
    orphaned        boolean NOT NULL DEFAULT false,
    corrupt         boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── trace ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trace_relation (
    id              text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES project(id),
    source_type     text NOT NULL,
    source_id       text NOT NULL,
    target_type     text NOT NULL,
    target_id       text NOT NULL,
    relation_kind   text NOT NULL,
    state           trace_state NOT NULL DEFAULT 'candidate',
    basis           text NOT NULL DEFAULT '',
    data_classification data_classification NOT NULL DEFAULT 'D1',
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── core invariants (ARC-002 §6) as DB constraints ────────────────────────────

-- Invariant 2: only humans approve (enforced at API layer; DB constraint as backup)
-- The approver_id is a human identity. Agent/connector auth is rejected by RBAC.
-- This is a soft constraint — the service layer must enforce actor_type=human.

-- Invariant: no candidate baseline (baseline always starts active from approval).
-- Idempotent: mirrors the CHECK added in migration 0002.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'baseline_no_candidate'
       AND conrelid = 'public.baseline'::regclass
  ) THEN
    ALTER TABLE baseline ADD CONSTRAINT baseline_no_candidate
      CHECK (state::text <> 'candidate');
  END IF;
END;
$$;

-- Invariant: milestone gates only create baselines (G1/G3/G4/G7/G9)
-- Enforced at service layer; documented here for auditors.

-- ── indexes ───────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_revision_artifact ON artifact_revision (artifact_id, version);
CREATE INDEX IF NOT EXISTS idx_revision_project_state ON artifact_revision (project_id, state);
CREATE INDEX IF NOT EXISTS idx_submission_project_gate ON gate_submission (project_id, gate);
CREATE INDEX IF NOT EXISTS idx_approval_submission ON approval_record (gate_submission_id);
CREATE INDEX IF NOT EXISTS idx_baseline_project_kind ON baseline (project_id, kind) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_toolrun_project ON tool_run (project_id, state);
CREATE INDEX IF NOT EXISTS idx_evidence_run ON evidence (tool_run_id);
CREATE INDEX IF NOT EXISTS idx_trace_source ON trace_relation (project_id, source_id);
CREATE INDEX IF NOT EXISTS idx_trace_target ON trace_relation (project_id, target_id);
CREATE INDEX IF NOT EXISTS idx_trace_search ON trace_relation USING gin (source_id gin_trgm_ops, target_id gin_trgm_ops);

-- ── outbox, idempotency & append-only governance (0001 / 0002) ────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id uuid PRIMARY KEY,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  project_id text NOT NULL,
  payload jsonb NOT NULL,
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text NOT NULL,
  causation_id text,
  classification text NOT NULL CHECK (classification IN ('D1','D2','D3','D4','UNCLASSIFIED')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (aggregate_type, aggregate_id, sequence)
);
CREATE INDEX IF NOT EXISTS outbox_events_unpublished_idx ON outbox_events (occurred_at, event_id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS idempotency_records (
  actor_type text NOT NULL CHECK (actor_type IN ('human','agent','connector','system','service')),
  actor_id text NOT NULL,
  project_id text NOT NULL,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('in_progress','completed','failed')),
  response jsonb,
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (actor_type, actor_id, project_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idempotency_records_created_idx ON idempotency_records (created_at);

-- Append-only guard: governed records (ApprovalRecord, ApprovedGateResult,
-- Baseline) reject UPDATE / DELETE. Revocation is a new ApprovalRecord with
-- decision 'revoke'; supersession is a new Baseline linked via
-- superseded_by_baseline_id. Never an in-place mutation.
CREATE OR REPLACE FUNCTION synthia_reject_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects %', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION synthia_reject_import_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'import snapshot is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.source_kind IS DISTINCT FROM NEW.source_kind
     OR OLD.source_project_id IS DISTINCT FROM NEW.source_project_id
     OR OLD.source_name IS DISTINCT FROM NEW.source_name
     OR OLD.source_locator IS DISTINCT FROM NEW.source_locator
     OR OLD.source_commit IS DISTINCT FROM NEW.source_commit
     OR OLD.source_hash IS DISTINCT FROM NEW.source_hash
     OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
     OR OLD.created_by_type IS DISTINCT FROM NEW.created_by_type
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'import snapshot source is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.status = NEW.status THEN
    RAISE EXCEPTION 'import snapshot rejects same-state mutation' USING ERRCODE = '55000';
  ELSIF OLD.status = 'pending_confirmation' AND NEW.status = 'confirmed' THEN
    IF NEW.confirmed_by IS NULL OR NEW.confirmed_at IS NULL
       OR NEW.denial_reason IS DISTINCT FROM OLD.denial_reason
       OR NEW.denied_at IS DISTINCT FROM OLD.denied_at
       OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason THEN
      RAISE EXCEPTION 'invalid confirmed decision fields' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'pending_confirmation' AND NEW.status = 'denied' THEN
    IF NEW.denied_at IS NULL
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason THEN
      RAISE EXCEPTION 'invalid denied decision fields' USING ERRCODE = '55000';
    END IF;
  ELSIF OLD.status = 'pending_confirmation' AND NEW.status = 'failed' THEN
    IF NEW.failure_reason IS NULL
       OR NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.denial_reason IS DISTINCT FROM OLD.denial_reason
       OR NEW.denied_at IS DISTINCT FROM OLD.denied_at THEN
      RAISE EXCEPTION 'invalid failed decision fields' USING ERRCODE = '55000';
    END IF;
  ELSIF (OLD.status = 'pending_confirmation' OR OLD.status = 'confirmed') AND NEW.status = 'expired' THEN
    IF NEW.confirmed_by IS DISTINCT FROM OLD.confirmed_by
       OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
       OR NEW.denial_reason IS DISTINCT FROM OLD.denial_reason
       OR NEW.denied_at IS DISTINCT FROM OLD.denied_at
       OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason THEN
      RAISE EXCEPTION 'expired transition cannot alter decision fields' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal import snapshot state transition: % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS import_snapshot_immutable ON import_snapshot;
CREATE TRIGGER import_snapshot_immutable BEFORE UPDATE OR DELETE ON import_snapshot
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_import_snapshot_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_import_source()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM import_snapshot s
     WHERE s.id = NEW.snapshot_id
       AND s.source_kind = NEW.source_kind
       AND s.source_project_id IS NOT DISTINCT FROM NEW.source_project_id
       AND s.source_name = NEW.source_name
       AND s.source_locator IS NOT DISTINCT FROM NEW.source_locator
       AND s.source_commit IS NOT DISTINCT FROM NEW.source_commit
       AND s.source_hash = NEW.source_hash
  ) THEN
    RAISE EXCEPTION 'import source does not match fixed snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS import_source_consistent ON import_source;
CREATE TRIGGER import_source_consistent BEFORE INSERT OR UPDATE ON import_source
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_import_source();

DROP TRIGGER IF EXISTS project_source_relation_append_only ON project_source_relation;
CREATE TRIGGER project_source_relation_append_only BEFORE UPDATE OR DELETE ON project_source_relation
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

DROP TRIGGER IF EXISTS import_file_entry_append_only ON import_file_entry;
CREATE TRIGGER import_file_entry_append_only BEFORE UPDATE OR DELETE ON import_file_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS import_source_append_only ON import_source;
CREATE TRIGGER import_source_append_only BEFORE UPDATE OR DELETE ON import_source
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS import_source_relation_append_only ON import_source_relation;
CREATE TRIGGER import_source_relation_append_only BEFORE UPDATE OR DELETE ON import_source_relation
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS import_audit_event_append_only ON import_audit_event;
CREATE TRIGGER import_audit_event_append_only BEFORE UPDATE OR DELETE ON import_audit_event
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

DROP TRIGGER IF EXISTS approval_record_append_only ON approval_record;
CREATE TRIGGER approval_record_append_only BEFORE UPDATE OR DELETE ON approval_record
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

DROP TRIGGER IF EXISTS approved_gate_result_append_only ON approved_gate_result;
CREATE TRIGGER approved_gate_result_append_only BEFORE UPDATE OR DELETE ON approved_gate_result
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

DROP TRIGGER IF EXISTS baseline_append_only ON baseline;
CREATE TRIGGER baseline_append_only BEFORE UPDATE OR DELETE ON baseline
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

-- Deterministic uniqueness for the approval slice.
CREATE UNIQUE INDEX IF NOT EXISTS approved_gate_result_unique_submission
    ON approved_gate_result (gate_submission_id);
CREATE UNIQUE INDEX IF NOT EXISTS baseline_unique_active_project_kind
    ON baseline (project_id, kind) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS baseline_unique_approved_gate_result
    ON baseline (approved_gate_result_id);

-- ── isolated task workspaces (0009 / P3 first slice) ─────────────────────────

-- Created before agent_task so the task can carry workspace_id.  The reverse
-- task_id foreign key is added after agent_task exists; both sides are deferred
-- because the API inserts agent_task then task_workspace in one transaction.
CREATE TABLE IF NOT EXISTS task_workspace (
    id                 text PRIMARY KEY,
    task_id            text NOT NULL,
    project_id         text NOT NULL REFERENCES project(id),
    state              text NOT NULL DEFAULT 'provisioning'
                         CHECK (state IN ('provisioning','active','sealed','failed','released')),
    storage_key        text NOT NULL UNIQUE
                         CHECK (storage_key ~ '^[A-Za-z0-9._-]{1,128}$' AND storage_key NOT IN ('.','..')),
    base_commit        text NOT NULL
                         CHECK (base_commit ~ '^[0-9a-f]{40}$' OR base_commit ~ '^[0-9a-f]{64}$'),
    base_manifest_hash text NOT NULL CHECK (base_manifest_hash ~ '^[0-9a-f]{64}$'),
    head_commit        text
                         CHECK (head_commit IS NULL OR head_commit ~ '^[0-9a-f]{40}$' OR head_commit ~ '^[0-9a-f]{64}$'),
    failure_reason     text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    sealed_at          timestamptz,
    released_at        timestamptz,
    UNIQUE (id, project_id),
    UNIQUE (task_id, project_id),
    UNIQUE (id, task_id, project_id),
    CONSTRAINT task_workspace_state_shape CHECK (
      (state = 'provisioning' AND head_commit IS NULL AND sealed_at IS NULL AND released_at IS NULL AND failure_reason IS NULL)
      OR (state = 'active' AND head_commit IS NOT NULL AND sealed_at IS NULL AND released_at IS NULL AND failure_reason IS NULL)
      OR (state = 'sealed' AND head_commit IS NOT NULL AND sealed_at IS NOT NULL AND released_at IS NULL AND failure_reason IS NULL)
      OR (state = 'released' AND head_commit IS NOT NULL AND sealed_at IS NOT NULL AND released_at IS NOT NULL AND failure_reason IS NULL)
      OR (state = 'failed' AND failure_reason IS NOT NULL AND btrim(failure_reason) <> '' AND released_at IS NULL)
    )
);

CREATE TABLE IF NOT EXISTS agent_task (
    id                  text PRIMARY KEY,
    project_id          text NOT NULL,
    project_type        text NOT NULL CHECK (project_type IN ('free','engineering')),
    kind                text NOT NULL CHECK (kind IN ('main','side')),
    parent_task_id      text,
    workspace_id        text,
    process_instance_id text,
    runtime_agent_id    text,
    runtime_actor_id    text NOT NULL CHECK (btrim(runtime_actor_id) <> ''),
    objective           text NOT NULL CHECK (btrim(objective) <> ''),
    authorization_scope jsonb NOT NULL CHECK (jsonb_typeof(authorization_scope) = 'object'),
    status              text NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','running','awaiting_user','succeeded','failed','cancelled','fail_closed')),
    input_hash          text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    output_hash         text CHECK (output_hash IS NULL OR output_hash ~ '^[0-9a-f]{64}$'),
    adoption_state      text NOT NULL DEFAULT 'not_applicable'
                          CHECK (adoption_state IN ('not_applicable','pending','available','partially_adopted','adopted','discarded')),
    current_stage       text,
    awaiting_gate       gate_id,
    runtime_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb
                          CHECK (jsonb_typeof(runtime_snapshot) = 'object'),
    created_by_type     actor_type NOT NULL,
    created_by          text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz,
    UNIQUE (id, project_id),
    UNIQUE (id, workspace_id, project_id),
    CONSTRAINT agent_task_project_binding_fk
      FOREIGN KEY (project_id, project_type) REFERENCES project(id, project_type),
    CONSTRAINT agent_task_parent_project_fk
      FOREIGN KEY (parent_task_id, project_id) REFERENCES agent_task(id, project_id),
    CONSTRAINT agent_task_workspace_project_fk
      FOREIGN KEY (workspace_id, id, project_id)
      REFERENCES task_workspace(id, task_id, project_id)
      DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT agent_task_process_project_fk
      FOREIGN KEY (process_instance_id, project_id)
      REFERENCES process_instance(id, project_id),
    CONSTRAINT agent_task_kind_shape CHECK (
      (
        kind = 'main'
        AND parent_task_id IS NULL
        AND workspace_id IS NULL
        AND (
          (project_type = 'free' AND process_instance_id IS NULL)
          OR (project_type = 'engineering' AND process_instance_id IS NOT NULL)
        )
      )
      OR
      (
        kind = 'side'
        AND parent_task_id IS NOT NULL
        AND workspace_id IS NOT NULL
        AND process_instance_id IS NULL
        AND awaiting_gate IS NULL
      )
    ),
    CONSTRAINT agent_task_terminal_shape CHECK (
      (
        status IN ('queued','running','awaiting_user')
        AND output_hash IS NULL
        AND finished_at IS NULL
      )
      OR
      (
        status = 'succeeded'
        AND output_hash IS NOT NULL
        AND finished_at IS NOT NULL
      )
      OR
      (
        status IN ('failed','cancelled','fail_closed')
        AND output_hash IS NULL
        AND finished_at IS NOT NULL
      )
    ),
    CONSTRAINT agent_task_adoption_shape CHECK (
      (kind = 'main' AND adoption_state = 'not_applicable')
      OR
      (
        kind = 'side'
        AND (
          (status IN ('queued','running','awaiting_user') AND adoption_state = 'pending')
          OR (status = 'succeeded' AND adoption_state IN ('available','partially_adopted','adopted','discarded'))
          OR (status IN ('failed','cancelled','fail_closed') AND adoption_state = 'discarded')
        )
      )
    )
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'task_workspace_task_project_fk'
       AND conrelid = 'public.task_workspace'::regclass
  ) THEN
    ALTER TABLE task_workspace
      ADD CONSTRAINT task_workspace_task_project_fk
      FOREIGN KEY (task_id, id, project_id)
      REFERENCES agent_task(id, workspace_id, project_id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS agent_task_one_active_engineering_main_idx
  ON agent_task(project_id)
  WHERE project_type = 'engineering'
    AND kind = 'main'
    AND status IN ('queued','running','awaiting_user');
CREATE UNIQUE INDEX IF NOT EXISTS agent_task_runtime_agent_unique_idx
  ON agent_task(runtime_agent_id) WHERE runtime_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_task_project_created_idx
  ON agent_task(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_task_parent_created_idx
  ON agent_task(parent_task_id, created_at) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_workspace_project_state_idx
  ON task_workspace(project_id, state, created_at DESC);

CREATE TABLE IF NOT EXISTS task_conversation_event (
    id            text PRIMARY KEY,
    project_id    text NOT NULL REFERENCES project(id),
    task_id       text NOT NULL,
    sequence      bigint NOT NULL CHECK (sequence > 0),
    event_kind    text NOT NULL
                   CHECK (event_kind IN ('user_message','assistant_message','tool_call','tool_result','status')),
    payload       jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    payload_hash  text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    actor_type    actor_type NOT NULL,
    actor_id      text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (task_id, sequence),
    FOREIGN KEY (task_id, project_id) REFERENCES agent_task(id, project_id)
);
CREATE INDEX IF NOT EXISTS task_conversation_event_task_created_idx
  ON task_conversation_event(task_id, created_at, sequence);

-- Immutable file versions produced inside an isolated task workspace.  Only
-- UTF-8 text up to one MiB is accepted in slice 1.  A->B->A remains three
-- versions, so content hash is deliberately not unique per path.
CREATE TABLE IF NOT EXISTS task_workspace_file (
    id                text PRIMARY KEY,
    task_id           text NOT NULL,
    project_id        text NOT NULL REFERENCES project(id),
    workspace_id      text NOT NULL,
    path              text NOT NULL CHECK (path <> '' AND path !~ '^/' AND path !~ '(^|/)\.\.?(/|$)'),
    artifact_type     text NOT NULL,
    change_kind       text NOT NULL CHECK (change_kind IN ('added','modified')),
    base_content_hash text CHECK (base_content_hash IS NULL OR base_content_hash ~ '^[0-9a-f]{64}$'),
    content_hash      text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    content_text      text NOT NULL,
    size_bytes        bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 1048576),
    workspace_commit  text NOT NULL
                        CHECK (workspace_commit ~ '^[0-9a-f]{40}$' OR workspace_commit ~ '^[0-9a-f]{64}$'),
    version           integer NOT NULL CHECK (version > 0),
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, task_id, project_id),
    UNIQUE (id, task_id, project_id, path, content_hash),
    UNIQUE (task_id, path, version),
    CONSTRAINT task_workspace_file_change_shape CHECK (
      (change_kind = 'added' AND base_content_hash IS NULL)
      OR (change_kind = 'modified' AND base_content_hash IS NOT NULL)
    ),
    CONSTRAINT task_workspace_file_content_size CHECK (size_bytes = octet_length(content_text)),
    CONSTRAINT task_workspace_file_content_digest CHECK (
      content_hash = encode(digest(convert_to(content_text, 'UTF8'), 'sha256'), 'hex')
    ),
    FOREIGN KEY (task_id, workspace_id, project_id)
      REFERENCES agent_task(id, workspace_id, project_id)
);
CREATE INDEX IF NOT EXISTS task_workspace_file_task_path_idx
  ON task_workspace_file(task_id, path, version DESC);
CREATE INDEX IF NOT EXISTS task_workspace_file_commit_idx
  ON task_workspace_file(workspace_id, workspace_commit);

CREATE TABLE IF NOT EXISTS task_result (
    id              text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES project(id),
    task_id         text NOT NULL,
    workspace_id    text NOT NULL,
    base_commit     text NOT NULL
                      CHECK (base_commit ~ '^[0-9a-f]{40}$' OR base_commit ~ '^[0-9a-f]{64}$'),
    result_commit   text NOT NULL
                      CHECK (result_commit ~ '^[0-9a-f]{40}$' OR result_commit ~ '^[0-9a-f]{64}$'),
    summary         text NOT NULL DEFAULT '',
    tests           jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tests) = 'array'),
    manifest        jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
    output_hash     text NOT NULL CHECK (output_hash ~ '^[0-9a-f]{64}$'),
    created_by_type actor_type NOT NULL,
    created_by      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, project_id),
    UNIQUE (id, task_id, project_id),
    UNIQUE (task_id, output_hash),
    FOREIGN KEY (task_id, workspace_id, project_id)
      REFERENCES agent_task(id, workspace_id, project_id)
);
CREATE INDEX IF NOT EXISTS task_result_project_created_idx
  ON task_result(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_adoption (
    id                    text PRIMARY KEY,
    project_id            text NOT NULL REFERENCES project(id),
    task_id               text NOT NULL,
    result_id             text NOT NULL,
    state                 text NOT NULL DEFAULT 'applying'
                            CHECK (state IN ('applying','applied','conflicted','failed')),
    selection_hash        text NOT NULL CHECK (selection_hash ~ '^[0-9a-f]{64}$'),
    project_commit_before text NOT NULL
                            CHECK (project_commit_before ~ '^[0-9a-f]{40}$' OR project_commit_before ~ '^[0-9a-f]{64}$'),
    project_commit_after  text
                            CHECK (project_commit_after IS NULL OR project_commit_after ~ '^[0-9a-f]{40}$' OR project_commit_after ~ '^[0-9a-f]{64}$'),
    reason                text NOT NULL CHECK (btrim(reason) <> ''),
    details               jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_by_type       actor_type NOT NULL CHECK (created_by_type = 'human'),
    created_by            text NOT NULL,
    created_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz,
    UNIQUE (id, project_id),
    UNIQUE (id, task_id, result_id, project_id),
    CONSTRAINT task_adoption_state_shape CHECK (
      (state = 'applying' AND project_commit_after IS NULL AND completed_at IS NULL)
      OR (state = 'applied' AND project_commit_after IS NOT NULL AND completed_at IS NOT NULL)
      OR (state IN ('conflicted','failed') AND project_commit_after IS NULL AND completed_at IS NOT NULL)
    ),
    FOREIGN KEY (task_id, project_id) REFERENCES agent_task(id, project_id),
    FOREIGN KEY (result_id, task_id, project_id) REFERENCES task_result(id, task_id, project_id)
);
CREATE INDEX IF NOT EXISTS task_adoption_task_created_idx
  ON task_adoption(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_adoption_file (
    adoption_id        text NOT NULL,
    project_id         text NOT NULL REFERENCES project(id),
    task_id            text NOT NULL,
    result_id          text NOT NULL,
    workspace_file_id  text NOT NULL,
    path               text NOT NULL,
    source_content_hash text NOT NULL CHECK (source_content_hash ~ '^[0-9a-f]{64}$'),
    prior_target_hash  text CHECK (prior_target_hash IS NULL OR prior_target_hash ~ '^[0-9a-f]{64}$'),
    target_artifact_id text NOT NULL,
    target_revision_id text NOT NULL,
    target_version     integer NOT NULL CHECK (target_version > 0),
    created_at         timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (adoption_id, path),
    UNIQUE (task_id, result_id, path),
    FOREIGN KEY (adoption_id, task_id, result_id, project_id)
      REFERENCES task_adoption(id, task_id, result_id, project_id),
    FOREIGN KEY (workspace_file_id, task_id, project_id, path, source_content_hash)
      REFERENCES task_workspace_file(id, task_id, project_id, path, content_hash),
    FOREIGN KEY (target_revision_id, target_artifact_id, project_id)
      REFERENCES artifact_revision(id, artifact_id, project_id)
);
CREATE INDEX IF NOT EXISTS task_adoption_file_revision_idx
  ON task_adoption_file(target_revision_id);

CREATE OR REPLACE FUNCTION synthia_validate_side_task_parent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'side' AND NOT EXISTS (
    SELECT 1 FROM agent_task parent
     WHERE parent.id = NEW.parent_task_id
       AND parent.project_id = NEW.project_id
       AND parent.kind = 'main'
       AND parent.status IN ('queued','running','awaiting_user')
  ) THEN
    RAISE EXCEPTION 'side task requires an active main parent in the same project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_task_parent_guard ON agent_task;
CREATE TRIGGER agent_task_parent_guard BEFORE INSERT ON agent_task
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_side_task_parent();

CREATE OR REPLACE FUNCTION synthia_validate_task_workspace_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task workspace rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.storage_key IS DISTINCT FROM NEW.storage_key
     OR OLD.base_commit IS DISTINCT FROM NEW.base_commit
     OR OLD.base_manifest_hash IS DISTINCT FROM NEW.base_manifest_hash
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'task workspace identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'provisioning' AND NEW.state IN ('active','failed') THEN
    NULL;
  ELSIF OLD.state = 'active' AND NEW.state IN ('active','sealed','failed') THEN
    NULL;
  ELSIF OLD.state = 'sealed' AND NEW.state = 'released' THEN
    IF OLD.head_commit IS DISTINCT FROM NEW.head_commit OR OLD.sealed_at IS DISTINCT FROM NEW.sealed_at THEN
      RAISE EXCEPTION 'sealed task workspace is immutable' USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'illegal task workspace transition: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS task_workspace_state_guard ON task_workspace;
CREATE TRIGGER task_workspace_state_guard BEFORE UPDATE OR DELETE ON task_workspace
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_task_workspace_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_agent_task_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent task rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.project_type IS DISTINCT FROM NEW.project_type
     OR OLD.kind IS DISTINCT FROM NEW.kind
     OR OLD.parent_task_id IS DISTINCT FROM NEW.parent_task_id
     OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.process_instance_id IS DISTINCT FROM NEW.process_instance_id
     OR OLD.runtime_actor_id IS DISTINCT FROM NEW.runtime_actor_id
     OR OLD.objective IS DISTINCT FROM NEW.objective
     OR OLD.authorization_scope IS DISTINCT FROM NEW.authorization_scope
     OR OLD.input_hash IS DISTINCT FROM NEW.input_hash
     OR OLD.created_by_type IS DISTINCT FROM NEW.created_by_type
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'agent task identity/input is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.runtime_agent_id IS NOT NULL AND OLD.runtime_agent_id IS DISTINCT FROM NEW.runtime_agent_id THEN
    RAISE EXCEPTION 'runtime agent binding is immutable once set' USING ERRCODE = '55000';
  END IF;
  IF OLD.output_hash IS NOT NULL AND OLD.output_hash IS DISTINCT FROM NEW.output_hash THEN
    RAISE EXCEPTION 'task output hash is immutable once set' USING ERRCODE = '55000';
  END IF;
  -- Adoption progresses after a side task succeeds, while task status remains
  -- terminal. Same-status updates are therefore valid; only transitions out
  -- of a terminal status are forbidden below.
  IF OLD.status = NEW.status THEN
    NULL;
  ELSIF OLD.status = 'queued' AND NEW.status IN ('running','failed','cancelled','fail_closed') THEN
    NULL;
  ELSIF OLD.status = 'running' AND NEW.status IN ('awaiting_user','succeeded','failed','cancelled','fail_closed') THEN
    NULL;
  ELSIF OLD.status = 'awaiting_user' AND NEW.status IN ('running','succeeded','failed','cancelled','fail_closed') THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'illegal agent task transition: % -> %', OLD.status, NEW.status USING ERRCODE = '55000';
  END IF;
  IF OLD.adoption_state IS DISTINCT FROM NEW.adoption_state THEN
    IF OLD.adoption_state = 'pending' AND NEW.adoption_state IN ('available','discarded') THEN
      NULL;
    ELSIF OLD.adoption_state = 'available' AND NEW.adoption_state IN ('partially_adopted','adopted','discarded') THEN
      NULL;
    ELSIF OLD.adoption_state = 'partially_adopted' AND NEW.adoption_state IN ('adopted','discarded') THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'illegal task adoption transition: % -> %', OLD.adoption_state, NEW.adoption_state USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_task_state_guard ON agent_task;
CREATE TRIGGER agent_task_state_guard BEFORE UPDATE OR DELETE ON agent_task
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_agent_task_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_task_adoption_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'task adoption rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.result_id IS DISTINCT FROM NEW.result_id
     OR OLD.selection_hash IS DISTINCT FROM NEW.selection_hash
     OR OLD.project_commit_before IS DISTINCT FROM NEW.project_commit_before
     OR OLD.reason IS DISTINCT FROM NEW.reason
     OR OLD.created_by_type IS DISTINCT FROM NEW.created_by_type
     OR OLD.created_by IS DISTINCT FROM NEW.created_by
     OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'task adoption request is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = 'applying' AND NEW.state IN ('applied','conflicted','failed') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal task adoption transition: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS task_adoption_state_guard ON task_adoption;
CREATE TRIGGER task_adoption_state_guard BEFORE UPDATE OR DELETE ON task_adoption
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_task_adoption_mutation();

DROP TRIGGER IF EXISTS task_conversation_event_append_only ON task_conversation_event;
CREATE TRIGGER task_conversation_event_append_only BEFORE UPDATE OR DELETE ON task_conversation_event
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS task_workspace_file_append_only ON task_workspace_file;
CREATE TRIGGER task_workspace_file_append_only BEFORE UPDATE OR DELETE ON task_workspace_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS task_result_append_only ON task_result;
CREATE TRIGGER task_result_append_only BEFORE UPDATE OR DELETE ON task_result
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS task_adoption_file_append_only ON task_adoption_file;
CREATE TRIGGER task_adoption_file_append_only BEFORE UPDATE OR DELETE ON task_adoption_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

-- ── identity & API auth (0003, IF-001 first slice, Q-011) ─────────────────────

-- Platform-internal identity with LDAP-forward field names (uid/cn/displayName/
-- memberOf/mail). `uid` is the login identity; human vs service by actor_type.
CREATE TABLE IF NOT EXISTS user_account (
    id              text PRIMARY KEY,
    uid             text NOT NULL UNIQUE,
    cn              text NOT NULL DEFAULT '',
    display_name    text NOT NULL DEFAULT '',
    member_of       text[] NOT NULL DEFAULT '{}',
    mail            text NOT NULL DEFAULT '',
    actor_type      actor_type NOT NULL,
    status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','locked')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_account_uid ON user_account (uid);
CREATE INDEX IF NOT EXISTS idx_user_account_actor_type ON user_account (actor_type);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'agent_task_runtime_actor_fk'
       AND conrelid = 'public.agent_task'::regclass
  ) THEN
    ALTER TABLE agent_task
      ADD CONSTRAINT agent_task_runtime_actor_fk
      FOREIGN KEY (runtime_actor_id) REFERENCES user_account(uid);
  END IF;
END;
$$;

-- Bearer tokens: only the SHA-256 hash is stored. The plaintext is shown once
-- at provisioning and never persisted or logged. Invalid on revoke or expiry.
CREATE TABLE IF NOT EXISTS auth_token (
    token_hash      text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    user_id         text NOT NULL REFERENCES user_account(id),
    scope           text[] NOT NULL DEFAULT '{}',
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz,
    revoked_at      timestamptz,
    last_used_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_token_user ON auth_token (user_id);

-- ── P4 process gates, formal evidence and input binding (0010) ───────────────

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

-- ── P4 work versions, bitstreams and delivery releases (0011) ───────────────

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

-- schema.sql is a complete fresh-install snapshot through 0011. Recording the
-- represented migration baseline prevents a later migrate() run from treating
-- explicit free projects as pre-0006 legacy rows.
INSERT INTO schema_migrations(version) VALUES
  ('0000_initial_schema'),
  ('0001_d1_hardening'),
  ('0002_approval_slice_hardening'),
  ('0003_identity_and_api'),
  ('0004_tool_run_evidence'),
  ('0005_revision_content'),
  ('0006_project_type_process_version'),
  ('0007_project_profile_constraints'),
  ('0008_import_snapshots'),
  ('0009_task_workspaces'),
  ('0010_process_gate_checks'),
  ('0011_delivery_release')
ON CONFLICT (version) DO NOTHING;
