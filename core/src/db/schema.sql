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
    process_version_id text DEFAULT 'LEGACY_COMPAT' REFERENCES process_version(id),
    process_profile_id text DEFAULT 'LEGACY_COMPAT',
    process_profile_version text DEFAULT 'LEGACY_COMPAT',
    process_profile_name text DEFAULT '兼容旧流程',
    toolchain_profile_ref text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    status          text NOT NULL DEFAULT 'active',
    CONSTRAINT project_id_project_type_unique UNIQUE (id, project_type),
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
    UNIQUE (id, project_id),
    CONSTRAINT artifact_revision_id_artifact_project_unique
      UNIQUE (id, artifact_id, project_id)
);

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

-- schema.sql is a complete fresh-install snapshot through 0009. Recording the
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
  ('0009_task_workspaces')
ON CONFLICT (version) DO NOTHING;
