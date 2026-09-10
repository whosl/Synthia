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
DO $$ BEGIN CREATE TYPE run_class AS ENUM ('exploratory','gate_check','formal','evolution_eval'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
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
    content_encoding text NOT NULL DEFAULT 'utf8' CHECK (content_encoding IN ('utf8','base64')),
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
  evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
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
    agent_role          text NOT NULL DEFAULT 'run'
                          CONSTRAINT agent_task_agent_role_check CHECK (agent_role IN ('project','run','side')),
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
    CONSTRAINT agent_task_role_shape CHECK (
      (kind = 'main' AND agent_role IN ('project','run'))
      OR (kind = 'side' AND agent_role = 'side')
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

CREATE UNIQUE INDEX IF NOT EXISTS agent_task_one_active_engineering_run_idx
  ON agent_task(project_id)
  WHERE project_type = 'engineering'
    AND kind = 'main'
    AND agent_role = 'run'
    AND status IN ('queued','running','awaiting_user');
CREATE UNIQUE INDEX IF NOT EXISTS agent_task_one_project_agent_idx
  ON agent_task(project_id)
  WHERE agent_role = 'project';
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

-- Immutable file versions produced inside an isolated task workspace. Text and
-- governed binary artifacts are accepted up to one MiB. A->B->A remains three
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
    content_encoding  text NOT NULL DEFAULT 'utf8' CHECK (content_encoding IN ('utf8','base64')),
    content_text      text,
    content_base64    text,
    media_type        text NOT NULL DEFAULT 'text/plain',
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
    CONSTRAINT task_workspace_file_content_shape CHECK (
      (content_encoding='utf8' AND content_text IS NOT NULL AND content_base64 IS NULL)
      OR (content_encoding='base64' AND content_text IS NULL AND content_base64 IS NOT NULL)
    ),
    CONSTRAINT task_workspace_file_content_size CHECK (
      size_bytes = CASE WHEN content_encoding='utf8'
        THEN octet_length(content_text)
        ELSE octet_length(decode(content_base64,'base64')) END
    ),
    CONSTRAINT task_workspace_file_content_digest CHECK (
      content_hash = CASE WHEN content_encoding='utf8'
        THEN encode(digest(convert_to(content_text, 'UTF8'), 'sha256'), 'hex')
        ELSE encode(digest(decode(content_base64,'base64'), 'sha256'), 'hex') END
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
       AND parent.agent_role = 'project'
  ) THEN
    RAISE EXCEPTION 'side task requires the project agent in the same project' USING ERRCODE = '23514';
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
     OR OLD.agent_role IS DISTINCT FROM NEW.agent_role
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
  ELSIF OLD.agent_role = 'project'
        AND NEW.status IN ('running','awaiting_user','failed','cancelled','fail_closed') THEN
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

-- Self-evolution v1 fact layer (equivalent to 0021_self_evolution).

-- Self-evolution is a separate Core fact domain. Learned Skills never share
-- storage with the read-only System Skill pack and never carry capabilities.

CREATE TABLE IF NOT EXISTS evolution_settings (
    singleton_id           text PRIMARY KEY CHECK (singleton_id = 'global'),
    learning_paused        boolean NOT NULL DEFAULT false,
    learned_skills_enabled boolean NOT NULL DEFAULT true,
    revision               bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by_type        actor_type NOT NULL,
    updated_by             text NOT NULL CHECK (btrim(updated_by) <> ''),
    update_reason          text NOT NULL CHECK (btrim(update_reason) <> ''),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO evolution_settings
  (singleton_id, updated_by_type, updated_by, update_reason)
VALUES ('global', 'service', 'system', 'initial self-evolution settings')
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS learning_episode (
    id                        text PRIMARY KEY,
    project_id                text NOT NULL REFERENCES project(id),
    task_id                   text NOT NULL,
    observation_key           text NOT NULL CHECK (btrim(observation_key) <> ''),
    episode_key               text NOT NULL CHECK (btrim(episode_key) <> ''),
    turn_id                   text,
    end_event_sequence        bigint NOT NULL CHECK (end_event_sequence > 0),
    content_hash              text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    outcome_claim             text,
    tool_event_start_sequence bigint CHECK (tool_event_start_sequence IS NULL OR tool_event_start_sequence > 0),
    tool_event_end_sequence   bigint CHECK (tool_event_end_sequence IS NULL OR tool_event_end_sequence > 0),
    evidence_refs             jsonb NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(evidence_refs) = 'array'),
    created_by_type           actor_type NOT NULL,
    created_by                text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, task_id, project_id),
    UNIQUE (task_id, observation_key),
    UNIQUE (task_id, episode_key),
    FOREIGN KEY (task_id, project_id) REFERENCES agent_task(id, project_id),
    FOREIGN KEY (task_id, end_event_sequence)
      REFERENCES task_conversation_event(task_id, sequence),
    CHECK (
      (tool_event_start_sequence IS NULL AND tool_event_end_sequence IS NULL)
      OR (
        tool_event_start_sequence IS NOT NULL
        AND tool_event_end_sequence IS NOT NULL
        AND tool_event_start_sequence <= tool_event_end_sequence
        AND tool_event_end_sequence <= end_event_sequence
      )
    )
);
CREATE INDEX IF NOT EXISTS learning_episode_task_observation_idx
  ON learning_episode(task_id, observation_key, created_at DESC);

-- A Core status hook may seal the boundary before Runtime receives its
-- response. The later explicit create call can add the richer immutable
-- outcome/evidence projection without mutating the sealed episode identity.
CREATE TABLE IF NOT EXISTS learning_episode_enrichment (
    episode_id                 text PRIMARY KEY REFERENCES learning_episode(id),
    content_hash               text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    outcome_claim              text,
    tool_event_start_sequence  bigint CHECK (tool_event_start_sequence IS NULL OR tool_event_start_sequence > 0),
    tool_event_end_sequence    bigint CHECK (tool_event_end_sequence IS NULL OR tool_event_end_sequence > 0),
    evidence_refs              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs)='array'),
    created_by_type            actor_type NOT NULL,
    created_by                 text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    CHECK (
      (tool_event_start_sequence IS NULL AND tool_event_end_sequence IS NULL)
      OR (tool_event_start_sequence IS NOT NULL AND tool_event_end_sequence IS NOT NULL
          AND tool_event_start_sequence <= tool_event_end_sequence)
    )
);

CREATE TABLE IF NOT EXISTS distillation_run (
    id                    text PRIMARY KEY,
    episode_id            text NOT NULL UNIQUE REFERENCES learning_episode(id),
    state                 text NOT NULL DEFAULT 'queued'
                            CHECK (state IN ('queued','running','succeeded','noop','quarantined','failed')),
    attempt               integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    worker_id             text,
    lease_token           text,
    lease_expires_at      timestamptz,
    ready_at              timestamptz NOT NULL DEFAULT now(),
    input_cutoff_at       timestamptz,
    terminal_request_hash text CHECK (terminal_request_hash IS NULL OR terminal_request_hash ~ '^[0-9a-f]{64}$'),
    terminal_result       jsonb CHECK (terminal_result IS NULL OR jsonb_typeof(terminal_result) = 'object'),
    error_code            text,
    details_hash          text CHECK (details_hash IS NULL OR details_hash ~ '^[0-9a-f]{64}$'),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz,
    CHECK (
      (state = 'queued' AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
      OR (state = 'running' AND worker_id IS NOT NULL AND btrim(worker_id) <> '' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND input_cutoff_at IS NOT NULL AND completed_at IS NULL)
      OR (state IN ('succeeded','noop','quarantined') AND input_cutoff_at IS NOT NULL AND terminal_request_hash IS NOT NULL AND terminal_result IS NOT NULL AND completed_at IS NOT NULL)
      OR (state = 'failed' AND input_cutoff_at IS NOT NULL AND error_code IS NOT NULL AND details_hash IS NOT NULL AND completed_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS distillation_run_claim_idx
  ON distillation_run(state, ready_at, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS learned_skill (
    id                    text PRIMARY KEY,
    slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    name                  text NOT NULL CHECK (btrim(name) <> ''),
    summary               text NOT NULL CHECK (btrim(summary) <> ''),
    applicability_summary text NOT NULL CHECK (btrim(applicability_summary) <> ''),
    enabled               boolean NOT NULL DEFAULT true,
    pinned                boolean NOT NULL DEFAULT false,
    availability_state    text NOT NULL DEFAULT 'available'
                            CHECK (availability_state IN ('available','archived')),
    active_version_id     text,
    control_revision      bigint NOT NULL DEFAULT 1 CHECK (control_revision > 0),
    last_used_at          timestamptz,
    created_by_type       actor_type NOT NULL,
    created_by            text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, active_version_id)
);

CREATE TABLE IF NOT EXISTS curator_run (
    id                    text PRIMARY KEY,
    mode                  text NOT NULL CHECK (mode IN ('run','dry_run')),
    state                 text NOT NULL DEFAULT 'queued'
                            CHECK (state IN ('queued','running','completed','dry_run_complete','failed')),
    schedule_bucket       text NOT NULL CHECK (btrim(schedule_bucket) <> ''),
    manual_key            text,
    eligible_at           timestamptz,
    reason                text NOT NULL CHECK (btrim(reason) <> ''),
    attempt               integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    worker_id             text,
    lease_token           text,
    lease_expires_at      timestamptz,
    terminal_request_hash text CHECK (terminal_request_hash IS NULL OR terminal_request_hash ~ '^[0-9a-f]{64}$'),
    terminal_result       jsonb CHECK (terminal_result IS NULL OR jsonb_typeof(terminal_result) = 'object'),
    error_code            text,
    details_hash          text CHECK (details_hash IS NULL OR details_hash ~ '^[0-9a-f]{64}$'),
    created_by_type       actor_type NOT NULL,
    created_by            text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz,
    UNIQUE (manual_key),
    CHECK ((manual_key IS NULL) = (eligible_at IS NOT NULL)),
    CHECK (
      (state = 'queued' AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
      OR (state = 'running' AND worker_id IS NOT NULL AND btrim(worker_id) <> '' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
      OR (state IN ('completed','dry_run_complete') AND terminal_request_hash IS NOT NULL AND terminal_result IS NOT NULL AND completed_at IS NOT NULL)
      OR (state = 'failed' AND error_code IS NOT NULL AND details_hash IS NOT NULL AND completed_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS curator_run_claim_idx
  ON curator_run(state, lease_expires_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS curator_run_scheduled_bucket_idx
  ON curator_run(schedule_bucket) WHERE manual_key IS NULL;

CREATE TABLE IF NOT EXISTS learned_skill_version (
    id                    text PRIMARY KEY,
    skill_id              text NOT NULL REFERENCES learned_skill(id),
    version_no            integer NOT NULL CHECK (version_no > 0),
    parent_version_id     text,
    description           text NOT NULL CHECK (btrim(description) <> ''),
    applicability         jsonb NOT NULL CHECK (jsonb_typeof(applicability) IN ('object','array')),
    outcome_contract      jsonb NOT NULL CHECK (jsonb_typeof(outcome_contract) IN ('object','array')),
    content_manifest_hash text NOT NULL CHECK (content_manifest_hash ~ '^[0-9a-f]{64}$'),
    scanner_version       text NOT NULL CHECK (btrim(scanner_version) <> ''),
    scan_decision         text NOT NULL CHECK (scan_decision IN ('pass','quarantine')),
    scan_findings         jsonb NOT NULL DEFAULT '[]'::jsonb
                            CHECK (jsonb_typeof(scan_findings) = 'array'),
    distillation_run_id   text REFERENCES distillation_run(id),
    curator_run_id        text REFERENCES curator_run(id),
    created_by_type       actor_type NOT NULL,
    created_by            text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, skill_id),
    UNIQUE (skill_id, version_no),
    UNIQUE (distillation_run_id),
    CHECK (num_nonnulls(distillation_run_id, curator_run_id) = 1),
    FOREIGN KEY (parent_version_id, skill_id)
      REFERENCES learned_skill_version(id, skill_id)
);

ALTER TABLE learned_skill
  DROP CONSTRAINT IF EXISTS learned_skill_active_version_fk;
ALTER TABLE learned_skill
  ADD CONSTRAINT learned_skill_active_version_fk
  FOREIGN KEY (active_version_id, id)
  REFERENCES learned_skill_version(id, skill_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS learned_skill_version_status (
    version_id            text PRIMARY KEY REFERENCES learned_skill_version(id),
    quality_state         text NOT NULL
                            CHECK (quality_state IN ('active_unproven','active_observed','needs_review','degraded','quarantined')),
    last_evaluation_id    text,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learned_skill_file (
    id            text PRIMARY KEY,
    version_id    text NOT NULL REFERENCES learned_skill_version(id),
    path          text NOT NULL CHECK (path <> '' AND path !~ '^/' AND path !~ '(^|/)\.\.?(/|$)'),
    kind          text NOT NULL CHECK (kind IN ('skill_md','reference','template','script')),
    language      text CHECK (language IS NULL OR language IN ('tcl','python','typescript')),
    sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes    bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 262144),
    media_type    text NOT NULL CHECK (btrim(media_type) <> ''),
    content       text NOT NULL CHECK (content <> ''),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (version_id, path),
    CHECK ((kind = 'script') = (language IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS learned_skill_lifecycle_event (
    id               text PRIMARY KEY,
    skill_id         text NOT NULL REFERENCES learned_skill(id),
    version_id       text REFERENCES learned_skill_version(id),
    event_type       text NOT NULL CHECK (btrim(event_type) <> ''),
    from_projection  jsonb NOT NULL CHECK (jsonb_typeof(from_projection) = 'object'),
    to_projection    jsonb NOT NULL CHECK (jsonb_typeof(to_projection) = 'object'),
    reason           text NOT NULL CHECK (btrim(reason) <> ''),
    control_revision bigint NOT NULL CHECK (control_revision > 0),
    actor_type       actor_type NOT NULL,
    actor_id         text NOT NULL CHECK (btrim(actor_id) <> ''),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learned_skill_lifecycle_skill_created_idx
  ON learned_skill_lifecycle_event(skill_id, created_at, id);

CREATE TABLE IF NOT EXISTS skill_application (
    id                        text PRIMARY KEY,
    project_id                text NOT NULL REFERENCES project(id),
    task_id                   text NOT NULL,
    observation_key           text NOT NULL CHECK (btrim(observation_key) <> ''),
    episode_id                text,
    local_goal                text NOT NULL CHECK (btrim(local_goal) <> ''),
    state                     text NOT NULL DEFAULT 'open'
                                CHECK (state IN ('open','closed_pending_episode','pending_evaluation','evaluated')),
    primary_tool_call_id      text NOT NULL CHECK (btrim(primary_tool_call_id) <> ''),
    start_event_sequence      bigint NOT NULL CHECK (start_event_sequence > 0),
    end_event_sequence        bigint CHECK (end_event_sequence IS NULL OR end_event_sequence >= start_event_sequence),
    outcome_claim             text,
    human_corrections         integer CHECK (human_corrections IS NULL OR human_corrections >= 0),
    evidence_refs             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    tool_run_refs             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_run_refs) = 'array'),
    started_at                timestamptz NOT NULL DEFAULT now(),
    closed_at                 timestamptz,
    created_by_type           actor_type NOT NULL,
    created_by                text NOT NULL CHECK (btrim(created_by) <> ''),
    UNIQUE (id, task_id, project_id),
    UNIQUE (task_id, primary_tool_call_id),
    FOREIGN KEY (task_id, project_id) REFERENCES agent_task(id, project_id),
    FOREIGN KEY (episode_id, task_id, project_id)
      REFERENCES learning_episode(id, task_id, project_id),
    FOREIGN KEY (task_id, start_event_sequence)
      REFERENCES task_conversation_event(task_id, sequence),
    CHECK (
      (state = 'open' AND end_event_sequence IS NULL AND closed_at IS NULL AND human_corrections IS NULL)
      OR (state IN ('closed_pending_episode','pending_evaluation','evaluated') AND end_event_sequence IS NOT NULL AND closed_at IS NOT NULL AND human_corrections IS NOT NULL)
    ),
    CHECK (
      (episode_id IS NULL AND state IN ('open','closed_pending_episode'))
      OR (episode_id IS NOT NULL AND state IN ('open','pending_evaluation','evaluated'))
    )
);
CREATE INDEX IF NOT EXISTS skill_application_pending_idx
  ON skill_application(state, closed_at) WHERE state = 'pending_evaluation';
CREATE INDEX IF NOT EXISTS skill_application_observation_idx
  ON skill_application(task_id, observation_key) WHERE episode_id IS NULL;

CREATE TABLE IF NOT EXISTS skill_application_skill (
    id             text PRIMARY KEY,
    application_id text NOT NULL REFERENCES skill_application(id),
    skill_id       text NOT NULL REFERENCES learned_skill(id),
    version_id     text NOT NULL,
    role           text NOT NULL CHECK (role IN ('primary','supporting')),
    tool_call_id   text NOT NULL CHECK (btrim(tool_call_id) <> ''),
    reason_codes   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (application_id, version_id),
    UNIQUE (application_id, tool_call_id),
    FOREIGN KEY (version_id, skill_id) REFERENCES learned_skill_version(id, skill_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_application_one_primary_idx
  ON skill_application_skill(application_id) WHERE role = 'primary';
CREATE INDEX IF NOT EXISTS skill_application_skill_version_idx
  ON skill_application_skill(version_id, application_id);

-- Operational reservation prevents concurrent Curator runs from receiving
-- the same pending application. Reservations survive retryable run failures
-- and are released only when the owning run reaches a terminal state.
CREATE TABLE IF NOT EXISTS curator_application_reservation (
    curator_run_id text NOT NULL REFERENCES curator_run(id),
    application_id text NOT NULL UNIQUE REFERENCES skill_application(id),
    reserved_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (curator_run_id, application_id)
);
CREATE INDEX IF NOT EXISTS curator_application_reservation_run_idx
  ON curator_application_reservation(curator_run_id, reserved_at, application_id);

CREATE TABLE IF NOT EXISTS curator_evaluation (
    id                     text PRIMARY KEY,
    curator_run_id         text REFERENCES curator_run(id),
    application_id         text NOT NULL REFERENCES skill_application(id),
    skill_id               text NOT NULL REFERENCES learned_skill(id),
    version_id             text NOT NULL,
    evidence_snapshot_hash text NOT NULL CHECK (evidence_snapshot_hash ~ '^[0-9a-f]{64}$'),
    outcome                text NOT NULL
                             CHECK (outcome IN ('success','applicability_failure','execution_failure','inconclusive')),
    confidence             double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    reason                 text NOT NULL CHECK (btrim(reason) <> ''),
    evidence_refs          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    supersedes_id          text REFERENCES curator_evaluation(id),
    evaluator_type         text NOT NULL CHECK (evaluator_type IN ('curator','human')),
    evaluator_version      text NOT NULL CHECK (btrim(evaluator_version) <> ''),
    created_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (application_id, evidence_snapshot_hash, evaluator_version),
    FOREIGN KEY (version_id, skill_id) REFERENCES learned_skill_version(id, skill_id),
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
CREATE INDEX IF NOT EXISTS curator_evaluation_application_created_idx
  ON curator_evaluation(application_id, created_at, id);
CREATE INDEX IF NOT EXISTS curator_evaluation_version_created_idx
  ON curator_evaluation(version_id, created_at, id);

CREATE TABLE IF NOT EXISTS curator_remediation_audit (
    id                  text PRIMARY KEY,
    curator_run_id      text NOT NULL REFERENCES curator_run(id),
    evaluation_id       text NOT NULL UNIQUE REFERENCES curator_evaluation(id),
    application_id      text NOT NULL REFERENCES skill_application(id),
    skill_id            text NOT NULL REFERENCES learned_skill(id),
    action              text NOT NULL CHECK (action IN ('no_op','patch','scope_change','state_action')),
    request_payload     jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
    decision            text NOT NULL CHECK (decision IN ('applied','skipped')),
    produced_version_id text REFERENCES learned_skill_version(id),
    skip_reason         text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((decision='applied' AND skip_reason IS NULL) OR (decision='skipped' AND btrim(skip_reason) <> ''))
);
CREATE INDEX IF NOT EXISTS curator_remediation_run_idx
  ON curator_remediation_audit(curator_run_id, created_at, id);

ALTER TABLE learned_skill_version_status
  DROP CONSTRAINT IF EXISTS learned_skill_version_status_last_evaluation_fk;
ALTER TABLE learned_skill_version_status
  ADD CONSTRAINT learned_skill_version_status_last_evaluation_fk
  FOREIGN KEY (last_evaluation_id) REFERENCES curator_evaluation(id);

CREATE OR REPLACE FUNCTION synthia_validate_skill_application_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'skill application rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.observation_key IS DISTINCT FROM NEW.observation_key
     OR OLD.local_goal IS DISTINCT FROM NEW.local_goal
     OR OLD.primary_tool_call_id IS DISTINCT FROM NEW.primary_tool_call_id
     OR OLD.start_event_sequence IS DISTINCT FROM NEW.start_event_sequence
     OR OLD.started_at IS DISTINCT FROM NEW.started_at
     OR OLD.created_by_type IS DISTINCT FROM NEW.created_by_type
     OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'skill application identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.episode_id IS NOT NULL AND OLD.episode_id IS DISTINCT FROM NEW.episode_id THEN
    RAISE EXCEPTION 'skill application episode binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.end_event_sequence IS NOT NULL
     AND (
       OLD.end_event_sequence IS DISTINCT FROM NEW.end_event_sequence
       OR OLD.outcome_claim IS DISTINCT FROM NEW.outcome_claim
       OR OLD.human_corrections IS DISTINCT FROM NEW.human_corrections
       OR OLD.evidence_refs IS DISTINCT FROM NEW.evidence_refs
       OR OLD.tool_run_refs IS DISTINCT FROM NEW.tool_run_refs
       OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
     ) THEN
    RAISE EXCEPTION 'skill application close facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'open' AND NEW.state IN ('closed_pending_episode','pending_evaluation') THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'closed_pending_episode' AND NEW.state = 'pending_evaluation' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'pending_evaluation' AND NEW.state = 'evaluated' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal skill application transition: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS skill_application_mutation_guard ON skill_application;
CREATE TRIGGER skill_application_mutation_guard
  BEFORE UPDATE OR DELETE ON skill_application
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_skill_application_mutation();

DROP TRIGGER IF EXISTS learning_episode_append_only ON learning_episode;
CREATE TRIGGER learning_episode_append_only BEFORE UPDATE OR DELETE ON learning_episode
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS learning_episode_enrichment_append_only ON learning_episode_enrichment;
CREATE TRIGGER learning_episode_enrichment_append_only BEFORE UPDATE OR DELETE ON learning_episode_enrichment
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS learned_skill_version_append_only ON learned_skill_version;
CREATE TRIGGER learned_skill_version_append_only BEFORE UPDATE OR DELETE ON learned_skill_version
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS learned_skill_file_append_only ON learned_skill_file;
CREATE TRIGGER learned_skill_file_append_only BEFORE UPDATE OR DELETE ON learned_skill_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS learned_skill_lifecycle_event_append_only ON learned_skill_lifecycle_event;
CREATE TRIGGER learned_skill_lifecycle_event_append_only BEFORE UPDATE OR DELETE ON learned_skill_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS skill_application_skill_append_only ON skill_application_skill;
CREATE TRIGGER skill_application_skill_append_only BEFORE UPDATE OR DELETE ON skill_application_skill
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS curator_evaluation_append_only ON curator_evaluation;
CREATE TRIGGER curator_evaluation_append_only BEFORE UPDATE OR DELETE ON curator_evaluation
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS curator_remediation_audit_append_only ON curator_remediation_audit;
CREATE TRIGGER curator_remediation_audit_append_only BEFORE UPDATE OR DELETE ON curator_remediation_audit
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

-- schema.sql is a complete fresh-install snapshot through 0013 plus the
-- self-evolution fact layer (0021-0027). Recording the
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
  ('0011_delivery_release'),
  ('0012_project_agents'),
  ('0013_binary_workspace_documents'),
  ('0021_self_evolution'),
  ('0022_evolution_eval'),
  ('0023_evolution_eval_r1_hardening'),
  ('0024_evolution_eval_r2_core'),
  ('0025_evolution_eval_dispatcher'),
  ('0026_evidence_authority_classification'),
  ('0027_evolution_eval_canary_binding')
ON CONFLICT (version) DO NOTHING;
BEGIN;

-- This migration performs no DML that uses the new value. PostgreSQL therefore
-- permits the enum addition and all dependent schema objects in one atomic
-- transaction; Core starts creating evolution-eval ToolRuns after COMMIT.
ALTER TYPE run_class ADD VALUE IF NOT EXISTS 'evolution_eval';

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS evolution_origin_txid bigint NOT NULL DEFAULT txid_current();

CREATE TABLE IF NOT EXISTS evolution_eval_run (
    curator_run_id             text PRIMARY KEY REFERENCES curator_run(id),
    budget_started_at          timestamptz NOT NULL,
    deadline_at                timestamptz NOT NULL,
    max_jobs                   integer NOT NULL DEFAULT 3 CHECK (max_jobs = 3),
    unknown_effect_latched_at  timestamptz,
    unknown_effect_origin_txid bigint,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    completed_at               timestamptz,
    CHECK (deadline_at = budget_started_at + interval '2 hours'),
    CHECK (created_at >= budget_started_at),
    CHECK (unknown_effect_latched_at IS NULL OR unknown_effect_latched_at >= budget_started_at),
    CHECK ((unknown_effect_latched_at IS NULL)=(unknown_effect_origin_txid IS NULL)),
    CHECK (completed_at IS NULL OR completed_at >= budget_started_at)
);

-- Core-issued immutable input binding.  The opaque ref is an identifier, not a
-- bearer credential; every API call still revalidates the current Curator lease
-- and source-project ACL before resolving it.
CREATE TABLE IF NOT EXISTS evolution_eval_input (
    eval_input_ref          text PRIMARY KEY CHECK (
                              octet_length(eval_input_ref) BETWEEN 1 AND 128
                              AND eval_input_ref !~ '[[:cntrl:]]'
                            ),
    curator_run_id          text NOT NULL,
    application_id          text NOT NULL,
    project_id              text NOT NULL REFERENCES project(id),
    version_id              text NOT NULL REFERENCES learned_skill_version(id),
    evidence_snapshot_hash  text NOT NULL CHECK (evidence_snapshot_hash ~ '^[0-9a-f]{64}$'),
    input_manifest_hash     text NOT NULL CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
    source_commit           text NOT NULL CHECK (
                              source_commit ~ '^[0-9a-f]{40}$'
                              OR source_commit ~ '^[0-9a-f]{64}$'
                            ),
    source_manifest_hash    text NOT NULL CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
    allowed_operations      text[] NOT NULL CHECK (
                              cardinality(allowed_operations) BETWEEN 1 AND 4
                              AND allowed_operations <@ ARRAY[
                                'validate_sources','simulate','synthesize','implement'
                              ]::text[]
                              AND array_position(allowed_operations, NULL) IS NULL
                            ),
    trial_bitstream_allowed boolean NOT NULL DEFAULT false,
    part                    text CHECK (
                              part IS NULL OR part ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                            ),
    toolchain_profile_hash  text NOT NULL CHECK (toolchain_profile_hash ~ '^[0-9a-f]{64}$'),
    input_manifest          jsonb NOT NULL CHECK (
                              jsonb_typeof(input_manifest) = 'object'
                              AND input_manifest->>'schema' = 'evolution-eval-input-manifest.v1'
                            ),
    created_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (curator_run_id, application_id),
    UNIQUE (eval_input_ref,version_id),
    UNIQUE (
      eval_input_ref,curator_run_id,application_id,version_id,
      evidence_snapshot_hash,input_manifest_hash
    ),
    FOREIGN KEY (curator_run_id) REFERENCES evolution_eval_run(curator_run_id),
    FOREIGN KEY (curator_run_id,application_id)
      REFERENCES curator_application_reservation(curator_run_id,application_id),
    FOREIGN KEY (application_id,version_id)
      REFERENCES skill_application_skill(application_id,version_id)
);

CREATE TABLE IF NOT EXISTS evolution_eval_input_file (
    eval_input_ref  text NOT NULL REFERENCES evolution_eval_input(eval_input_ref),
    path            text NOT NULL CHECK (
                      octet_length(path) <= 512
                      AND path ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
                    ),
    sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes      bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 4194304),
    media_type      text NOT NULL CHECK (
                      media_type IN ('text/x-verilog','text/x-systemverilog','application/x-xdc')
                    ),
    managed_content bytea NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (eval_input_ref,path),
    CHECK (octet_length(managed_content) = size_bytes),
    CHECK (encode(digest(managed_content,'sha256'),'hex') = sha256),
    CHECK (
      ((translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.(v|vh)$'
       AND media_type = 'text/x-verilog')
      OR ((translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.(sv|svh)$'
          AND media_type = 'text/x-systemverilog')
      OR ((translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.xdc$'
          AND media_type = 'application/x-xdc')
    )
);

CREATE TABLE IF NOT EXISTS evolution_eval_input_skill_file (
    eval_input_ref       text NOT NULL,
    version_id           text NOT NULL,
    learned_skill_file_id text NOT NULL REFERENCES learned_skill_file(id),
    path                 text NOT NULL CHECK (
                           octet_length(path) <= 512
                           AND path ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
                         ),
    kind                 text NOT NULL CHECK (kind IN ('skill_md','reference','template','script')),
    language             text CHECK (language IS NULL OR language IN ('tcl','python','typescript')),
    sha256               text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes           bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144),
    media_type           text NOT NULL CHECK (btrim(media_type) <> ''),
    content              text NOT NULL CHECK (content <> ''),
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (eval_input_ref,path),
    UNIQUE (eval_input_ref,learned_skill_file_id),
    FOREIGN KEY (eval_input_ref,version_id)
      REFERENCES evolution_eval_input(eval_input_ref,version_id),
    CHECK ((kind='script')=(language IS NOT NULL)),
    CHECK (octet_length(convert_to(content,'UTF8'))=size_bytes),
    CHECK (encode(digest(convert_to(content,'UTF8'),'sha256'),'hex')=sha256)
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_input_skill_file_portable_key_idx
  ON evolution_eval_input_skill_file(eval_input_ref,
    (translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C"));

CREATE TABLE IF NOT EXISTS evolution_eval_job (
    id                         text PRIMARY KEY,
    curator_run_id             text NOT NULL REFERENCES evolution_eval_run(curator_run_id),
    application_id             text NOT NULL,
    project_id                 text NOT NULL REFERENCES project(id),
    version_id                 text NOT NULL,
    eval_input_ref             text NOT NULL,
    input_manifest_hash        text NOT NULL CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
    evidence_snapshot_hash     text NOT NULL CHECK (evidence_snapshot_hash ~ '^[0-9a-f]{64}$'),
    tool_run_id                text NOT NULL,
    workspace_id               text NOT NULL UNIQUE,
    connector_job_id           text NOT NULL UNIQUE CHECK (
                                 octet_length(connector_job_id) BETWEEN 1 AND 128
                                 AND connector_job_id !~ '[[:cntrl:]]'
                               ),
    connector_idempotency_key  text NOT NULL CHECK (connector_idempotency_key ~ '^[0-9a-f]{64}$'),
    request_key                text NOT NULL CHECK (
                                 octet_length(request_key) BETWEEN 1 AND 128
                                 AND request_key !~ '[[:cntrl:]]'
                               ),
    prepare_request_hash       text NOT NULL CHECK (prepare_request_hash ~ '^[0-9a-f]{64}$'),
    ordinal                    integer NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
    operation                  text NOT NULL CHECK (
                                 operation IN ('validate_sources','simulate','synthesize','implement')
                               ),
    parameters                 jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
    requested_timeout_ms       integer NOT NULL CHECK (requested_timeout_ms BETWEEN 1 AND 7200000),
    effective_timeout_ms       integer NOT NULL CHECK (
                                 effective_timeout_ms BETWEEN 1 AND requested_timeout_ms
                               ),
    deadline_at                timestamptz NOT NULL,
    reconciliation_state       text NOT NULL DEFAULT 'not_needed' CHECK (
                                 reconciliation_state IN ('not_needed','confirmed','required')
                               ),
    evolution_origin_txid      bigint NOT NULL DEFAULT txid_current(),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (curator_run_id,request_key),
    UNIQUE (curator_run_id,ordinal),
    UNIQUE (tool_run_id),
    UNIQUE (id,curator_run_id),
    UNIQUE (id,application_id),
    UNIQUE (id,workspace_id),
    UNIQUE (id,deadline_at),
    FOREIGN KEY (tool_run_id,project_id) REFERENCES tool_run(id,project_id),
    FOREIGN KEY (curator_run_id,application_id)
      REFERENCES curator_application_reservation(curator_run_id,application_id),
    FOREIGN KEY (application_id,version_id)
      REFERENCES skill_application_skill(application_id,version_id),
    FOREIGN KEY (
      eval_input_ref,curator_run_id,application_id,version_id,
      evidence_snapshot_hash,input_manifest_hash
    ) REFERENCES evolution_eval_input(
      eval_input_ref,curator_run_id,application_id,version_id,
      evidence_snapshot_hash,input_manifest_hash
    )
);
CREATE INDEX IF NOT EXISTS evolution_eval_job_run_created_idx
  ON evolution_eval_job(curator_run_id,ordinal);
CREATE INDEX IF NOT EXISTS evolution_eval_job_application_idx
  ON evolution_eval_job(application_id,created_at,id);

CREATE TABLE IF NOT EXISTS evolution_eval_workspace (
    id                    text PRIMARY KEY,
    eval_job_id           text NOT NULL UNIQUE REFERENCES evolution_eval_job(id)
                            DEFERRABLE INITIALLY DEFERRED,
    eval_input_ref        text NOT NULL REFERENCES evolution_eval_input(eval_input_ref),
    source_commit         text NOT NULL CHECK (
                            source_commit ~ '^[0-9a-f]{40}$'
                            OR source_commit ~ '^[0-9a-f]{64}$'
                          ),
    input_manifest_hash   text NOT NULL CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
    source_manifest_hash  text NOT NULL CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id,eval_job_id)
);

ALTER TABLE evolution_eval_job
  DROP CONSTRAINT IF EXISTS evolution_eval_job_workspace_fk;
ALTER TABLE evolution_eval_job
  ADD CONSTRAINT evolution_eval_job_workspace_fk
  FOREIGN KEY (workspace_id,id) REFERENCES evolution_eval_workspace(id,eval_job_id)
  DEFERRABLE INITIALLY DEFERRED;

-- A revision is the immutable canonical manifest; file rows contain the Core
-- content-addressed bytes used by read and by the future Connector dispatcher.
CREATE TABLE IF NOT EXISTS evolution_eval_workspace_revision (
    workspace_id   text NOT NULL REFERENCES evolution_eval_workspace(id),
    revision       integer NOT NULL CHECK (revision > 0),
    manifest       jsonb NOT NULL CHECK (
                     jsonb_typeof(manifest) = 'object'
                     AND manifest->>'schema' = 'evolution-eval-workspace-manifest.v1'
                   ),
    manifest_hash  text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    file_count     integer NOT NULL CHECK (file_count BETWEEN 0 AND 5120),
    total_bytes    bigint NOT NULL CHECK (total_bytes BETWEEN 0 AND 603979776),
    source_files   integer NOT NULL CHECK (source_files BETWEEN 0 AND 4096),
    source_bytes   bigint NOT NULL CHECK (source_bytes BETWEEN 0 AND 536870912),
    skill_files    integer NOT NULL CHECK (skill_files BETWEEN 0 AND 512),
    skill_bytes    bigint NOT NULL CHECK (skill_bytes BETWEEN 0 AND 33554432),
    overlay_files  integer NOT NULL CHECK (overlay_files BETWEEN 0 AND 512),
    overlay_bytes  bigint NOT NULL CHECK (overlay_bytes BETWEEN 0 AND 33554432),
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id,revision),
    UNIQUE (workspace_id,manifest_hash),
    UNIQUE (workspace_id,revision,manifest_hash),
    CHECK (file_count = source_files + skill_files + overlay_files),
    CHECK (total_bytes = source_bytes + skill_bytes + overlay_bytes)
);

CREATE TABLE IF NOT EXISTS evolution_eval_workspace_file (
    workspace_id    text NOT NULL,
    revision        integer NOT NULL,
    path            text NOT NULL CHECK (
                      octet_length(path) <= 512
                      AND path ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
                    ),
    sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
    media_type      text NOT NULL CHECK (btrim(media_type) <> ''),
    layer           text NOT NULL CHECK (layer IN ('source','skill','overlay')),
    read_only       boolean NOT NULL,
    managed_content bytea NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id,revision,path),
    FOREIGN KEY (workspace_id,revision)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (octet_length(managed_content) = size_bytes),
    CHECK (encode(digest(managed_content,'sha256'),'hex') = sha256),
    CHECK ((layer = 'overlay' AND read_only = false) OR (layer <> 'overlay' AND read_only = true)),
    CHECK (
      (layer = 'source' AND size_bytes <= 4194304)
      OR (layer IN ('skill','overlay') AND size_bytes <= 1048576)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_input_file_portable_key_idx
  ON evolution_eval_input_file(eval_input_ref,
    (translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C"));
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_workspace_file_portable_key_idx
  ON evolution_eval_workspace_file(workspace_id,revision,
    (translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C"));

CREATE TABLE IF NOT EXISTS evolution_eval_workspace_projection (
    workspace_id      text PRIMARY KEY REFERENCES evolution_eval_workspace(id),
    current_revision  integer NOT NULL CHECK (current_revision > 0),
    sealed_at         timestamptz,
    discarded_at      timestamptz,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id,current_revision)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (discarded_at IS NULL OR sealed_at IS NOT NULL),
    CHECK (sealed_at IS NULL OR discarded_at IS NULL OR discarded_at >= sealed_at)
);

CREATE TABLE IF NOT EXISTS evolution_eval_dispatch (
    eval_job_id              text PRIMARY KEY REFERENCES evolution_eval_job(id),
    workspace_id             text NOT NULL,
    workspace_revision       integer NOT NULL CHECK (workspace_revision > 0),
    workspace_manifest_hash  text NOT NULL CHECK (workspace_manifest_hash ~ '^[0-9a-f]{64}$'),
    dispatch_request_hash    text NOT NULL CHECK (dispatch_request_hash ~ '^[0-9a-f]{64}$'),
    requested_timeout_ms     integer NOT NULL CHECK (requested_timeout_ms BETWEEN 1 AND 7200000),
    operation_cap_ms         integer NOT NULL DEFAULT 7200000 CHECK (operation_cap_ms = 7200000),
    deadline_at              timestamptz NOT NULL,
    audit_event_id           text NOT NULL UNIQUE,
    outbox_event_id          uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                              DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid    bigint NOT NULL DEFAULT txid_current(),
    created_at               timestamptz NOT NULL DEFAULT now(),
    sealed_input_projection_hash text NOT NULL CHECK (sealed_input_projection_hash ~ '^[0-9a-f]{64}$'),
    FOREIGN KEY (eval_job_id,workspace_id)
      REFERENCES evolution_eval_job(id,workspace_id),
    FOREIGN KEY (workspace_id,workspace_revision)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision),
    FOREIGN KEY (workspace_id,workspace_revision,workspace_manifest_hash)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision,manifest_hash),
    FOREIGN KEY (eval_job_id,deadline_at)
      REFERENCES evolution_eval_job(id,deadline_at),
    UNIQUE (eval_job_id,dispatch_request_hash)
);

CREATE TABLE IF NOT EXISTS evolution_eval_dispatch_tombstone (
    eval_job_id   text PRIMARY KEY REFERENCES evolution_eval_job(id),
    reason_code   text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
    error_hash    text NOT NULL CHECK (error_hash ~ '^[0-9a-f]{64}$'),
    audit_event_id text NOT NULL UNIQUE,
    outbox_event_id uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                      DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evolution_eval_evidence_fact (
    id             text PRIMARY KEY,
    eval_job_id    text NOT NULL REFERENCES evolution_eval_job(id),
    fact_type      text NOT NULL CHECK (fact_type IN (
                       'freeze_pending','frozen','corrupt','unavailable_at_deadline',
                       'ack_pending','acknowledged','quarantine_pending','expired',
                       'cleanup_pending','cleaned'
                     )),
    manifest_hash  text CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[0-9a-f]{64}$'),
    error_code     text CHECK (
                       error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'
                     ),
    fact_hash      text NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
    manifest       jsonb CHECK (
                     manifest IS NULL OR (
                       jsonb_typeof(manifest)='object'
                       AND manifest->>'schema'='evolution-eval-evidence-manifest.v1'
                     )
                   ),
    entry_count    integer NOT NULL DEFAULT 0 CHECK (entry_count BETWEEN 0 AND 128),
    total_bytes    bigint NOT NULL DEFAULT 0 CHECK (total_bytes BETWEEN 0 AND 268435456),
    audit_event_id text NOT NULL UNIQUE,
    outbox_event_id uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                      DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (eval_job_id,fact_type),
    UNIQUE (id,eval_job_id),
    UNIQUE (id,eval_job_id,fact_type),
    CHECK ((fact_type IN ('frozen','ack_pending','acknowledged','expired')) = (manifest_hash IS NOT NULL)),
    CHECK ((fact_type='frozen') = (manifest IS NOT NULL)),
    CHECK ((fact_type IN ('corrupt','unavailable_at_deadline')) = (error_code IS NOT NULL)),
    CHECK (
      (fact_type='frozen')
      OR (entry_count=0 AND total_bytes=0)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_evidence_frozen_manifest_idx
  ON evolution_eval_evidence_fact(eval_job_id,manifest_hash)
  WHERE fact_type='frozen';
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_evidence_one_conclusion_idx
  ON evolution_eval_evidence_fact(eval_job_id)
  WHERE fact_type IN ('frozen','corrupt','unavailable_at_deadline');

CREATE TABLE IF NOT EXISTS evolution_eval_evidence_entry (
    id                       text PRIMARY KEY,
    evidence_fact_id         text NOT NULL,
    eval_job_id              text NOT NULL REFERENCES evolution_eval_job(id),
    fact_type                text NOT NULL DEFAULT 'frozen' CHECK (fact_type='frozen'),
    name                     text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'),
    sha256                   text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes               bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 67108864),
    media_type               text NOT NULL CHECK (
                               media_type IN ('application/json','text/plain','application/octet-stream')
                             ),
    artifact_classification  text NOT NULL CHECK (
                               artifact_classification IN (
                                 'experimental/evolution_eval','evolution_eval_evidence'
                               )
                             ),
    usage_classification     text NOT NULL DEFAULT 'evolution_eval_only'
                               CHECK (usage_classification = 'evolution_eval_only'),
    managed_content          bytea NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (evidence_fact_id,name),
    UNIQUE (eval_job_id,name),
    FOREIGN KEY (evidence_fact_id,eval_job_id,fact_type)
      REFERENCES evolution_eval_evidence_fact(id,eval_job_id,fact_type)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (octet_length(managed_content) = size_bytes),
    CHECK (encode(digest(managed_content,'sha256'),'hex') = sha256),
    CHECK (
      (lower(name) ~ '\.json$' AND media_type = 'application/json')
      OR (lower(name) ~ '\.(rpt|log|tcl)$' AND media_type = 'text/plain')
      OR (lower(name) ~ '\.(bit|dcp)$' AND media_type = 'application/octet-stream')
      OR lower(name) !~ '\.(json|rpt|log|tcl|bit|dcp)$'
    ),
    CHECK (
      (lower(name) ~ '\.bit$' AND artifact_classification = 'experimental/evolution_eval')
      OR (lower(name) !~ '\.bit$' AND artifact_classification = 'evolution_eval_evidence')
    )
);

CREATE TABLE IF NOT EXISTS evolution_eval_idempotency (
    id                text PRIMARY KEY,
    scope             text NOT NULL CHECK (scope = 'core:evolution-eval'),
    curator_run_id    text NOT NULL REFERENCES curator_run(id),
    eval_job_id       text,
    action            text NOT NULL CHECK (btrim(action) <> ''),
    idempotency_key   text NOT NULL CHECK (
                        octet_length(idempotency_key) BETWEEN 1 AND 128
                        AND idempotency_key !~ '[[:cntrl:]]'
                      ),
    request_hash      text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_status   integer CHECK (response_status BETWEEN 200 AND 299),
    response          jsonb CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
    created_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz,
    FOREIGN KEY (eval_job_id,curator_run_id)
      REFERENCES evolution_eval_job(id,curator_run_id),
    CHECK ((response_status IS NULL) = (response IS NULL)),
    CHECK ((completed_at IS NULL) = (response IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_idempotency_scope_idx
  ON evolution_eval_idempotency(
    scope,curator_run_id,COALESCE(eval_job_id,''),action,idempotency_key
  );

CREATE TABLE IF NOT EXISTS evolution_eval_audit_event (
    id                       text PRIMARY KEY,
    curator_run_id           text NOT NULL REFERENCES curator_run(id),
    eval_job_id              text,
    project_id               text REFERENCES project(id),
    event_type               text NOT NULL CHECK (btrim(event_type) <> ''),
    actor_type               actor_type NOT NULL,
    actor_id                 text NOT NULL CHECK (btrim(actor_id) <> ''),
    correlation_id           text NOT NULL CHECK (btrim(correlation_id) <> ''),
    request_hash             text CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
    from_state               tool_run_state,
    to_state                 tool_run_state,
    operation                text CHECK (
                               operation IS NULL OR operation IN (
                                 'validate_sources','simulate','synthesize','implement'
                               )
                             ),
    workspace_manifest_hash  text CHECK (
                               workspace_manifest_hash IS NULL
                               OR workspace_manifest_hash ~ '^[0-9a-f]{64}$'
                             ),
    evidence_manifest_hash   text CHECK (
                               evidence_manifest_hash IS NULL
                               OR evidence_manifest_hash ~ '^[0-9a-f]{64}$'
                             ),
    file_count               integer CHECK (file_count IS NULL OR file_count BETWEEN 0 AND 5120),
    byte_count               bigint CHECK (byte_count IS NULL OR byte_count BETWEEN 0 AND 603979776),
    error_code               text CHECK (
                               error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'
                             ),
    evolution_origin_txid    bigint NOT NULL DEFAULT txid_current(),
    created_at               timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (eval_job_id,curator_run_id)
      REFERENCES evolution_eval_job(id,curator_run_id),
    CHECK ((from_state IS NULL) = (to_state IS NULL))
);
CREATE INDEX IF NOT EXISTS evolution_eval_audit_run_created_idx
  ON evolution_eval_audit_event(curator_run_id,created_at,id);

CREATE TABLE IF NOT EXISTS evolution_eval_transition_fact (
    id                   text PRIMARY KEY,
    eval_job_id          text NOT NULL REFERENCES evolution_eval_job(id),
    transition_sequence  integer NOT NULL CHECK (transition_sequence BETWEEN 1 AND 6),
    from_state           tool_run_state NOT NULL,
    to_state             tool_run_state NOT NULL,
    audit_event_id       text NOT NULL UNIQUE REFERENCES evolution_eval_audit_event(id)
                           DEFERRABLE INITIALLY DEFERRED,
    outbox_event_id      uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                           DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (eval_job_id,transition_sequence),
    UNIQUE (eval_job_id,from_state,to_state),
    UNIQUE (id,eval_job_id),
    CHECK (
      (from_state='submitted' AND to_state IN ('rejected','queued'))
      OR (from_state='queued' AND to_state='preparing')
      OR (from_state='preparing' AND to_state IN ('running','failed','cancelled'))
      OR (from_state='running' AND to_state IN (
        'succeeded','failed','cancelling','timeout','unknown_effect'
      ))
      OR (from_state='cancelling' AND to_state='cancelled')
    )
);

CREATE TABLE IF NOT EXISTS evolution_eval_unknown_fact (
    eval_job_id        text PRIMARY KEY REFERENCES evolution_eval_job(id),
    transition_fact_id text NOT NULL UNIQUE,
    audit_event_id     text NOT NULL UNIQUE REFERENCES evolution_eval_audit_event(id)
                         DEFERRABLE INITIALLY DEFERRED,
    outbox_event_id    uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                         DEFERRABLE INITIALLY DEFERRED,
    fact_hash          text NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
    latched_at         timestamptz NOT NULL,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    FOREIGN KEY (transition_fact_id,eval_job_id)
      REFERENCES evolution_eval_transition_fact(id,eval_job_id)
      DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS evolution_eval_operation_fact (
    id                       text PRIMARY KEY,
    eval_job_id              text NOT NULL REFERENCES evolution_eval_job(id),
    fact_type                text NOT NULL CHECK (fact_type IN (
                               'prepare','workspace_revision',
                               'workspace_projection','workspace_seal'
                             )),
    workspace_id             text,
    workspace_revision       integer CHECK (workspace_revision IS NULL OR workspace_revision > 0),
    workspace_manifest_hash  text CHECK (
                               workspace_manifest_hash IS NULL
                               OR workspace_manifest_hash ~ '^[0-9a-f]{64}$'
                             ),
    audit_event_id           text NOT NULL UNIQUE REFERENCES evolution_eval_audit_event(id)
                               DEFERRABLE INITIALLY DEFERRED,
    outbox_event_id          uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                               DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid    bigint NOT NULL DEFAULT txid_current(),
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id,eval_job_id),
    CHECK (
      (fact_type='prepare' AND workspace_id IS NULL AND workspace_revision IS NULL
       AND workspace_manifest_hash IS NULL)
      OR
      (fact_type<>'prepare' AND workspace_id IS NOT NULL AND workspace_revision IS NOT NULL
       AND workspace_manifest_hash IS NOT NULL)
    ),
    FOREIGN KEY (eval_job_id,workspace_id)
      REFERENCES evolution_eval_job(id,workspace_id)
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (workspace_id,workspace_revision,workspace_manifest_hash)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision,manifest_hash)
      DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_operation_prepare_idx
  ON evolution_eval_operation_fact(eval_job_id) WHERE fact_type='prepare';
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_operation_workspace_idx
  ON evolution_eval_operation_fact(workspace_id,fact_type,workspace_revision)
  WHERE fact_type IN ('workspace_revision','workspace_projection','workspace_seal');
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_operation_seal_idx
  ON evolution_eval_operation_fact(workspace_id) WHERE fact_type='workspace_seal';

ALTER TABLE evolution_eval_dispatch
  ADD CONSTRAINT evolution_eval_dispatch_audit_fk
  FOREIGN KEY (audit_event_id) REFERENCES evolution_eval_audit_event(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE evolution_eval_dispatch_tombstone
  ADD CONSTRAINT evolution_eval_tombstone_audit_fk
  FOREIGN KEY (audit_event_id) REFERENCES evolution_eval_audit_event(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE evolution_eval_evidence_fact
  ADD CONSTRAINT evolution_eval_evidence_audit_fk
  FOREIGN KEY (audit_event_id) REFERENCES evolution_eval_audit_event(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION synthia_stamp_evolution_eval_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.evolution_origin_txid=txid_current();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_outbox_origin_stamp ON outbox_events;
CREATE TRIGGER evolution_eval_outbox_origin_stamp BEFORE INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_dispatch_origin_stamp ON evolution_eval_dispatch;
CREATE TRIGGER evolution_eval_dispatch_origin_stamp BEFORE INSERT ON evolution_eval_dispatch
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_tombstone_origin_stamp ON evolution_eval_dispatch_tombstone;
CREATE TRIGGER evolution_eval_tombstone_origin_stamp BEFORE INSERT ON evolution_eval_dispatch_tombstone
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_evidence_origin_stamp ON evolution_eval_evidence_fact;
CREATE TRIGGER evolution_eval_evidence_origin_stamp BEFORE INSERT ON evolution_eval_evidence_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_audit_origin_stamp ON evolution_eval_audit_event;
CREATE TRIGGER evolution_eval_audit_origin_stamp BEFORE INSERT ON evolution_eval_audit_event
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_transition_origin_stamp ON evolution_eval_transition_fact;
CREATE TRIGGER evolution_eval_transition_origin_stamp BEFORE INSERT ON evolution_eval_transition_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_unknown_origin_stamp ON evolution_eval_unknown_fact;
CREATE TRIGGER evolution_eval_unknown_origin_stamp BEFORE INSERT ON evolution_eval_unknown_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_operation_origin_stamp ON evolution_eval_operation_fact;
CREATE TRIGGER evolution_eval_operation_origin_stamp BEFORE INSERT ON evolution_eval_operation_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_job_origin_stamp ON evolution_eval_job;
CREATE TRIGGER evolution_eval_job_origin_stamp BEFORE INSERT ON evolution_eval_job
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_workspace_projection_origin_stamp ON evolution_eval_workspace_projection;
CREATE TRIGGER evolution_eval_workspace_projection_origin_stamp
  BEFORE INSERT ON evolution_eval_workspace_projection
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_insert_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  locked_run evolution_eval_run%ROWTYPE;
  existing_jobs integer;
  prior_tool_run_id text;
  prior_state text;
BEGIN
  SELECT r.* INTO locked_run FROM evolution_eval_run r
   WHERE r.curator_run_id=NEW.curator_run_id FOR UPDATE;
  IF NOT FOUND OR locked_run.unknown_effect_latched_at IS NOT NULL THEN
    RAISE EXCEPTION 'evolution eval unknown-effect latch forbids new jobs'
      USING ERRCODE='23514';
  END IF;
  SELECT count(*)::integer INTO existing_jobs FROM evolution_eval_job j
   WHERE j.curator_run_id=NEW.curator_run_id;
  IF existing_jobs>=locked_run.max_jobs OR NEW.ordinal<>existing_jobs+1 THEN
    RAISE EXCEPTION 'evolution eval job ordinal must be the next authoritative run ordinal'
      USING ERRCODE='23514';
  END IF;
  IF NEW.ordinal>1 THEN
    SELECT j.tool_run_id INTO prior_tool_run_id FROM evolution_eval_job j
     WHERE j.curator_run_id=NEW.curator_run_id AND j.ordinal=NEW.ordinal-1
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'evolution eval prior ordinal job is missing'
        USING ERRCODE='23514';
    END IF;
    SELECT r.state::text INTO prior_state FROM tool_run r
     WHERE r.id=prior_tool_run_id FOR UPDATE;
    IF prior_state NOT IN ('rejected','succeeded','failed','cancelled','timeout') THEN
      RAISE EXCEPTION 'evolution eval prior ordinal must be terminal before the next job'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_job_insert_fence_guard ON evolution_eval_job;
CREATE TRIGGER evolution_eval_job_insert_fence_guard BEFORE INSERT ON evolution_eval_job
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_job_insert_fence();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_dispatch_insert_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_curator_run_id text;
  bound_tool_run_id text;
  bound_state text;
BEGIN
  SELECT j.curator_run_id INTO bound_curator_run_id
    FROM evolution_eval_job j WHERE j.id=NEW.eval_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval dispatch requires its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM evolution_eval_run r
   WHERE r.curator_run_id=bound_curator_run_id
     AND r.unknown_effect_latched_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval unknown-effect latch forbids dispatch'
      USING ERRCODE='23514';
  END IF;
  SELECT j.tool_run_id INTO bound_tool_run_id
    FROM evolution_eval_job j
   WHERE j.id=NEW.eval_job_id AND j.curator_run_id=bound_curator_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval dispatch lost its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  SELECT r.state::text INTO bound_state
    FROM tool_run r WHERE r.id=bound_tool_run_id FOR UPDATE;
  IF bound_state IS DISTINCT FROM 'submitted'
     OR EXISTS (
       SELECT 1 FROM evolution_eval_dispatch_tombstone t
        WHERE t.eval_job_id=NEW.eval_job_id
     ) THEN
    RAISE EXCEPTION 'evolution eval dispatch requires submitted state without tombstone'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_dispatch_insert_fence_guard ON evolution_eval_dispatch;
CREATE TRIGGER evolution_eval_dispatch_insert_fence_guard
  BEFORE INSERT ON evolution_eval_dispatch
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_dispatch_insert_fence();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_transition_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_curator_run_id text;
  bound_tool_run_id text;
  bound_state text;
BEGIN
  IF NEW.from_state::text<>'submitted'
     OR NEW.to_state::text NOT IN ('queued','rejected') THEN
    RETURN NEW;
  END IF;
  SELECT j.curator_run_id INTO bound_curator_run_id
    FROM evolution_eval_job j WHERE j.id=NEW.eval_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval transition fence requires its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  IF NEW.to_state::text='queued' THEN
    PERFORM 1 FROM evolution_eval_run r
     WHERE r.curator_run_id=bound_curator_run_id
       AND r.unknown_effect_latched_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'evolution eval unknown-effect latch forbids the effect fence'
        USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT j.tool_run_id INTO bound_tool_run_id
    FROM evolution_eval_job j
   WHERE j.id=NEW.eval_job_id AND j.curator_run_id=bound_curator_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval transition fence lost its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  SELECT r.state::text INTO bound_state
    FROM tool_run r WHERE r.id=bound_tool_run_id FOR UPDATE;
  IF bound_state IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'evolution eval transition fence lost submitted-state CAS'
      USING ERRCODE='23514';
  END IF;
  IF NEW.to_state::text='queued' AND (
    NOT EXISTS (
      SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=NEW.eval_job_id
    ) OR EXISTS (
      SELECT 1 FROM evolution_eval_dispatch_tombstone t
       WHERE t.eval_job_id=NEW.eval_job_id
    )
  ) THEN
    RAISE EXCEPTION 'evolution eval effect fence requires dispatch without tombstone'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_transition_fence_guard ON evolution_eval_transition_fact;
CREATE TRIGGER evolution_eval_transition_fence_guard
  BEFORE INSERT ON evolution_eval_transition_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_transition_fence();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_input(binding_ref text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  binding evolution_eval_input%ROWTYPE;
  actual_files jsonb;
  actual_skill_files jsonb;
  actual_file_count integer;
  actual_total_bytes bigint;
  actual_skill_file_count integer;
  actual_skill_total_bytes bigint;
  manifest_keys text[];
BEGIN
  SELECT i.* INTO binding FROM evolution_eval_input i WHERE i.eval_input_ref=binding_ref;
  IF NOT FOUND THEN RETURN; END IF;
  IF cardinality(binding.allowed_operations) IS DISTINCT FROM (
    SELECT count(DISTINCT operation)::integer FROM unnest(binding.allowed_operations) operation
  ) THEN
    RAISE EXCEPTION 'evolution eval allowed operations must be unique' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM skill_application a
    JOIN skill_application_skill primary_skill
      ON primary_skill.application_id=a.id
     AND primary_skill.version_id=binding.version_id
     AND primary_skill.role='primary'
    WHERE a.id=binding.application_id AND a.project_id=binding.project_id
  ) THEN
    RAISE EXCEPTION 'evolution eval input must bind the application primary version'
      USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'path',f.path,'sha256',f.sha256,'size_bytes',f.size_bytes,
           'media_type',f.media_type
         ) ORDER BY translate(f.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",
                    f.path COLLATE "C"),'[]'::jsonb),
         count(*)::integer,COALESCE(sum(f.size_bytes),0)::bigint
    INTO actual_files,actual_file_count,actual_total_bytes
    FROM evolution_eval_input_file f WHERE f.eval_input_ref=binding_ref;
  IF actual_file_count > 4096 OR actual_total_bytes > 536870912 THEN
    RAISE EXCEPTION 'evolution eval source input budget exceeded' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_input_skill_file input_skill
    LEFT JOIN learned_skill_file learned ON learned.id=input_skill.learned_skill_file_id
     WHERE input_skill.eval_input_ref=binding_ref
       AND (
         learned.id IS NULL OR learned.version_id<>binding.version_id
         OR input_skill.version_id<>binding.version_id
         OR learned.path<>input_skill.path OR learned.kind<>input_skill.kind
         OR learned.language IS DISTINCT FROM input_skill.language
         OR learned.sha256<>input_skill.sha256 OR learned.size_bytes<>input_skill.size_bytes
         OR learned.media_type<>input_skill.media_type OR learned.content<>input_skill.content
       )
  ) OR EXISTS (
    SELECT 1 FROM learned_skill_file learned
     WHERE learned.version_id=binding.version_id
       AND NOT EXISTS (
         SELECT 1 FROM evolution_eval_input_skill_file input_skill
          WHERE input_skill.eval_input_ref=binding_ref
            AND input_skill.learned_skill_file_id=learned.id
       )
  ) THEN
    RAISE EXCEPTION 'evolution eval skill input must exactly bind the fixed SkillVersion files'
      USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'path',f.path,'kind',f.kind,'language',f.language,'sha256',f.sha256,
           'size_bytes',f.size_bytes,'media_type',f.media_type
         ) ORDER BY translate(f.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",
                    f.path COLLATE "C"),'[]'::jsonb),
         count(*)::integer,COALESCE(sum(f.size_bytes),0)::bigint
    INTO actual_skill_files,actual_skill_file_count,actual_skill_total_bytes
    FROM evolution_eval_input_skill_file f WHERE f.eval_input_ref=binding_ref;
  IF actual_skill_file_count>512 OR actual_skill_total_bytes>33554432 THEN
    RAISE EXCEPTION 'evolution eval skill input budget exceeded' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO manifest_keys
    FROM jsonb_object_keys(binding.input_manifest) key;
  IF manifest_keys IS DISTINCT FROM ARRAY[
    'allowed_operations','application_id','curator_run_id','eval_input_ref',
    'evidence_snapshot_hash','files','part','project_id','schema','skill_files','source_commit',
    'source_manifest_hash','toolchain_profile_hash','trial_bitstream_allowed','version_id'
  ]::text[]
     OR binding.input_manifest->>'schema' <> 'evolution-eval-input-manifest.v1'
     OR binding.input_manifest->>'eval_input_ref' <> binding.eval_input_ref
     OR binding.input_manifest->>'curator_run_id' <> binding.curator_run_id
     OR binding.input_manifest->>'application_id' <> binding.application_id
     OR binding.input_manifest->>'project_id' <> binding.project_id
     OR binding.input_manifest->>'version_id' <> binding.version_id
     OR binding.input_manifest->>'evidence_snapshot_hash' <> binding.evidence_snapshot_hash
     OR binding.input_manifest->>'source_commit' <> binding.source_commit
     OR binding.input_manifest->>'source_manifest_hash' <> binding.source_manifest_hash
     OR binding.input_manifest->>'toolchain_profile_hash' <> binding.toolchain_profile_hash
     OR binding.input_manifest->'allowed_operations' IS DISTINCT FROM to_jsonb(binding.allowed_operations)
     OR binding.input_manifest->'trial_bitstream_allowed' IS DISTINCT FROM to_jsonb(binding.trial_bitstream_allowed)
     OR binding.input_manifest->'part' IS DISTINCT FROM to_jsonb(binding.part)
     OR binding.input_manifest->'files' IS DISTINCT FROM actual_files
     OR binding.input_manifest->'skill_files' IS DISTINCT FROM actual_skill_files THEN
    RAISE EXCEPTION 'evolution eval input manifest does not match immutable binding/files'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_input_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_input(COALESCE(NEW.eval_input_ref,OLD.eval_input_ref));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_input_commit_guard ON evolution_eval_input;
CREATE CONSTRAINT TRIGGER evolution_eval_input_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_input
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_input_commit();
DROP TRIGGER IF EXISTS evolution_eval_input_file_commit_guard ON evolution_eval_input_file;
CREATE CONSTRAINT TRIGGER evolution_eval_input_file_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_input_file
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_input_commit();
DROP TRIGGER IF EXISTS evolution_eval_input_skill_file_commit_guard ON evolution_eval_input_skill_file;
CREATE CONSTRAINT TRIGGER evolution_eval_input_skill_file_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_input_skill_file
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_input_commit();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_parameters(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  binding evolution_eval_input%ROWTYPE;
  parameter_keys text[];
  source_paths jsonb;
  constraint_paths jsonb;
BEGIN
  SELECT * INTO job FROM evolution_eval_job WHERE id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO binding FROM evolution_eval_input WHERE eval_input_ref=job.eval_input_ref;
  IF NOT FOUND OR NOT job.operation=ANY(binding.allowed_operations)
     OR job.parameters->>'operation' IS DISTINCT FROM job.operation THEN
    RAISE EXCEPTION 'evolution eval operation must be allowed by its immutable input binding'
      USING ERRCODE='23514';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO parameter_keys
    FROM jsonb_object_keys(job.parameters) key;
  IF (job.operation='validate_sources' AND parameter_keys IS DISTINCT FROM
      ARRAY['operation','source_paths','top']::text[])
     OR (job.operation='simulate' AND parameter_keys IS DISTINCT FROM
      ARRAY['operation','source_paths','testbench','top']::text[])
     OR (job.operation='synthesize' AND parameter_keys IS DISTINCT FROM
      ARRAY['operation','part','source_paths','top']::text[])
     OR (job.operation='implement' AND parameter_keys IS DISTINCT FROM
      ARRAY['constraint_paths','generate_trial_bitstream','operation','part','source_paths','top']::text[]) THEN
    RAISE EXCEPTION 'evolution eval operation parameters have non-canonical keys'
      USING ERRCODE='23514';
  END IF;
  source_paths=job.parameters->'source_paths';
  IF jsonb_typeof(source_paths)<>'array' OR jsonb_array_length(source_paths) NOT BETWEEN 1 AND 512
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(source_paths) p
        WHERE jsonb_typeof(p)<>'string'
           OR p#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
           OR p#>>'{}' !~* '\.(v|vh|sv|svh)$'
     ) OR (
       SELECT count(*)<>count(DISTINCT translate(p#>>'{}','ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))
         FROM jsonb_array_elements(source_paths) p
     ) THEN
    RAISE EXCEPTION 'evolution eval source_paths are not unique ASCII Vivado inputs'
      USING ERRCODE='23514';
  END IF;
  IF job.parameters->'top' IS NOT NULL
     AND job.parameters->'top'<>'null'::jsonb
     AND (jsonb_typeof(job.parameters->'top')<>'string'
          OR job.parameters->>'top' !~ '^[A-Za-z_][A-Za-z0-9_$]{0,127}$') THEN
    RAISE EXCEPTION 'evolution eval top is not a canonical HDL identifier'
      USING ERRCODE='23514';
  END IF;
  IF job.operation<>'validate_sources' AND (
    jsonb_typeof(job.parameters->'top')<>'string'
    OR job.parameters->>'top' !~ '^[A-Za-z_][A-Za-z0-9_$]{0,127}$'
  ) THEN
    RAISE EXCEPTION 'evolution eval operation requires a top identifier'
      USING ERRCODE='23514';
  END IF;
  IF job.operation='simulate' AND (
    jsonb_typeof(job.parameters->'testbench')<>'string'
    OR job.parameters->>'testbench' !~ '^[A-Za-z_][A-Za-z0-9_$]{0,127}$'
  ) THEN
    RAISE EXCEPTION 'evolution eval simulation requires a testbench identifier'
      USING ERRCODE='23514';
  END IF;
  IF job.operation IN ('synthesize','implement') AND (
    jsonb_typeof(job.parameters->'part')<>'string'
    OR job.parameters->>'part' IS DISTINCT FROM binding.part
  ) THEN
    RAISE EXCEPTION 'evolution eval part must match its immutable input binding'
      USING ERRCODE='23514';
  END IF;
  IF job.operation='implement' THEN
    constraint_paths=job.parameters->'constraint_paths';
    IF jsonb_typeof(constraint_paths)<>'array' OR jsonb_array_length(constraint_paths)>128
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(constraint_paths) p
          WHERE jsonb_typeof(p)<>'string'
             OR p#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
             OR p#>>'{}' !~* '\.xdc$'
       ) OR (
         SELECT count(*)<>count(DISTINCT translate(p#>>'{}','ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))
           FROM jsonb_array_elements(constraint_paths) p
       ) OR jsonb_typeof(job.parameters->'generate_trial_bitstream')<>'boolean'
       OR ((job.parameters->>'generate_trial_bitstream')::boolean AND NOT binding.trial_bitstream_allowed) THEN
      RAISE EXCEPTION 'evolution eval implement parameters violate constraint/bitstream policy'
        USING ERRCODE='23514';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_dispatch_parameters(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  workspace evolution_eval_workspace%ROWTYPE;
  projection evolution_eval_workspace_projection%ROWTYPE;
BEGIN
  SELECT j.* INTO job FROM evolution_eval_job j WHERE j.id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT w.* INTO workspace FROM evolution_eval_workspace w WHERE w.eval_job_id=job.id;
  SELECT p.* INTO projection FROM evolution_eval_workspace_projection p
    WHERE p.workspace_id=workspace.id;
  IF workspace.id IS NULL OR projection.workspace_id IS NULL OR projection.sealed_at IS NULL THEN
    RAISE EXCEPTION 'evolution eval dispatch parameters require a sealed current workspace'
      USING ERRCODE='23514';
  END IF;

  -- The immutable source layer is an exact byte-for-byte projection of the
  -- Core-issued input.  Future generated files are allowed only as overlays.
  IF EXISTS (
    SELECT 1 FROM evolution_eval_input_file input_file
     WHERE input_file.eval_input_ref=job.eval_input_ref
       AND NOT EXISTS (
         SELECT 1 FROM evolution_eval_workspace_file workspace_file
          WHERE workspace_file.workspace_id=workspace.id
            AND workspace_file.revision=projection.current_revision
            AND workspace_file.layer='source'
            AND workspace_file.path=input_file.path
            AND workspace_file.sha256=input_file.sha256
            AND workspace_file.size_bytes=input_file.size_bytes
            AND workspace_file.media_type=input_file.media_type
            AND workspace_file.managed_content=input_file.managed_content
       )
  ) OR EXISTS (
    SELECT 1 FROM evolution_eval_workspace_file workspace_file
     WHERE workspace_file.workspace_id=workspace.id
       AND workspace_file.revision=projection.current_revision
       AND workspace_file.layer='source'
       AND NOT EXISTS (
         SELECT 1 FROM evolution_eval_input_file input_file
          WHERE input_file.eval_input_ref=job.eval_input_ref
            AND input_file.path=workspace_file.path
            AND input_file.sha256=workspace_file.sha256
            AND input_file.size_bytes=workspace_file.size_bytes
            AND input_file.media_type=workspace_file.media_type
            AND input_file.managed_content=workspace_file.managed_content
       )
  ) THEN
    RAISE EXCEPTION 'evolution eval sealed source layer must exactly match immutable input'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(job.parameters->'source_paths') declared(path)
     WHERE NOT EXISTS (
       SELECT 1 FROM evolution_eval_workspace_file workspace_file
        WHERE workspace_file.workspace_id=workspace.id
          AND workspace_file.revision=projection.current_revision
          AND workspace_file.path=declared.path
          AND workspace_file.layer IN ('source','overlay')
          AND (
            (workspace_file.media_type='text/x-verilog'
             AND (translate(workspace_file.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.(v|vh)$')
            OR (workspace_file.media_type='text/x-systemverilog'
                AND (translate(workspace_file.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.(sv|svh)$')
          )
     )
  ) THEN
    RAISE EXCEPTION 'evolution eval source_paths must name sealed source/overlay HDL files'
      USING ERRCODE='23514';
  END IF;

  IF job.operation='implement' AND (
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(job.parameters->'constraint_paths') declared(path)
       WHERE NOT EXISTS (
         SELECT 1 FROM evolution_eval_workspace_file workspace_file
          WHERE workspace_file.workspace_id=workspace.id
            AND workspace_file.revision=projection.current_revision
            AND workspace_file.path=declared.path
            AND workspace_file.layer IN ('source','overlay')
            AND workspace_file.media_type='application/x-xdc'
            AND (translate(workspace_file.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.xdc$'
       )
    )
  ) THEN
    RAISE EXCEPTION 'evolution eval constraint_paths must name sealed source/overlay XDC files'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_operation_facts(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  tool_correlation text;
  workspace evolution_eval_workspace%ROWTYPE;
  projection evolution_eval_workspace_projection%ROWTYPE;
  revision_row evolution_eval_workspace_revision%ROWTYPE;
  operation_fact record;
  audit record;
  event record;
  expected_audit_type text;
  expected_event_type text;
  expected_payload jsonb;
BEGIN
  SELECT j.* INTO job FROM evolution_eval_job j WHERE j.id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT r.correlation_id INTO tool_correlation FROM tool_run r WHERE r.id=job.tool_run_id;
  SELECT w.* INTO workspace FROM evolution_eval_workspace w WHERE w.eval_job_id=job.id;
  SELECT p.* INTO projection FROM evolution_eval_workspace_projection p
    WHERE p.workspace_id=workspace.id;
  IF (SELECT count(*) FROM evolution_eval_operation_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='prepare')<>1 THEN
    RAISE EXCEPTION 'evolution eval job requires exactly one prepare operation fact'
      USING ERRCODE='23514';
  END IF;
  FOR revision_row IN SELECT r.* FROM evolution_eval_workspace_revision r
    WHERE r.workspace_id=workspace.id LOOP
    IF (SELECT count(*) FROM evolution_eval_operation_fact f
         WHERE f.workspace_id=workspace.id AND f.workspace_revision=revision_row.revision
           AND f.fact_type='workspace_revision')<>1
       OR (SELECT count(*) FROM evolution_eval_operation_fact f
         WHERE f.workspace_id=workspace.id AND f.workspace_revision=revision_row.revision
           AND f.fact_type='workspace_projection')<>1 THEN
      RAISE EXCEPTION 'each evolution eval revision/projection write requires typed operation facts'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (projection.sealed_at IS NULL) IS DISTINCT FROM NOT EXISTS (
    SELECT 1 FROM evolution_eval_operation_fact f
     WHERE f.workspace_id=workspace.id AND f.fact_type='workspace_seal'
  ) THEN
    RAISE EXCEPTION 'evolution eval seal projection and operation fact must be atomic'
      USING ERRCODE='23514';
  END IF;
  FOR operation_fact IN SELECT * FROM evolution_eval_operation_fact f
    WHERE f.eval_job_id=job.id LOOP
    SELECT a.* INTO audit FROM evolution_eval_audit_event a
      WHERE a.id=operation_fact.audit_event_id;
    SELECT o.* INTO event FROM outbox_events o
      WHERE o.event_id=operation_fact.outbox_event_id;
    IF operation_fact.fact_type='prepare' THEN
      SELECT r.* INTO revision_row FROM evolution_eval_workspace_revision r
       WHERE r.workspace_id=workspace.id AND r.revision=1;
      expected_audit_type='eval_job.prepared';
      expected_event_type='evolution_eval.job_prepared';
      expected_payload=jsonb_build_object(
        'fact_id',operation_fact.id,'prepare_request_hash',job.prepare_request_hash,
        'input_manifest_hash',job.input_manifest_hash,
        'workspace_manifest_hash',revision_row.manifest_hash
      );
    ELSE
      SELECT r.* INTO revision_row FROM evolution_eval_workspace_revision r
       WHERE r.workspace_id=operation_fact.workspace_id
         AND r.revision=operation_fact.workspace_revision;
      expected_audit_type=CASE operation_fact.fact_type
        WHEN 'workspace_revision' THEN 'workspace_revision'
        WHEN 'workspace_projection' THEN 'workspace_projection'
        ELSE 'workspace_sealed' END;
      expected_event_type=CASE operation_fact.fact_type
        WHEN 'workspace_revision' THEN 'evolution_eval.workspace_revision'
        WHEN 'workspace_projection' THEN 'evolution_eval.workspace_projection'
        ELSE 'evolution_eval.workspace_sealed' END;
      expected_payload=jsonb_build_object(
        'fact_id',operation_fact.id,'workspace_id',workspace.id,
        'revision',revision_row.revision,'workspace_manifest_hash',revision_row.manifest_hash,
        'file_count',revision_row.file_count,'byte_count',revision_row.total_bytes
      );
    END IF;
    IF audit.id IS NULL OR event.event_id IS NULL
       OR operation_fact.evolution_origin_txid<>audit.evolution_origin_txid
       OR operation_fact.evolution_origin_txid<>event.evolution_origin_txid
       OR audit.eval_job_id<>job.id OR audit.curator_run_id<>job.curator_run_id
       OR audit.project_id<>job.project_id OR audit.correlation_id<>tool_correlation
       OR audit.event_type<>expected_audit_type OR audit.operation<>job.operation
       OR audit.from_state IS NOT NULL OR audit.to_state IS NOT NULL
       OR audit.request_hash IS DISTINCT FROM (CASE
         WHEN operation_fact.fact_type='prepare' THEN job.prepare_request_hash ELSE NULL END)
       OR audit.workspace_manifest_hash IS DISTINCT FROM revision_row.manifest_hash
       OR audit.evidence_manifest_hash IS NOT NULL OR audit.error_code IS NOT NULL
       OR audit.file_count IS DISTINCT FROM revision_row.file_count
       OR audit.byte_count IS DISTINCT FROM revision_row.total_bytes
       OR event.aggregate_type<>'evolution_eval_job' OR event.aggregate_id<>job.id
       OR event.event_type<>expected_event_type OR event.project_id<>job.project_id
       OR event.correlation_id<>tool_correlation OR event.headers<>'{}'::jsonb
       OR event.causation_id IS NOT NULL OR event.classification<>'D1'
       OR event.payload IS DISTINCT FROM expected_payload THEN
      RAISE EXCEPTION 'evolution eval operation fact requires same-transaction exact audit/outbox'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_workspace(target_workspace_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  workspace evolution_eval_workspace%ROWTYPE;
  job evolution_eval_job%ROWTYPE;
  projection evolution_eval_workspace_projection%ROWTYPE;
  revision_row evolution_eval_workspace_revision%ROWTYPE;
  dispatch evolution_eval_dispatch%ROWTYPE;
  tombstone evolution_eval_dispatch_tombstone%ROWTYPE;
  revision_count integer;
  max_revision integer;
  actual_files jsonb;
  actual_file_count integer;
  actual_total_bytes bigint;
  actual_source_files integer;
  actual_source_bytes bigint;
  actual_skill_files integer;
  actual_skill_bytes bigint;
  actual_overlay_files integer;
  actual_overlay_bytes bigint;
BEGIN
  SELECT * INTO workspace FROM evolution_eval_workspace WHERE id=target_workspace_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO job FROM evolution_eval_job WHERE id=workspace.eval_job_id;
  IF NOT FOUND OR job.workspace_id<>workspace.id OR job.eval_input_ref<>workspace.eval_input_ref
     OR job.input_manifest_hash<>workspace.input_manifest_hash THEN
    RAISE EXCEPTION 'evolution eval workspace/job binding mismatch' USING ERRCODE='23514';
  END IF;
  SELECT count(*)::integer,max(revision)::integer INTO revision_count,max_revision
    FROM evolution_eval_workspace_revision WHERE workspace_id=workspace.id;
  IF revision_count=0 OR max_revision<>revision_count THEN
    RAISE EXCEPTION 'evolution eval workspace revisions must start at 1 and increase by one'
      USING ERRCODE='23514';
  END IF;
  FOR revision_row IN SELECT * FROM evolution_eval_workspace_revision
    WHERE workspace_id=workspace.id ORDER BY revision LOOP
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'path',f.path,'sha256',f.sha256,'size_bytes',f.size_bytes,
             'media_type',f.media_type,'layer',f.layer,'read_only',f.read_only
           ) ORDER BY translate(f.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",
                      f.path COLLATE "C"),'[]'::jsonb),
           count(*)::integer,COALESCE(sum(f.size_bytes),0)::bigint,
           count(*) FILTER (WHERE f.layer='source')::integer,
           COALESCE(sum(f.size_bytes) FILTER (WHERE f.layer='source'),0)::bigint,
           count(*) FILTER (WHERE f.layer='skill')::integer,
           COALESCE(sum(f.size_bytes) FILTER (WHERE f.layer='skill'),0)::bigint,
           count(*) FILTER (WHERE f.layer='overlay')::integer,
           COALESCE(sum(f.size_bytes) FILTER (WHERE f.layer='overlay'),0)::bigint
      INTO actual_files,actual_file_count,actual_total_bytes,
           actual_source_files,actual_source_bytes,actual_skill_files,actual_skill_bytes,
           actual_overlay_files,actual_overlay_bytes
      FROM evolution_eval_workspace_file f
     WHERE f.workspace_id=workspace.id AND f.revision=revision_row.revision;
    IF EXISTS (
      SELECT 1 FROM evolution_eval_input_skill_file input_skill
       WHERE input_skill.eval_input_ref=workspace.eval_input_ref
         AND NOT EXISTS (
           SELECT 1 FROM evolution_eval_workspace_file workspace_skill
            WHERE workspace_skill.workspace_id=workspace.id
              AND workspace_skill.revision=revision_row.revision
              AND workspace_skill.layer='skill' AND workspace_skill.read_only=true
              AND workspace_skill.path=input_skill.path
              AND workspace_skill.sha256=input_skill.sha256
              AND workspace_skill.size_bytes=input_skill.size_bytes
              AND workspace_skill.media_type=input_skill.media_type
              AND workspace_skill.managed_content=convert_to(input_skill.content,'UTF8')
         )
    ) OR EXISTS (
      SELECT 1 FROM evolution_eval_workspace_file workspace_skill
       WHERE workspace_skill.workspace_id=workspace.id
         AND workspace_skill.revision=revision_row.revision
         AND workspace_skill.layer='skill'
         AND NOT EXISTS (
           SELECT 1 FROM evolution_eval_input_skill_file input_skill
            WHERE input_skill.eval_input_ref=workspace.eval_input_ref
              AND input_skill.path=workspace_skill.path
              AND input_skill.sha256=workspace_skill.sha256
              AND input_skill.size_bytes=workspace_skill.size_bytes
              AND input_skill.media_type=workspace_skill.media_type
              AND convert_to(input_skill.content,'UTF8')=workspace_skill.managed_content
         )
    ) THEN
      RAISE EXCEPTION 'evolution eval workspace skill layer must exactly match immutable skill input'
        USING ERRCODE='23514';
    END IF;
    IF revision_row.file_count<>actual_file_count
       OR revision_row.total_bytes<>actual_total_bytes
       OR revision_row.source_files<>actual_source_files
       OR revision_row.source_bytes<>actual_source_bytes
       OR revision_row.skill_files<>actual_skill_files
       OR revision_row.skill_bytes<>actual_skill_bytes
       OR revision_row.overlay_files<>actual_overlay_files
       OR revision_row.overlay_bytes<>actual_overlay_bytes
       OR revision_row.manifest IS DISTINCT FROM jsonb_build_object(
         'schema','evolution-eval-workspace-manifest.v1',
         'workspace_id',workspace.id,'revision',revision_row.revision,'files',actual_files
       ) THEN
      RAISE EXCEPTION 'evolution eval workspace manifest/child totals mismatch'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT * INTO projection FROM evolution_eval_workspace_projection
    WHERE workspace_id=workspace.id;
  IF NOT FOUND OR projection.current_revision<>max_revision THEN
    RAISE EXCEPTION 'evolution eval workspace projection must point at the latest revision'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO dispatch FROM evolution_eval_dispatch WHERE eval_job_id=job.id;
  IF FOUND THEN
    PERFORM synthia_assert_evolution_eval_dispatch_parameters(job.id);
    IF projection.sealed_at IS NULL
       OR dispatch.workspace_id<>workspace.id
       OR dispatch.workspace_revision<>projection.current_revision
       OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_workspace_revision r
          WHERE r.workspace_id=workspace.id AND r.revision=projection.current_revision
            AND r.manifest_hash=dispatch.workspace_manifest_hash
       )
       OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_audit_event a
          WHERE a.id=dispatch.audit_event_id AND a.eval_job_id=job.id
            AND a.curator_run_id=job.curator_run_id AND a.project_id=job.project_id
            AND a.event_type='dispatch_sealed' AND a.from_state IS NULL AND a.to_state IS NULL
            AND a.correlation_id=(SELECT correlation_id FROM tool_run WHERE id=job.tool_run_id)
            AND a.operation=job.operation
            AND a.request_hash=dispatch.dispatch_request_hash
            AND a.workspace_manifest_hash=dispatch.workspace_manifest_hash
            AND a.evidence_manifest_hash IS NULL AND a.file_count IS NULL
            AND a.byte_count IS NULL AND a.error_code IS NULL
       )
       OR NOT EXISTS (
         SELECT 1 FROM outbox_events o
          WHERE o.event_id=dispatch.outbox_event_id
            AND o.aggregate_type='evolution_eval_job' AND o.aggregate_id=job.id
            AND o.event_type='evolution_eval.dispatch_requested'
            AND o.project_id=job.project_id
            AND o.correlation_id=(SELECT correlation_id FROM tool_run WHERE id=job.tool_run_id)
            AND o.headers='{}'::jsonb AND o.causation_id IS NULL
            AND o.classification='D1'
            AND o.payload=jsonb_build_object('dispatch_request_hash',dispatch.dispatch_request_hash)
       ) OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_dispatch d
         JOIN evolution_eval_audit_event a ON a.id=d.audit_event_id
         JOIN outbox_events o ON o.event_id=d.outbox_event_id
         WHERE d.eval_job_id=job.id
           AND d.evolution_origin_txid=a.evolution_origin_txid
           AND d.evolution_origin_txid=o.evolution_origin_txid
       ) THEN
      RAISE EXCEPTION 'evolution eval dispatch must atomically seal current revision with audit/outbox'
        USING ERRCODE='23514';
    END IF;
  ELSIF projection.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'evolution eval workspace cannot seal without a dispatch fact'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO tombstone FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=job.id;
  IF FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM tool_run r WHERE r.id=job.tool_run_id AND r.state='rejected')
       OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_transition_fact t
          WHERE t.eval_job_id=job.id AND t.from_state='submitted' AND t.to_state='rejected'
       )
       OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_audit_event a
          WHERE a.id=tombstone.audit_event_id AND a.eval_job_id=job.id
            AND a.curator_run_id=job.curator_run_id AND a.project_id=job.project_id
            AND a.event_type='dispatch_tombstone' AND a.from_state IS NULL AND a.to_state IS NULL
            AND a.correlation_id=(SELECT correlation_id FROM tool_run WHERE id=job.tool_run_id)
            AND a.operation=job.operation
            AND a.request_hash=tombstone.error_hash
            AND a.workspace_manifest_hash IS NULL AND a.evidence_manifest_hash IS NULL
            AND a.file_count IS NULL AND a.byte_count IS NULL
            AND a.error_code=tombstone.reason_code
       )
       OR NOT EXISTS (
         SELECT 1 FROM outbox_events o
          WHERE o.event_id=tombstone.outbox_event_id
            AND o.aggregate_type='evolution_eval_job' AND o.aggregate_id=job.id
            AND o.event_type='evolution_eval.dispatch_tombstoned'
            AND o.project_id=job.project_id
            AND o.correlation_id=(SELECT correlation_id FROM tool_run WHERE id=job.tool_run_id)
            AND o.headers='{}'::jsonb AND o.causation_id IS NULL
            AND o.classification='D1'
            AND o.payload=jsonb_build_object('error_hash',tombstone.error_hash)
       ) OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_dispatch_tombstone t
         JOIN evolution_eval_audit_event a ON a.id=t.audit_event_id
         JOIN outbox_events o ON o.event_id=t.outbox_event_id
         WHERE t.eval_job_id=job.id
           AND t.evolution_origin_txid=a.evolution_origin_txid
           AND t.evolution_origin_txid=o.evolution_origin_txid
       ) THEN
      RAISE EXCEPTION 'evolution eval tombstone must win the pre-effect fence with audit/outbox'
        USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_workspace_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target text;
BEGIN
  IF TG_TABLE_NAME='evolution_eval_workspace' THEN
    target=COALESCE(NEW.id,OLD.id);
  ELSIF TG_TABLE_NAME IN ('evolution_eval_workspace_revision','evolution_eval_workspace_file','evolution_eval_workspace_projection') THEN
    target=COALESCE(NEW.workspace_id,OLD.workspace_id);
  ELSE
    SELECT workspace_id INTO target FROM evolution_eval_job
      WHERE id=COALESCE(NEW.eval_job_id,OLD.eval_job_id);
  END IF;
  PERFORM synthia_assert_evolution_eval_workspace(target);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_workspace_commit_guard ON evolution_eval_workspace;
CREATE CONSTRAINT TRIGGER evolution_eval_workspace_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_workspace DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_workspace_revision_commit_guard ON evolution_eval_workspace_revision;
CREATE CONSTRAINT TRIGGER evolution_eval_workspace_revision_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_workspace_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_workspace_file_commit_guard ON evolution_eval_workspace_file;
CREATE CONSTRAINT TRIGGER evolution_eval_workspace_file_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_workspace_file DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_workspace_projection_commit_guard ON evolution_eval_workspace_projection;
CREATE CONSTRAINT TRIGGER evolution_eval_workspace_projection_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_workspace_projection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_dispatch_commit_guard ON evolution_eval_dispatch;
CREATE CONSTRAINT TRIGGER evolution_eval_dispatch_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_dispatch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_tombstone_commit_guard ON evolution_eval_dispatch_tombstone;
CREATE CONSTRAINT TRIGGER evolution_eval_tombstone_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_dispatch_tombstone DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();

CREATE OR REPLACE FUNCTION synthia_lock_evolution_eval_skill_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
    FROM learned_skill_version skill_version
   WHERE skill_version.id=NEW.version_id
   FOR UPDATE;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_input_version_lock_guard ON evolution_eval_input;
CREATE TRIGGER evolution_eval_input_version_lock_guard
  BEFORE INSERT ON evolution_eval_input
  FOR EACH ROW EXECUTE FUNCTION synthia_lock_evolution_eval_skill_version();
DROP TRIGGER IF EXISTS evolution_eval_learned_skill_file_version_lock_guard ON learned_skill_file;
CREATE TRIGGER evolution_eval_learned_skill_file_version_lock_guard
  BEFORE INSERT ON learned_skill_file
  FOR EACH ROW EXECUTE FUNCTION synthia_lock_evolution_eval_skill_version();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_learned_skill_file_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding record;
  bound_workspace record;
BEGIN
  FOR binding IN
    SELECT i.eval_input_ref
      FROM evolution_eval_input i
     WHERE i.version_id=NEW.version_id
     ORDER BY i.eval_input_ref
  LOOP
    PERFORM synthia_assert_evolution_eval_input(binding.eval_input_ref);
    FOR bound_workspace IN
      SELECT w.id
        FROM evolution_eval_workspace w
       WHERE w.eval_input_ref=binding.eval_input_ref
       ORDER BY w.id
    LOOP
      PERFORM synthia_assert_evolution_eval_workspace(bound_workspace.id);
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_learned_skill_file_commit_guard ON learned_skill_file;
CREATE CONSTRAINT TRIGGER evolution_eval_learned_skill_file_commit_guard
  AFTER INSERT ON learned_skill_file
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_learned_skill_file_commit();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_run_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unknown_job_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evolution eval run rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.curator_run_id IS DISTINCT FROM NEW.curator_run_id
     OR OLD.budget_started_at IS DISTINCT FROM NEW.budget_started_at
     OR OLD.deadline_at IS DISTINCT FROM NEW.deadline_at
     OR OLD.max_jobs IS DISTINCT FROM NEW.max_jobs
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.unknown_effect_latched_at IS NOT NULL
         AND OLD.unknown_effect_latched_at IS DISTINCT FROM NEW.unknown_effect_latched_at)
     OR (OLD.unknown_effect_origin_txid IS NOT NULL
         AND OLD.unknown_effect_origin_txid IS DISTINCT FROM NEW.unknown_effect_origin_txid)
     OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS DISTINCT FROM NEW.completed_at) THEN
    RAISE EXCEPTION 'evolution eval run immutable facts cannot change' USING ERRCODE = '55000';
  END IF;
  IF OLD.unknown_effect_latched_at IS NULL AND NEW.unknown_effect_latched_at IS NOT NULL THEN
    SELECT j.id INTO unknown_job_id
      FROM evolution_eval_job j
      JOIN evolution_eval_transition_fact t ON t.eval_job_id=j.id
     WHERE j.curator_run_id=NEW.curator_run_id
       AND t.to_state='unknown_effect'
       AND t.evolution_origin_txid=txid_current()
     LIMIT 1 FOR UPDATE OF j;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown-effect latch requires its same-transaction job fact before latching'
        USING ERRCODE='23514';
    END IF;
    NEW.unknown_effect_origin_txid=txid_current();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_run_mutation_guard ON evolution_eval_run;
CREATE TRIGGER evolution_eval_run_mutation_guard
  BEFORE UPDATE OR DELETE ON evolution_eval_run
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_run_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_run_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unknown_effect_latched_at IS NOT NULL AND TG_OP='INSERT' THEN
    RAISE EXCEPTION 'initial evolution eval run cannot pre-seed unknown effect latch'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM curator_run c
     WHERE c.id=NEW.curator_run_id AND c.mode='run'
       AND c.state IN ('running','completed','failed')
  ) THEN
    RAISE EXCEPTION 'evolution eval budget requires a persistent run Curator claim'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_run_binding_guard ON evolution_eval_run;
CREATE CONSTRAINT TRIGGER evolution_eval_run_binding_guard
  AFTER INSERT OR UPDATE ON evolution_eval_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_run_binding();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_workspace_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.current_revision<>1 OR NEW.sealed_at IS NOT NULL OR NEW.discarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'initial evolution eval projection must be unsealed revision 1'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evolution eval workspace projection rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.evolution_origin_txid=txid_current() THEN
    RAISE EXCEPTION 'initial evolution eval projection revision 1 must commit before update'
      USING ERRCODE='23514';
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.evolution_origin_txid IS DISTINCT FROM NEW.evolution_origin_txid
     OR NEW.current_revision < OLD.current_revision
     OR NEW.current_revision > OLD.current_revision + 1
     OR (OLD.sealed_at IS NOT NULL AND OLD.sealed_at IS DISTINCT FROM NEW.sealed_at)
     OR (OLD.discarded_at IS NOT NULL AND OLD.discarded_at IS DISTINCT FROM NEW.discarded_at)
     OR (NEW.current_revision > OLD.current_revision AND OLD.sealed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'evolution eval workspace projection is monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_workspace_projection_guard ON evolution_eval_workspace_projection;
CREATE TRIGGER evolution_eval_workspace_projection_guard
  BEFORE INSERT OR UPDATE OR DELETE ON evolution_eval_workspace_projection
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_projection();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_tool_run()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_run_id text;
BEGIN
  IF NEW.run_class::text <> 'evolution_eval' AND OLD.run_class::text <> 'evolution_eval' THEN
    RETURN NEW;
  END IF;
  IF OLD.run_class IS DISTINCT FROM NEW.run_class THEN
    RAISE EXCEPTION 'evolution eval run class is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state::text = 'lost' THEN
    RAISE EXCEPTION 'lost is not valid for evolution eval' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IS NOT DISTINCT FROM NEW.state THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state::text = 'submitted' AND NEW.state::text IN ('rejected','queued'))
    OR (OLD.state::text = 'queued' AND NEW.state::text = 'preparing')
    OR (OLD.state::text = 'preparing' AND NEW.state::text IN ('running','failed','cancelled'))
    OR (OLD.state::text = 'running' AND NEW.state::text IN (
      'succeeded','failed','cancelling','timeout','unknown_effect'
    ))
    OR (OLD.state::text = 'cancelling' AND NEW.state::text = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'illegal evolution eval tool run transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '55000';
  END IF;
  SELECT curator_run_id INTO job_run_id
    FROM evolution_eval_job WHERE tool_run_id = NEW.id;
  IF job_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM evolution_eval_audit_event a
     WHERE a.eval_job_id = (SELECT id FROM evolution_eval_job WHERE tool_run_id=NEW.id)
       AND a.from_state = OLD.state AND a.to_state = NEW.state
  ) THEN
    RAISE EXCEPTION 'evolution eval transition requires append-only audit' USING ERRCODE = '23514';
  END IF;
  IF NEW.state::text = 'unknown_effect' AND job_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM evolution_eval_run r
       WHERE r.curator_run_id=job_run_id AND r.unknown_effect_latched_at IS NOT NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM outbox_events o
       WHERE o.aggregate_type='evolution_eval_job'
         AND o.aggregate_id=(SELECT id FROM evolution_eval_job WHERE tool_run_id=NEW.id)
         AND o.event_type='evolution_eval.unknown_effect'
    ) THEN
      RAISE EXCEPTION 'unknown effect requires run latch and durable outbox' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_guard ON tool_run;
CREATE CONSTRAINT TRIGGER evolution_eval_tool_run_guard
  AFTER UPDATE OF state,run_class ON tool_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_tool_run();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evolution eval job binding rejects delete' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id OR OLD.curator_run_id IS DISTINCT FROM NEW.curator_run_id
    OR OLD.application_id IS DISTINCT FROM NEW.application_id OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.version_id IS DISTINCT FROM NEW.version_id OR OLD.eval_input_ref IS DISTINCT FROM NEW.eval_input_ref
    OR OLD.input_manifest_hash IS DISTINCT FROM NEW.input_manifest_hash
    OR OLD.evidence_snapshot_hash IS DISTINCT FROM NEW.evidence_snapshot_hash
    OR OLD.tool_run_id IS DISTINCT FROM NEW.tool_run_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.connector_job_id IS DISTINCT FROM NEW.connector_job_id
    OR OLD.connector_idempotency_key IS DISTINCT FROM NEW.connector_idempotency_key
    OR OLD.request_key IS DISTINCT FROM NEW.request_key OR OLD.prepare_request_hash IS DISTINCT FROM NEW.prepare_request_hash
    OR OLD.ordinal IS DISTINCT FROM NEW.ordinal OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.parameters IS DISTINCT FROM NEW.parameters OR OLD.requested_timeout_ms IS DISTINCT FROM NEW.requested_timeout_ms
    OR OLD.effective_timeout_ms IS DISTINCT FROM NEW.effective_timeout_ms OR OLD.deadline_at IS DISTINCT FROM NEW.deadline_at
    OR OLD.evolution_origin_txid IS DISTINCT FROM NEW.evolution_origin_txid
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN
    RAISE EXCEPTION 'evolution eval immutable job binding cannot change' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tool_run r
     WHERE r.id=NEW.tool_run_id AND r.project_id=NEW.project_id
       AND r.run_class::text='evolution_eval'
       AND r.operation=NEW.operation
       AND r.state::text <> 'lost'
  ) THEN
    RAISE EXCEPTION 'evolution eval job and tool run binding mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM evolution_eval_run r
     WHERE r.curator_run_id=NEW.curator_run_id
       AND NEW.deadline_at <= r.deadline_at
  ) THEN
    RAISE EXCEPTION 'evolution eval job exceeds run deadline' USING ERRCODE = '23514';
  END IF;
  PERFORM synthia_assert_evolution_eval_parameters(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_job_binding_guard ON evolution_eval_job;
CREATE CONSTRAINT TRIGGER evolution_eval_job_binding_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_job
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_job_binding();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_stable_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  committed_state text;
  committed_class text;
BEGIN
  SELECT state::text,run_class::text INTO committed_state,committed_class
    FROM tool_run WHERE id=NEW.id;
  IF committed_class='evolution_eval'
     AND committed_state IN ('queued','preparing','cancelling') THEN
    RAISE EXCEPTION 'evolution eval intermediate state cannot be committed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_stable_state_guard ON tool_run;
CREATE CONSTRAINT TRIGGER evolution_eval_stable_state_guard
  AFTER INSERT OR UPDATE OF state,run_class ON tool_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_stable_state();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_tool_run_initial()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_class::text='evolution_eval' THEN
    IF TG_OP<>'INSERT' OR NEW.state::text<>'submitted'
       OR NEW.start_time IS NOT NULL OR NEW.end_time IS NOT NULL THEN
      RAISE EXCEPTION 'evolution eval ToolRun must be inserted as submitted and cannot be reclassified'
        USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='UPDATE' AND OLD.run_class::text='evolution_eval' THEN
    RAISE EXCEPTION 'evolution eval run class is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_initial_guard ON tool_run;
CREATE TRIGGER evolution_eval_tool_run_initial_guard
  BEFORE INSERT OR UPDATE OF run_class ON tool_run
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_tool_run_initial();

CREATE OR REPLACE FUNCTION synthia_guard_evolution_eval_tool_run_binding_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.run_class::text<>'evolution_eval' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval ToolRun rejects delete' USING ERRCODE='55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.operation IS DISTINCT FROM NEW.operation OR OLD.run_class IS DISTINCT FROM NEW.run_class
     OR OLD.input_manifest_hash IS DISTINCT FROM NEW.input_manifest_hash
     OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.start_time IS NOT NULL AND OLD.start_time IS DISTINCT FROM NEW.start_time)
     OR (OLD.end_time IS NOT NULL AND OLD.end_time IS DISTINCT FROM NEW.end_time) THEN
    RAISE EXCEPTION 'evolution eval ToolRun immutable binding/time cannot change'
      USING ERRCODE='55000';
  END IF;
  IF NEW.state::text IN ('rejected','succeeded','failed','cancelled','timeout','unknown_effect') THEN
    IF NEW.end_time IS NULL THEN
      RAISE EXCEPTION 'terminal evolution eval ToolRun requires immutable terminal time'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.end_time IS NOT NULL THEN
    RAISE EXCEPTION 'non-terminal evolution eval ToolRun cannot set terminal time'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_binding_mutation_guard ON tool_run;
CREATE TRIGGER evolution_eval_tool_run_binding_mutation_guard
  BEFORE UPDATE OR DELETE ON tool_run
  FOR EACH ROW EXECUTE FUNCTION synthia_guard_evolution_eval_tool_run_binding_mutation();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_run(target_run_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  run evolution_eval_run%ROWTYPE;
  unknown_count integer;
  first_latch timestamptz;
BEGIN
  SELECT * INTO run FROM evolution_eval_run WHERE curator_run_id=target_run_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*)::integer,min(u.latched_at) INTO unknown_count,first_latch
    FROM evolution_eval_unknown_fact u
    JOIN evolution_eval_job j ON j.id=u.eval_job_id
   WHERE j.curator_run_id=target_run_id;
  IF (run.unknown_effect_latched_at IS NULL AND unknown_count<>0)
     OR (run.unknown_effect_latched_at IS NOT NULL
         AND (unknown_count<>1 OR first_latch<>run.unknown_effect_latched_at)) THEN
    RAISE EXCEPTION 'evolution eval unknown latch and per-job fact must be atomic and exact'
      USING ERRCODE='23514';
  END IF;
  IF run.unknown_effect_latched_at IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM evolution_eval_job j
       WHERE j.curator_run_id=target_run_id
         AND j.evolution_origin_txid>=run.unknown_effect_origin_txid
    ) OR EXISTS (
      SELECT 1 FROM evolution_eval_dispatch d
      JOIN evolution_eval_job j ON j.id=d.eval_job_id
       WHERE j.curator_run_id=target_run_id
         AND d.evolution_origin_txid>=run.unknown_effect_origin_txid
    ) OR EXISTS (
      SELECT 1 FROM evolution_eval_transition_fact t
      JOIN evolution_eval_job j ON j.id=t.eval_job_id
       WHERE j.curator_run_id=target_run_id
         AND t.from_state='submitted' AND t.to_state='queued'
         AND t.evolution_origin_txid>=run.unknown_effect_origin_txid
    )
  ) THEN
    RAISE EXCEPTION 'unknown-effect latch forbids same-or-later job/dispatch/effect facts'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_job(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  run_row tool_run%ROWTYPE;
  transition evolution_eval_transition_fact%ROWTYPE;
  audit evolution_eval_audit_event%ROWTYPE;
  unknown_fact evolution_eval_unknown_fact%ROWTYPE;
  expected_state text := 'submitted';
  expected_sequence integer := 1;
  transition_count integer := 0;
  expected_outbox_type text;
  expected_outbox_payload jsonb;
BEGIN
  SELECT * INTO job FROM evolution_eval_job WHERE id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO run_row FROM tool_run WHERE id=job.tool_run_id;
  IF NOT FOUND OR run_row.run_class::text<>'evolution_eval' OR run_row.project_id<>job.project_id
     OR run_row.operation<>job.operation OR run_row.input_manifest_hash<>job.input_manifest_hash THEN
    RAISE EXCEPTION 'evolution eval job must have exactly one matching ToolRun' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM evolution_eval_job WHERE tool_run_id=job.tool_run_id)<>1 THEN
    RAISE EXCEPTION 'evolution eval ToolRun/job binding must be one-to-one' USING ERRCODE='23514';
  END IF;
  IF run_row.state::text IN ('queued','preparing','cancelling','lost') THEN
    RAISE EXCEPTION 'evolution eval ToolRun has no commit-stable projection for this state'
      USING ERRCODE='23514';
  END IF;
  FOR transition IN SELECT * FROM evolution_eval_transition_fact
    WHERE eval_job_id=job.id ORDER BY transition_sequence LOOP
    transition_count=transition_count+1;
    IF transition.transition_sequence<>expected_sequence OR transition.from_state::text<>expected_state THEN
      RAISE EXCEPTION 'evolution eval transition facts must be a contiguous chain from submitted'
        USING ERRCODE='23514';
    END IF;
    SELECT * INTO audit FROM evolution_eval_audit_event WHERE id=transition.audit_event_id;
    IF NOT FOUND OR audit.eval_job_id<>job.id OR audit.curator_run_id<>job.curator_run_id
       OR audit.project_id<>job.project_id OR audit.event_type<>'tool_run_transition'
       OR audit.correlation_id<>run_row.correlation_id
       OR audit.from_state IS DISTINCT FROM transition.from_state
       OR audit.to_state IS DISTINCT FROM transition.to_state OR audit.operation<>job.operation
       OR audit.request_hash IS NOT NULL OR audit.workspace_manifest_hash IS NOT NULL
       OR audit.evidence_manifest_hash IS NOT NULL OR audit.file_count IS NOT NULL
       OR audit.byte_count IS NOT NULL OR audit.error_code IS NOT NULL THEN
      RAISE EXCEPTION 'each evolution eval transition requires one exact audit fact'
        USING ERRCODE='23514';
    END IF;
    expected_outbox_type=CASE WHEN transition.to_state::text='unknown_effect'
      THEN 'evolution_eval.unknown_effect' ELSE 'evolution_eval.tool_run_transition' END;
    expected_outbox_payload=jsonb_build_object(
      'from_state',transition.from_state::text,'to_state',transition.to_state::text
    );
    IF transition.to_state::text='unknown_effect' THEN
      expected_outbox_payload=expected_outbox_payload||jsonb_build_object(
        'fact_hash',(SELECT u.fact_hash FROM evolution_eval_unknown_fact u
          WHERE u.eval_job_id=job.id)
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM outbox_events o WHERE o.event_id=transition.outbox_event_id
        AND o.aggregate_type='evolution_eval_job' AND o.aggregate_id=job.id
        AND o.event_type=expected_outbox_type
        AND o.project_id=job.project_id AND o.correlation_id=run_row.correlation_id
        AND o.headers='{}'::jsonb AND o.causation_id IS NULL AND o.classification='D1'
        AND o.payload=expected_outbox_payload
        AND o.evolution_origin_txid=transition.evolution_origin_txid
        AND o.evolution_origin_txid=audit.evolution_origin_txid
    ) THEN
      RAISE EXCEPTION 'each evolution eval transition requires one exact outbox fact'
        USING ERRCODE='23514';
    END IF;
    expected_state=transition.to_state::text;
    expected_sequence=expected_sequence+1;
  END LOOP;
  IF expected_state<>run_row.state::text
     OR (run_row.state::text='submitted' AND transition_count<>0)
     OR (run_row.state::text<>'submitted' AND transition_count=0) THEN
    RAISE EXCEPTION 'evolution eval ToolRun projection must equal its complete transition chain'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_audit_event a
     WHERE a.eval_job_id=job.id AND a.from_state IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.audit_event_id=a.id)
  ) THEN
    RAISE EXCEPTION 'evolution eval transition audit cannot be pre-seeded or orphaned'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO unknown_fact FROM evolution_eval_unknown_fact WHERE eval_job_id=job.id;
  IF run_row.state::text='unknown_effect' THEN
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_transition_fact t
       WHERE t.id=unknown_fact.transition_fact_id AND t.eval_job_id=job.id
         AND t.to_state='unknown_effect' AND t.audit_event_id=unknown_fact.audit_event_id
         AND t.outbox_event_id=unknown_fact.outbox_event_id
    ) OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_run r WHERE r.curator_run_id=job.curator_run_id
        AND r.unknown_effect_latched_at=unknown_fact.latched_at
    ) OR NOT EXISTS (
      SELECT 1 FROM outbox_events o WHERE o.event_id=unknown_fact.outbox_event_id
        AND o.event_type='evolution_eval.unknown_effect'
        AND o.payload->>'fact_hash'=unknown_fact.fact_hash
    ) OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_transition_fact t
      JOIN evolution_eval_audit_event a ON a.id=t.audit_event_id
      JOIN outbox_events o ON o.event_id=t.outbox_event_id
      JOIN evolution_eval_unknown_fact u ON u.transition_fact_id=t.id
      JOIN evolution_eval_run r ON r.curator_run_id=job.curator_run_id
       WHERE t.eval_job_id=job.id
         AND t.evolution_origin_txid=a.evolution_origin_txid
         AND t.evolution_origin_txid=o.evolution_origin_txid
         AND t.evolution_origin_txid=u.evolution_origin_txid
         AND t.evolution_origin_txid=r.unknown_effect_origin_txid
    ) THEN
      RAISE EXCEPTION 'unknown_effect requires atomic terminal/transition/audit/outbox/run-latch facts'
        USING ERRCODE='23514';
    END IF;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'unknown effect fact cannot be pre-seeded before its terminal state'
      USING ERRCODE='23514';
  END IF;
  IF run_row.state::text<>'submitted' AND NOT EXISTS (
    SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=job.id
  ) AND run_row.state::text<>'rejected' THEN
    RAISE EXCEPTION 'effect-possible evolution eval states require the durable dispatch fact'
      USING ERRCODE='23514';
  END IF;
  IF run_row.state::text='rejected' AND NOT EXISTS (
    SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.eval_job_id=job.id
  ) THEN
    RAISE EXCEPTION 'pre-effect rejection requires an immutable dispatch tombstone'
      USING ERRCODE='23514';
  END IF;
  IF run_row.state::text<>'rejected' AND EXISTS (
    SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.eval_job_id=job.id
  ) THEN
    RAISE EXCEPTION 'dispatch tombstone requires rejected terminal projection'
      USING ERRCODE='23514';
  END IF;
  PERFORM synthia_assert_evolution_eval_parameters(job.id);
  PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_tool_run_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job text;
  final_class text;
BEGIN
  SELECT run_class::text INTO final_class FROM tool_run WHERE id=COALESCE(NEW.id,OLD.id);
  SELECT id INTO target_job FROM evolution_eval_job WHERE tool_run_id=COALESCE(NEW.id,OLD.id);
  IF final_class='evolution_eval' AND target_job IS NULL THEN
    RAISE EXCEPTION 'evolution eval ToolRun cannot commit without its one-to-one job binding'
      USING ERRCODE='23514';
  END IF;
  IF target_job IS NOT NULL THEN PERFORM synthia_assert_evolution_eval_job(target_job); END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_commit_guard ON tool_run;
CREATE CONSTRAINT TRIGGER evolution_eval_tool_run_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON tool_run DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_tool_run_commit();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_fact_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job text;
BEGIN
  target_job=COALESCE(NEW.eval_job_id,OLD.eval_job_id);
  PERFORM synthia_assert_evolution_eval_job(target_job);
  PERFORM synthia_assert_evolution_eval_run((SELECT curator_run_id FROM evolution_eval_job WHERE id=target_job));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_transition_commit_guard ON evolution_eval_transition_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_transition_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_transition_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_job_fact_commit();
DROP TRIGGER IF EXISTS evolution_eval_unknown_commit_guard ON evolution_eval_unknown_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_unknown_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_unknown_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_job_fact_commit();
DROP TRIGGER IF EXISTS evolution_eval_operation_commit_guard ON evolution_eval_operation_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_operation_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_operation_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_job_fact_commit();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_run_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_run(COALESCE(NEW.curator_run_id,OLD.curator_run_id));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_run_commit_guard ON evolution_eval_run;
CREATE CONSTRAINT TRIGGER evolution_eval_run_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_run DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_run_commit();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_audit(target_audit_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  audit evolution_eval_audit_event%ROWTYPE;
  job evolution_eval_job%ROWTYPE;
  tool_correlation text;
  reference_count integer;
BEGIN
  SELECT * INTO audit FROM evolution_eval_audit_event WHERE id=target_audit_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF audit.eval_job_id IS NULL THEN
    RAISE EXCEPTION 'evolution eval audit must be owned by a typed job fact'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO job FROM evolution_eval_job WHERE id=audit.eval_job_id;
  SELECT correlation_id INTO tool_correlation FROM tool_run WHERE id=job.tool_run_id;
  IF job.id IS NULL OR audit.curator_run_id<>job.curator_run_id
     OR audit.project_id<>job.project_id OR audit.correlation_id<>tool_correlation THEN
    RAISE EXCEPTION 'evolution eval audit project/correlation binding mismatch'
      USING ERRCODE='23514';
  END IF;
  SELECT
    (SELECT count(*) FROM evolution_eval_transition_fact t WHERE t.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_dispatch d WHERE d.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_dispatch_tombstone t WHERE t.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_evidence_fact e WHERE e.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_operation_fact f WHERE f.audit_event_id=audit.id)
    INTO reference_count;
  IF reference_count<>1 THEN
    RAISE EXCEPTION 'evolution eval audit must have exactly one typed reverse owner'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.audit_event_id=audit.id) THEN
    PERFORM synthia_assert_evolution_eval_job(job.id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.audit_event_id=audit.id)
     OR EXISTS (SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.audit_event_id=audit.id) THEN
    PERFORM synthia_assert_evolution_eval_workspace(job.workspace_id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_evidence_fact e WHERE e.audit_event_id=audit.id) THEN
    PERFORM synthia_assert_evolution_eval_evidence(job.id);
  ELSE
    PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_audit_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_audit(COALESCE(NEW.id,OLD.id));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_audit_commit_guard ON evolution_eval_audit_event;
CREATE CONSTRAINT TRIGGER evolution_eval_audit_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_audit_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_audit_commit();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_outbox(target_event_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  event outbox_events%ROWTYPE;
  job evolution_eval_job%ROWTYPE;
  reference_count integer;
BEGIN
  SELECT * INTO event FROM outbox_events WHERE event_id=target_event_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT
    (SELECT count(*) FROM evolution_eval_transition_fact t WHERE t.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_dispatch d WHERE d.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_dispatch_tombstone t WHERE t.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_evidence_fact e WHERE e.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_operation_fact f WHERE f.outbox_event_id=event.event_id)
    INTO reference_count;
  IF event.aggregate_type<>'evolution_eval_job'
     OR event.event_type !~ '^evolution_eval\.' OR reference_count<>1 THEN
    RAISE EXCEPTION 'evolution eval outbox must have exact aggregate/type and one reverse owner'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO job FROM evolution_eval_job WHERE id=event.aggregate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval outbox aggregate job does not exist'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.outbox_event_id=event.event_id) THEN
    PERFORM synthia_assert_evolution_eval_job(job.id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.outbox_event_id=event.event_id)
     OR EXISTS (SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.outbox_event_id=event.event_id) THEN
    PERFORM synthia_assert_evolution_eval_workspace(job.workspace_id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_evidence_fact e WHERE e.outbox_event_id=event.event_id) THEN
    PERFORM synthia_assert_evolution_eval_evidence(job.id);
  ELSE
    PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_guard_evolution_eval_outbox_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  protected boolean;
BEGIN
  protected=(OLD.aggregate_type='evolution_eval_job' OR OLD.event_type ~ '^evolution_eval\.'
    OR EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.outbox_event_id=OLD.event_id)
    OR EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.outbox_event_id=OLD.event_id)
    OR EXISTS (SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.outbox_event_id=OLD.event_id)
    OR EXISTS (SELECT 1 FROM evolution_eval_evidence_fact e WHERE e.outbox_event_id=OLD.event_id)
    OR EXISTS (SELECT 1 FROM evolution_eval_operation_fact f WHERE f.outbox_event_id=OLD.event_id));
  IF TG_OP='UPDATE' THEN
    protected=protected OR NEW.aggregate_type='evolution_eval_job'
      OR NEW.event_type ~ '^evolution_eval\.';
  END IF;
  IF NOT protected THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval outbox is immutable except first publication timestamp'
      USING ERRCODE='55000';
  END IF;
  IF NOT (
    OLD.event_id IS NOT DISTINCT FROM NEW.event_id
    AND OLD.aggregate_type IS NOT DISTINCT FROM NEW.aggregate_type
    AND OLD.aggregate_id IS NOT DISTINCT FROM NEW.aggregate_id
    AND OLD.sequence IS NOT DISTINCT FROM NEW.sequence
    AND OLD.event_type IS NOT DISTINCT FROM NEW.event_type
    AND OLD.project_id IS NOT DISTINCT FROM NEW.project_id
    AND OLD.payload IS NOT DISTINCT FROM NEW.payload
    AND OLD.headers IS NOT DISTINCT FROM NEW.headers
    AND OLD.correlation_id IS NOT DISTINCT FROM NEW.correlation_id
    AND OLD.causation_id IS NOT DISTINCT FROM NEW.causation_id
    AND OLD.classification IS NOT DISTINCT FROM NEW.classification
    AND OLD.evolution_origin_txid IS NOT DISTINCT FROM NEW.evolution_origin_txid
    AND OLD.occurred_at IS NOT DISTINCT FROM NEW.occurred_at
    AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'evolution eval outbox is immutable except first publication timestamp'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_outbox_mutation_guard ON outbox_events;
CREATE TRIGGER evolution_eval_outbox_mutation_guard BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION synthia_guard_evolution_eval_outbox_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_outbox_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(NEW.aggregate_type,OLD.aggregate_type)='evolution_eval_job'
     OR COALESCE(NEW.event_type,OLD.event_type) ~ '^evolution_eval\.'
     OR EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id))
     OR EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id))
     OR EXISTS (SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id))
     OR EXISTS (SELECT 1 FROM evolution_eval_evidence_fact e WHERE e.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id))
     OR EXISTS (SELECT 1 FROM evolution_eval_operation_fact f WHERE f.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id)) THEN
    PERFORM synthia_assert_evolution_eval_outbox(COALESCE(NEW.event_id,OLD.event_id));
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_outbox_commit_guard ON outbox_events;
CREATE CONSTRAINT TRIGGER evolution_eval_outbox_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON outbox_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_outbox_commit();

CREATE OR REPLACE FUNCTION synthia_stamp_evolution_eval_evidence_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_evidence_fact_stamp_guard ON evolution_eval_evidence_fact;
CREATE TRIGGER evolution_eval_evidence_fact_stamp_guard
  BEFORE INSERT ON evolution_eval_evidence_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_evidence_fact();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_evidence(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  run_state text;
  run_end_time timestamptz;
  tool_correlation text;
  fact record;
  prior_xid bigint;
  audit record;
  event record;
  frozen evolution_eval_evidence_fact%ROWTYPE;
  actual_entries jsonb;
  actual_count integer;
  actual_bytes bigint;
  expected_event_type text;
  expected_payload jsonb;
BEGIN
  SELECT * INTO job FROM evolution_eval_job WHERE id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT state::text,end_time,correlation_id INTO run_state,run_end_time,tool_correlation
    FROM tool_run WHERE id=job.tool_run_id;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_evidence_fact f
     WHERE f.eval_job_id=job.id AND f.fact_type='freeze_pending'
  ) AND run_state NOT IN ('succeeded','failed','cancelled','timeout') THEN
    RAISE EXCEPTION 'freeze intent requires an accepted terminal evolution eval job'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_evidence_fact conclusion
     WHERE conclusion.eval_job_id=job.id
       AND conclusion.fact_type IN ('frozen','corrupt','unavailable_at_deadline')
  ) AND run_state NOT IN ('succeeded','failed','cancelled','timeout') THEN
    RAISE EXCEPTION 'evolution eval evidence conclusion requires an accepted terminal job'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO frozen FROM evolution_eval_evidence_fact
    WHERE eval_job_id=job.id AND fact_type='frozen';
  IF FOUND THEN
    IF run_state NOT IN ('succeeded','failed','cancelled','timeout') THEN
      RAISE EXCEPTION 'only accepted terminal evolution eval jobs can freeze valid evidence'
        USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'name',e.name,'sha256',e.sha256,'size_bytes',e.size_bytes,
             'media_type',e.media_type,'artifact_classification',e.artifact_classification,
             'usage_classification',e.usage_classification
           ) ORDER BY e.name COLLATE "C"),'[]'::jsonb),
           count(*)::integer,COALESCE(sum(e.size_bytes),0)::bigint
      INTO actual_entries,actual_count,actual_bytes
      FROM evolution_eval_evidence_entry e WHERE e.evidence_fact_id=frozen.id;
    IF frozen.entry_count<>actual_count OR frozen.total_bytes<>actual_bytes
       OR actual_count>128 OR actual_bytes>268435456
       OR frozen.manifest IS DISTINCT FROM jsonb_build_object(
         'schema','evolution-eval-evidence-manifest.v1','eval_job_id',job.id,
         'tool_run_id',job.tool_run_id,'entries',actual_entries
       ) THEN
      RAISE EXCEPTION 'frozen evolution eval evidence manifest/children/count/total mismatch'
        USING ERRCODE='23514';
    END IF;
  END IF;
  FOR fact IN SELECT * FROM evolution_eval_evidence_fact f
    WHERE f.eval_job_id=job.id LOOP
    SELECT * INTO audit FROM evolution_eval_audit_event a WHERE a.id=fact.audit_event_id;
    SELECT * INTO event FROM outbox_events o WHERE o.event_id=fact.outbox_event_id;
    expected_event_type=CASE fact.fact_type
      WHEN 'freeze_pending' THEN 'evolution_eval.evidence.freeze_requested'
      WHEN 'frozen' THEN 'evolution_eval.evidence.frozen'
      WHEN 'corrupt' THEN 'evolution_eval.evidence.corrupt'
      WHEN 'unavailable_at_deadline' THEN 'evolution_eval.evidence.unavailable_at_deadline'
      WHEN 'ack_pending' THEN 'evolution_eval.evidence.ack_requested'
      WHEN 'acknowledged' THEN 'evolution_eval.evidence.acknowledged'
      WHEN 'quarantine_pending' THEN 'evolution_eval.evidence.quarantine_requested'
      WHEN 'expired' THEN 'evolution_eval.evidence.expired'
      WHEN 'cleanup_pending' THEN 'evolution_eval.evidence.cleanup_requested'
      ELSE 'evolution_eval.evidence.cleaned' END;
    expected_payload=jsonb_strip_nulls(jsonb_build_object(
      'fact_id',fact.id,'fact_type',fact.fact_type,'fact_hash',fact.fact_hash,
      'manifest_hash',fact.manifest_hash,'error_code',fact.error_code
    ));
    IF audit.id IS NULL OR event.event_id IS NULL
       OR fact.evolution_origin_txid<>audit.evolution_origin_txid
       OR fact.evolution_origin_txid<>event.evolution_origin_txid
       OR audit.eval_job_id<>job.id OR audit.curator_run_id<>job.curator_run_id
       OR audit.project_id<>job.project_id OR audit.correlation_id<>tool_correlation
       OR audit.event_type<>('evidence.'||fact.fact_type) OR audit.operation<>job.operation
       OR audit.request_hash IS DISTINCT FROM fact.fact_hash
       OR audit.from_state IS NOT NULL OR audit.to_state IS NOT NULL
       OR audit.workspace_manifest_hash IS NOT NULL
       OR audit.evidence_manifest_hash IS DISTINCT FROM fact.manifest_hash
       OR audit.file_count IS DISTINCT FROM (CASE
         WHEN fact.fact_type='frozen' THEN fact.entry_count ELSE NULL END)
       OR audit.byte_count IS DISTINCT FROM (CASE
         WHEN fact.fact_type='frozen' THEN fact.total_bytes ELSE NULL END)
       OR audit.error_code IS DISTINCT FROM fact.error_code
       OR event.aggregate_type<>'evolution_eval_job' OR event.aggregate_id<>job.id
       OR event.event_type<>expected_event_type OR event.project_id<>job.project_id
       OR event.correlation_id<>tool_correlation OR event.headers<>'{}'::jsonb
       OR event.causation_id IS NOT NULL OR event.classification<>'D1'
       OR event.payload IS DISTINCT FROM expected_payload THEN
      RAISE EXCEPTION 'evolution eval evidence fact requires same-transaction exact audit/outbox'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='frozen' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='freeze_pending';
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'frozen evidence requires a previously committed freeze intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type IN ('ack_pending','acknowledged') AND (
      frozen.id IS NULL OR fact.manifest_hash<>frozen.manifest_hash
    ) THEN
      RAISE EXCEPTION 'evolution eval evidence ack must bind the frozen manifest hash'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='ack_pending' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='frozen'
         AND f.manifest_hash=fact.manifest_hash;
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'ack intent requires previously committed frozen evidence'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='acknowledged' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='ack_pending'
         AND f.manifest_hash=fact.manifest_hash;
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'acknowledged evidence requires a previously committed ack intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='corrupt' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='freeze_pending';
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'corrupt evidence requires a previously committed freeze intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='corrupt' AND (
      NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact q WHERE q.eval_job_id=job.id
         AND q.fact_type='quarantine_pending'
         AND q.evolution_origin_txid=fact.evolution_origin_txid
      ) OR NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact c WHERE c.eval_job_id=job.id
         AND c.fact_type='cleanup_pending'
         AND c.evolution_origin_txid=fact.evolution_origin_txid
      )
    ) THEN
      RAISE EXCEPTION 'corrupt evidence requires atomic quarantine and cleanup intents'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='quarantine_pending' AND (
      NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact c WHERE c.eval_job_id=job.id
         AND c.fact_type='corrupt' AND c.evolution_origin_txid=fact.evolution_origin_txid
      ) OR NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact p WHERE p.eval_job_id=job.id
         AND p.fact_type='cleanup_pending'
         AND p.evolution_origin_txid=fact.evolution_origin_txid
      )
    ) THEN
      RAISE EXCEPTION 'quarantine intent must be atomic with corrupt evidence and cleanup intent'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='unavailable_at_deadline' THEN
      IF clock_timestamp()<job.deadline_at OR NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact c WHERE c.eval_job_id=job.id
         AND c.fact_type='cleanup_pending'
         AND c.evolution_origin_txid=fact.evolution_origin_txid
      ) THEN
        RAISE EXCEPTION 'unavailable evidence requires Core deadline and atomic cleanup intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='expired' THEN
      IF frozen.id IS NULL OR fact.manifest_hash<>frozen.manifest_hash
         OR frozen.evolution_origin_txid=fact.evolution_origin_txid
         OR EXISTS (
           SELECT 1 FROM evolution_eval_evidence_fact acknowledged
            WHERE acknowledged.eval_job_id=job.id
              AND acknowledged.fact_type='acknowledged'
         )
         OR run_state NOT IN ('succeeded','failed','cancelled','timeout')
         OR run_end_time IS NULL OR clock_timestamp()<run_end_time+interval '7 days'
         OR NOT EXISTS (
           SELECT 1 FROM evolution_eval_evidence_fact c WHERE c.eval_job_id=job.id
            AND c.fact_type='cleanup_pending'
            AND c.evolution_origin_txid=fact.evolution_origin_txid
         ) THEN
        RAISE EXCEPTION 'evidence expiry requires prior unacknowledged frozen evidence, terminal plus 7 days, and atomic cleanup intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='cleanup_pending' AND NOT EXISTS (
      SELECT 1 FROM evolution_eval_evidence_fact prior WHERE prior.eval_job_id=job.id
       AND prior.fact_type IN ('acknowledged','corrupt','unavailable_at_deadline','expired')
       AND (
         prior.fact_type<>'acknowledged'
         OR prior.evolution_origin_txid<>fact.evolution_origin_txid
       )
    ) THEN
      RAISE EXCEPTION 'cleanup intent requires acknowledged or abnormal evidence terminal fact'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='cleaned' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='cleanup_pending';
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'cleaned evidence requires a previously committed cleanup intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM evolution_eval_evidence_fact f WHERE f.eval_job_id=job.id AND f.fact_type='expired')
     AND EXISTS (SELECT 1 FROM evolution_eval_evidence_fact f WHERE f.eval_job_id=job.id AND f.fact_type='acknowledged') THEN
    RAISE EXCEPTION 'evolution eval retention cannot be both acknowledged and expired'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_evidence_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_evidence(COALESCE(NEW.eval_job_id,OLD.eval_job_id));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_evidence_fact_commit_guard ON evolution_eval_evidence_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_evidence_fact_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_evidence_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_evidence_commit();
DROP TRIGGER IF EXISTS evolution_eval_evidence_entry_commit_guard ON evolution_eval_evidence_entry;
CREATE CONSTRAINT TRIGGER evolution_eval_evidence_entry_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_evidence_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_evidence_commit();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_idempotency_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval idempotency rejects delete' USING ERRCODE='55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.scope IS DISTINCT FROM NEW.scope
     OR OLD.curator_run_id IS DISTINCT FROM NEW.curator_run_id
     OR OLD.eval_job_id IS DISTINCT FROM NEW.eval_job_id OR OLD.action IS DISTINCT FROM NEW.action
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.response IS NOT NULL OR OLD.response_status IS NOT NULL OR OLD.completed_at IS NOT NULL
     OR NEW.response IS NULL OR NEW.response_status IS NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'evolution eval idempotency permits exactly one incomplete-to-complete mutation'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_idempotency_mutation_guard ON evolution_eval_idempotency;
CREATE TRIGGER evolution_eval_idempotency_mutation_guard BEFORE UPDATE OR DELETE
  ON evolution_eval_idempotency FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_idempotency_mutation();

-- Immutable facts.  The two mutable projections above have dedicated guards.
DROP TRIGGER IF EXISTS evolution_eval_input_append_only ON evolution_eval_input;
CREATE TRIGGER evolution_eval_input_append_only BEFORE UPDATE OR DELETE ON evolution_eval_input
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_input_file_append_only ON evolution_eval_input_file;
CREATE TRIGGER evolution_eval_input_file_append_only BEFORE UPDATE OR DELETE ON evolution_eval_input_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_input_skill_file_append_only ON evolution_eval_input_skill_file;
CREATE TRIGGER evolution_eval_input_skill_file_append_only BEFORE UPDATE OR DELETE ON evolution_eval_input_skill_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_workspace_append_only ON evolution_eval_workspace;
CREATE TRIGGER evolution_eval_workspace_append_only BEFORE UPDATE OR DELETE ON evolution_eval_workspace
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_workspace_revision_append_only ON evolution_eval_workspace_revision;
CREATE TRIGGER evolution_eval_workspace_revision_append_only BEFORE UPDATE OR DELETE ON evolution_eval_workspace_revision
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_workspace_file_append_only ON evolution_eval_workspace_file;
CREATE TRIGGER evolution_eval_workspace_file_append_only BEFORE UPDATE OR DELETE ON evolution_eval_workspace_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_dispatch_append_only ON evolution_eval_dispatch;
CREATE TRIGGER evolution_eval_dispatch_append_only BEFORE UPDATE OR DELETE ON evolution_eval_dispatch
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_dispatch_tombstone_append_only ON evolution_eval_dispatch_tombstone;
CREATE TRIGGER evolution_eval_dispatch_tombstone_append_only BEFORE UPDATE OR DELETE ON evolution_eval_dispatch_tombstone
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_evidence_fact_append_only ON evolution_eval_evidence_fact;
CREATE TRIGGER evolution_eval_evidence_fact_append_only BEFORE UPDATE OR DELETE ON evolution_eval_evidence_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_evidence_entry_append_only ON evolution_eval_evidence_entry;
CREATE TRIGGER evolution_eval_evidence_entry_append_only BEFORE UPDATE OR DELETE ON evolution_eval_evidence_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_audit_event_append_only ON evolution_eval_audit_event;
CREATE TRIGGER evolution_eval_audit_event_append_only BEFORE UPDATE OR DELETE ON evolution_eval_audit_event
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_transition_fact_append_only ON evolution_eval_transition_fact;
CREATE TRIGGER evolution_eval_transition_fact_append_only BEFORE UPDATE OR DELETE ON evolution_eval_transition_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_unknown_fact_append_only ON evolution_eval_unknown_fact;
CREATE TRIGGER evolution_eval_unknown_fact_append_only BEFORE UPDATE OR DELETE ON evolution_eval_unknown_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_operation_fact_append_only ON evolution_eval_operation_fact;
CREATE TRIGGER evolution_eval_operation_fact_append_only BEFORE UPDATE OR DELETE ON evolution_eval_operation_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

INSERT INTO schema_migrations(version)
  VALUES ('0022_evolution_eval')
  ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS evolution_eval_reconcile_fact (
    id                       text PRIMARY KEY,
    eval_job_id              text NOT NULL REFERENCES evolution_eval_job(id),
    reconciliation_sequence  integer NOT NULL CHECK (reconciliation_sequence > 0),
    reconcile_request_hash   text NOT NULL CHECK (reconcile_request_hash ~ '^[0-9a-f]{64}$'),
    workspace_id             text NOT NULL,
    workspace_revision       integer NOT NULL CHECK (workspace_revision > 0),
    workspace_manifest_hash  text NOT NULL CHECK (workspace_manifest_hash ~ '^[0-9a-f]{64}$'),
    audit_event_id           text NOT NULL UNIQUE REFERENCES evolution_eval_audit_event(id)
                               DEFERRABLE INITIALLY DEFERRED,
    outbox_event_id          uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                               DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid    bigint NOT NULL DEFAULT txid_current(),
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (eval_job_id,reconciliation_sequence),
    UNIQUE (eval_job_id,reconcile_request_hash),
    UNIQUE (id,eval_job_id),
    FOREIGN KEY (eval_job_id,workspace_id)
      REFERENCES evolution_eval_job(id,workspace_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (workspace_id,workspace_revision,workspace_manifest_hash)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision,manifest_hash)
      DEFERRABLE INITIALLY DEFERRED
);

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_reconcile_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  bound_curator_run_id text;
  stable_state text;
  expected_sequence integer;
BEGIN
  SELECT j.curator_run_id INTO bound_curator_run_id
    FROM evolution_eval_job j WHERE j.id=NEW.eval_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval reconcile intent requires its authoritative run lock'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM evolution_eval_run r
   WHERE r.curator_run_id=bound_curator_run_id FOR UPDATE;
  SELECT j.* INTO job FROM evolution_eval_job j
   WHERE j.id=NEW.eval_job_id AND j.curator_run_id=bound_curator_run_id FOR UPDATE;
  IF NOT FOUND OR job.workspace_id<>NEW.workspace_id THEN
    RAISE EXCEPTION 'evolution eval reconcile intent requires its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  SELECT state::text INTO stable_state FROM tool_run WHERE id=job.tool_run_id FOR UPDATE;
  IF NOT (stable_state='running' OR (
    stable_state='submitted' AND EXISTS (
      SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=job.id
    )
  )) THEN
    RAISE EXCEPTION 'evolution eval reconcile intent requires an in-flight dispatched job'
      USING ERRCODE='23514';
  END IF;
  IF job.reconciliation_state='required' THEN
    RAISE EXCEPTION 'evolution eval reconcile intent already required' USING ERRCODE='23505';
  END IF;
  SELECT COALESCE(max(f.reconciliation_sequence),0)+1 INTO expected_sequence
    FROM evolution_eval_reconcile_fact f WHERE f.eval_job_id=job.id;
  IF NEW.reconciliation_sequence<>expected_sequence THEN
    RAISE EXCEPTION 'evolution eval reconcile intent sequence must be contiguous'
      USING ERRCODE='23514';
  END IF;
  NEW.evolution_origin_txid=txid_current();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_reconcile_insert_guard ON evolution_eval_reconcile_fact;
CREATE TRIGGER evolution_eval_reconcile_insert_guard
  BEFORE INSERT ON evolution_eval_reconcile_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_reconcile_insert();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval job rejects delete' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(OLD)-'reconciliation_state') IS DISTINCT FROM
     (to_jsonb(NEW)-'reconciliation_state') THEN
    RAISE EXCEPTION 'evolution eval immutable job binding cannot change' USING ERRCODE='55000';
  END IF;
  IF OLD.reconciliation_state IS DISTINCT FROM NEW.reconciliation_state THEN
    IF NEW.reconciliation_state='required'
       AND OLD.reconciliation_state IN ('not_needed','confirmed')
       AND EXISTS (
         SELECT 1 FROM evolution_eval_reconcile_fact f
          WHERE f.eval_job_id=NEW.id AND f.evolution_origin_txid=txid_current()
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'unsupported evolution eval reconciliation transition'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_job_mutation_guard ON evolution_eval_job;
CREATE TRIGGER evolution_eval_job_mutation_guard
  BEFORE UPDATE OR DELETE ON evolution_eval_job
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_job_mutation();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_reconcile(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  tool_correlation text;
  fact evolution_eval_reconcile_fact%ROWTYPE;
  revision_row evolution_eval_workspace_revision%ROWTYPE;
  audit evolution_eval_audit_event%ROWTYPE;
  event outbox_events%ROWTYPE;
  fact_count integer;
  max_sequence integer;
  expected_payload jsonb;
BEGIN
  SELECT * INTO job FROM evolution_eval_job WHERE id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT correlation_id INTO tool_correlation FROM tool_run WHERE id=job.tool_run_id;
  SELECT count(*)::integer,max(reconciliation_sequence)::integer
    INTO fact_count,max_sequence FROM evolution_eval_reconcile_fact
   WHERE eval_job_id=job.id;
  IF fact_count<>COALESCE(max_sequence,0) THEN
    RAISE EXCEPTION 'evolution eval reconcile intents must be a contiguous sequence'
      USING ERRCODE='23514';
  END IF;
  IF job.reconciliation_state='required' AND fact_count=0 THEN
    RAISE EXCEPTION 'evolution eval reconcile required projection needs a typed intent'
      USING ERRCODE='23514';
  END IF;
  FOR fact IN SELECT * FROM evolution_eval_reconcile_fact
    WHERE eval_job_id=job.id ORDER BY reconciliation_sequence LOOP
    SELECT r.* INTO revision_row FROM evolution_eval_workspace_revision r
     WHERE r.workspace_id=fact.workspace_id AND r.revision=fact.workspace_revision;
    SELECT * INTO audit FROM evolution_eval_audit_event WHERE id=fact.audit_event_id;
    SELECT * INTO event FROM outbox_events WHERE event_id=fact.outbox_event_id;
    expected_payload=jsonb_build_object(
      'fact_id',fact.id,'reconcile_request_hash',fact.reconcile_request_hash,
      'reconciliation_sequence',fact.reconciliation_sequence,
      'connector_job_id',job.connector_job_id,
      'connector_idempotency_key',job.connector_idempotency_key,
      'workspace_id',fact.workspace_id,'workspace_revision',fact.workspace_revision,
      'workspace_manifest_hash',fact.workspace_manifest_hash
    );
    IF revision_row.workspace_id IS NULL OR audit.id IS NULL OR event.event_id IS NULL
       OR fact.evolution_origin_txid<>audit.evolution_origin_txid
       OR fact.evolution_origin_txid<>event.evolution_origin_txid
       OR audit.eval_job_id IS DISTINCT FROM job.id
       OR audit.curator_run_id IS DISTINCT FROM job.curator_run_id
       OR audit.project_id IS DISTINCT FROM job.project_id
       OR audit.correlation_id IS DISTINCT FROM tool_correlation
       OR audit.event_type IS DISTINCT FROM 'reconcile_required'
       OR audit.operation IS DISTINCT FROM job.operation
       OR audit.from_state IS NOT NULL OR audit.to_state IS NOT NULL
       OR audit.request_hash IS DISTINCT FROM fact.reconcile_request_hash
       OR audit.workspace_manifest_hash IS DISTINCT FROM fact.workspace_manifest_hash
       OR audit.evidence_manifest_hash IS NOT NULL OR audit.error_code IS NOT NULL
       OR audit.file_count IS DISTINCT FROM revision_row.file_count
       OR audit.byte_count IS DISTINCT FROM revision_row.total_bytes
       OR event.aggregate_type IS DISTINCT FROM 'evolution_eval_job'
       OR event.aggregate_id IS DISTINCT FROM job.id
       OR event.event_type IS DISTINCT FROM 'evolution_eval.reconcile_requested'
       OR event.project_id IS DISTINCT FROM job.project_id
       OR event.correlation_id IS DISTINCT FROM tool_correlation
       OR event.headers IS DISTINCT FROM '{}'::jsonb OR event.causation_id IS NOT NULL
       OR event.classification IS DISTINCT FROM 'D1'
       OR event.payload IS DISTINCT FROM expected_payload THEN
      RAISE EXCEPTION 'evolution eval reconcile fact requires same-transaction exact audit/outbox'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_reconcile_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_reconcile(COALESCE(NEW.eval_job_id,OLD.eval_job_id));
  RETURN NULL;
END;
$$;
CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_reconcile_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_reconcile(COALESCE(NEW.id,OLD.id));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_reconcile_commit_guard ON evolution_eval_reconcile_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_reconcile_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_reconcile_fact
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_reconcile_commit();
DROP TRIGGER IF EXISTS evolution_eval_job_reconcile_commit_guard ON evolution_eval_job;
CREATE CONSTRAINT TRIGGER evolution_eval_job_reconcile_commit_guard
  AFTER UPDATE OF reconciliation_state ON evolution_eval_job
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_job_reconcile_commit();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_audit(target_audit_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  audit evolution_eval_audit_event%ROWTYPE;
  job evolution_eval_job%ROWTYPE;
  tool_correlation text;
  reference_count integer;
BEGIN
  SELECT * INTO audit FROM evolution_eval_audit_event WHERE id=target_audit_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF audit.eval_job_id IS NULL THEN
    RAISE EXCEPTION 'evolution eval audit must be owned by a typed job fact'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO job FROM evolution_eval_job WHERE id=audit.eval_job_id;
  SELECT correlation_id INTO tool_correlation FROM tool_run WHERE id=job.tool_run_id;
  IF job.id IS NULL OR audit.curator_run_id<>job.curator_run_id
     OR audit.project_id<>job.project_id OR audit.correlation_id<>tool_correlation THEN
    RAISE EXCEPTION 'evolution eval audit project/correlation binding mismatch'
      USING ERRCODE='23514';
  END IF;
  SELECT
    (SELECT count(*) FROM evolution_eval_transition_fact t WHERE t.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_dispatch d WHERE d.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_dispatch_tombstone t WHERE t.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_evidence_fact e WHERE e.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_operation_fact f WHERE f.audit_event_id=audit.id)
    +(SELECT count(*) FROM evolution_eval_reconcile_fact r WHERE r.audit_event_id=audit.id)
    INTO reference_count;
  IF reference_count<>1 THEN
    RAISE EXCEPTION 'evolution eval audit must have exactly one typed reverse owner'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.audit_event_id=audit.id) THEN
    PERFORM synthia_assert_evolution_eval_job(job.id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.audit_event_id=audit.id)
     OR EXISTS (SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.audit_event_id=audit.id) THEN
    PERFORM synthia_assert_evolution_eval_workspace(job.workspace_id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_evidence_fact e WHERE e.audit_event_id=audit.id) THEN
    PERFORM synthia_assert_evolution_eval_evidence(job.id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_reconcile_fact r WHERE r.audit_event_id=audit.id) THEN
    PERFORM synthia_assert_evolution_eval_reconcile(job.id);
  ELSE
    PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_outbox(target_event_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  event outbox_events%ROWTYPE;
  job evolution_eval_job%ROWTYPE;
  reference_count integer;
BEGIN
  SELECT * INTO event FROM outbox_events WHERE event_id=target_event_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT
    (SELECT count(*) FROM evolution_eval_transition_fact t WHERE t.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_dispatch d WHERE d.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_dispatch_tombstone t WHERE t.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_evidence_fact e WHERE e.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_operation_fact f WHERE f.outbox_event_id=event.event_id)
    +(SELECT count(*) FROM evolution_eval_reconcile_fact r WHERE r.outbox_event_id=event.event_id)
    INTO reference_count;
  IF event.aggregate_type<>'evolution_eval_job'
     OR event.event_type !~ '^evolution_eval\.' OR reference_count<>1 THEN
    RAISE EXCEPTION 'evolution eval outbox must have exact aggregate/type and one reverse owner'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO job FROM evolution_eval_job WHERE id=event.aggregate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval outbox aggregate job does not exist'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.outbox_event_id=event.event_id) THEN
    PERFORM synthia_assert_evolution_eval_job(job.id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.outbox_event_id=event.event_id)
     OR EXISTS (SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.outbox_event_id=event.event_id) THEN
    PERFORM synthia_assert_evolution_eval_workspace(job.workspace_id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_evidence_fact e WHERE e.outbox_event_id=event.event_id) THEN
    PERFORM synthia_assert_evolution_eval_evidence(job.id);
  ELSIF EXISTS (SELECT 1 FROM evolution_eval_reconcile_fact r WHERE r.outbox_event_id=event.event_id) THEN
    PERFORM synthia_assert_evolution_eval_reconcile(job.id);
  ELSE
    PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_reconcile_append_only ON evolution_eval_reconcile_fact;
CREATE TRIGGER evolution_eval_reconcile_append_only
  BEFORE UPDATE OR DELETE ON evolution_eval_reconcile_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

INSERT INTO schema_migrations(version)
  VALUES ('0023_evolution_eval_r1_hardening')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

BEGIN;

ALTER TABLE curator_evaluation
  ADD COLUMN IF NOT EXISTS eval_job_refs jsonb NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname='curator_evaluation_eval_job_refs_shape'
       AND conrelid='curator_evaluation'::regclass
  ) THEN
    ALTER TABLE curator_evaluation
      ADD CONSTRAINT curator_evaluation_eval_job_refs_shape CHECK (
        jsonb_typeof(eval_job_refs)='array'
        AND jsonb_array_length(eval_job_refs)<=3
      );
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_curator_evaluation_eval_job_refs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ref jsonb;
  expected_count integer;
  actual_count integer := 0;
  ref_job evolution_eval_job%ROWTYPE;
  expected_manifest_hash text;
  ref_manifest_hash text;
BEGIN
  IF jsonb_typeof(NEW.eval_job_refs)<>'array' OR jsonb_array_length(NEW.eval_job_refs)>3 THEN
    RAISE EXCEPTION 'curator evaluation eval_job_refs must be a bounded array'
      USING ERRCODE='23514';
  END IF;
  SELECT count(*)::integer INTO expected_count
    FROM evolution_eval_job j
   WHERE j.curator_run_id=NEW.curator_run_id AND j.application_id=NEW.application_id;
  IF jsonb_array_length(NEW.eval_job_refs)<>expected_count THEN
    RAISE EXCEPTION 'curator evaluation eval_job_refs must exactly cover application jobs'
      USING ERRCODE='23514';
  END IF;
  FOR ref IN SELECT value FROM jsonb_array_elements(NEW.eval_job_refs) LOOP
    IF jsonb_typeof(ref)<>'object'
       OR (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(ref) key)
          IS DISTINCT FROM ARRAY['eval_job_id','evidence_manifest_hash','tool_run_id']::text[]
       OR jsonb_typeof(ref->'eval_job_id')<>'string'
       OR jsonb_typeof(ref->'tool_run_id')<>'string'
       OR NOT (ref->'evidence_manifest_hash'='null'::jsonb
               OR jsonb_typeof(ref->'evidence_manifest_hash')='string') THEN
      RAISE EXCEPTION 'curator evaluation eval_job_ref shape is invalid'
        USING ERRCODE='23514';
    END IF;
    SELECT * INTO ref_job FROM evolution_eval_job j
     WHERE j.id=ref->>'eval_job_id'
       AND j.tool_run_id=ref->>'tool_run_id'
       AND j.curator_run_id=NEW.curator_run_id
       AND j.application_id=NEW.application_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'curator evaluation eval_job_ref binding mismatch'
        USING ERRCODE='23514';
    END IF;
    SELECT f.manifest_hash INTO expected_manifest_hash
      FROM evolution_eval_evidence_fact f
     WHERE f.eval_job_id=ref_job.id AND f.fact_type='frozen';
    ref_manifest_hash=CASE WHEN ref->'evidence_manifest_hash'='null'::jsonb
      THEN NULL ELSE ref->>'evidence_manifest_hash' END;
    IF ref_manifest_hash IS DISTINCT FROM expected_manifest_hash THEN
      RAISE EXCEPTION 'curator evaluation eval_job_ref evidence hash mismatch'
        USING ERRCODE='23514';
    END IF;
    actual_count=actual_count+1;
  END LOOP;
  IF actual_count<>(SELECT count(DISTINCT item.value->>'eval_job_id')
                       FROM jsonb_array_elements(NEW.eval_job_refs) AS item(value))
     OR actual_count<>(SELECT count(DISTINCT item.value->>'tool_run_id')
                         FROM jsonb_array_elements(NEW.eval_job_refs) AS item(value)) THEN
    RAISE EXCEPTION 'curator evaluation eval_job_refs must be unique'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_job j
     JOIN tool_run tool ON tool.id=j.tool_run_id
    WHERE j.curator_run_id=NEW.curator_run_id AND j.application_id=NEW.application_id
      AND (
        tool.state='unknown_effect'
        OR EXISTS (
          SELECT 1 FROM evolution_eval_evidence_fact fact
           WHERE fact.eval_job_id=j.id
             AND fact.fact_type IN ('corrupt','unavailable_at_deadline')
        )
      )
  ) AND NEW.outcome<>'inconclusive' THEN
    RAISE EXCEPTION 'unknown or unusable eval evidence forces inconclusive evaluation'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS curator_evaluation_eval_job_refs_guard ON curator_evaluation;
CREATE TRIGGER curator_evaluation_eval_job_refs_guard
  BEFORE INSERT ON curator_evaluation
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_curator_evaluation_eval_job_refs();

-- Generic P4/legacy evidence and delivery relations are authoritative surfaces.
-- Evolution-eval facts have a separate schema and may never be copied into them.
CREATE OR REPLACE FUNCTION synthia_reject_evolution_eval_authority_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_tool_run_id text;
BEGIN
  IF TG_TABLE_NAME='tool_run_evidence_manifest' THEN
    target_tool_run_id=NEW.tool_run_id;
  ELSIF TG_TABLE_NAME='tool_run_evidence_entry' THEN
    target_tool_run_id=NEW.tool_run_id;
  ELSIF TG_TABLE_NAME='bitstream_result' THEN
    target_tool_run_id=NEW.tool_run_id;
  ELSIF TG_TABLE_NAME='evidence' THEN
    target_tool_run_id=NEW.tool_run_id;
  ELSIF TG_TABLE_NAME='delivery_release_item' THEN
    IF NEW.source_type LIKE 'evolution_eval%'
       OR EXISTS (SELECT 1 FROM evolution_eval_job j WHERE j.id=NEW.source_id OR j.tool_run_id=NEW.source_id)
       OR EXISTS (SELECT 1 FROM evolution_eval_evidence_entry e WHERE e.id=NEW.source_id) THEN
      RAISE EXCEPTION 'evolution eval evidence cannot enter delivery authority'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM tool_run r
     WHERE r.id=target_tool_run_id AND r.run_class='evolution_eval'
  ) THEN
    RAISE EXCEPTION 'evolution eval ToolRun cannot enter generic/formal evidence authority'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_generic_manifest_reject ON tool_run_evidence_manifest;
CREATE TRIGGER evolution_eval_generic_manifest_reject
  BEFORE INSERT ON tool_run_evidence_manifest
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_evolution_eval_authority_projection();
DROP TRIGGER IF EXISTS evolution_eval_generic_entry_reject ON tool_run_evidence_entry;
CREATE TRIGGER evolution_eval_generic_entry_reject
  BEFORE INSERT ON tool_run_evidence_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_evolution_eval_authority_projection();
DROP TRIGGER IF EXISTS evolution_eval_generic_evidence_reject ON evidence;
CREATE TRIGGER evolution_eval_generic_evidence_reject
  BEFORE INSERT ON evidence
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_evolution_eval_authority_projection();
DROP TRIGGER IF EXISTS evolution_eval_bitstream_authority_reject ON bitstream_result;
CREATE TRIGGER evolution_eval_bitstream_authority_reject
  BEFORE INSERT ON bitstream_result
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_evolution_eval_authority_projection();
DROP TRIGGER IF EXISTS evolution_eval_delivery_authority_reject ON delivery_release_item;
CREATE TRIGGER evolution_eval_delivery_authority_reject
  BEFORE INSERT ON delivery_release_item
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_evolution_eval_authority_projection();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_run_terminal(target_run_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  curator_state text;
  has_eval_run boolean;
  eval_completed_at timestamptz;
BEGIN
  SELECT state INTO curator_state FROM curator_run WHERE id=target_run_id;
  SELECT true,completed_at INTO has_eval_run,eval_completed_at
    FROM evolution_eval_run WHERE curator_run_id=target_run_id;
  IF COALESCE(has_eval_run,false)=false THEN
    RETURN;
  END IF;
  IF curator_state IN ('completed','failed') AND eval_completed_at IS NULL THEN
    RAISE EXCEPTION 'terminal Curator run requires completed evolution eval budget fact'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_run_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='curator_run' THEN
    PERFORM synthia_assert_evolution_eval_run_terminal(COALESCE(NEW.id,OLD.id));
  ELSE
    PERFORM synthia_assert_evolution_eval_run_terminal(
      COALESCE(NEW.curator_run_id,OLD.curator_run_id)
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_curator_terminal_guard ON curator_run;
CREATE CONSTRAINT TRIGGER evolution_eval_curator_terminal_guard
  AFTER UPDATE OF state ON curator_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_run_terminal();
DROP TRIGGER IF EXISTS evolution_eval_budget_terminal_guard ON evolution_eval_run;
CREATE CONSTRAINT TRIGGER evolution_eval_budget_terminal_guard
  AFTER INSERT OR UPDATE ON evolution_eval_run
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_run_terminal();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_retention_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id text;
BEGIN
  target_job_id=COALESCE(NEW.eval_job_id,OLD.eval_job_id);
  IF EXISTS (
    SELECT 1 FROM evolution_eval_evidence_fact expired
     WHERE expired.eval_job_id=target_job_id AND expired.fact_type='expired'
  ) AND EXISTS (
    SELECT 1 FROM evolution_eval_evidence_fact ack
     WHERE ack.eval_job_id=target_job_id
       AND ack.fact_type='acknowledged'
  ) THEN
    RAISE EXCEPTION 'expired evolution eval evidence cannot be acknowledged'
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_retention_terminal_guard
  ON evolution_eval_evidence_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_retention_terminal_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_evidence_fact
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_retention_terminal();


-- R2 tombstones serve both the pre-effect rejection fence and the durable
-- cancel/deadline intent after a dispatch has become effect-possible. Keep
-- every R1 integrity check while admitting only those explicit projections.
CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_workspace(target_workspace_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  workspace evolution_eval_workspace%ROWTYPE;
  job evolution_eval_job%ROWTYPE;
  projection evolution_eval_workspace_projection%ROWTYPE;
  revision_row evolution_eval_workspace_revision%ROWTYPE;
  dispatch evolution_eval_dispatch%ROWTYPE;
  tombstone evolution_eval_dispatch_tombstone%ROWTYPE;
  revision_count integer;
  max_revision integer;
  actual_files jsonb;
  actual_file_count integer;
  actual_total_bytes bigint;
  actual_source_files integer;
  actual_source_bytes bigint;
  actual_skill_files integer;
  actual_skill_bytes bigint;
  actual_overlay_files integer;
  actual_overlay_bytes bigint;
BEGIN
  SELECT * INTO workspace FROM evolution_eval_workspace WHERE id=target_workspace_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO job FROM evolution_eval_job WHERE id=workspace.eval_job_id;
  IF NOT FOUND OR job.workspace_id<>workspace.id OR job.eval_input_ref<>workspace.eval_input_ref
     OR job.input_manifest_hash<>workspace.input_manifest_hash THEN
    RAISE EXCEPTION 'evolution eval workspace/job binding mismatch' USING ERRCODE='23514';
  END IF;
  SELECT count(*)::integer,max(revision)::integer INTO revision_count,max_revision
    FROM evolution_eval_workspace_revision WHERE workspace_id=workspace.id;
  IF revision_count=0 OR max_revision<>revision_count THEN
    RAISE EXCEPTION 'evolution eval workspace revisions must start at 1 and increase by one'
      USING ERRCODE='23514';
  END IF;
  FOR revision_row IN SELECT * FROM evolution_eval_workspace_revision
    WHERE workspace_id=workspace.id ORDER BY revision LOOP
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'path',f.path,'sha256',f.sha256,'size_bytes',f.size_bytes,
             'media_type',f.media_type,'layer',f.layer,'read_only',f.read_only
           ) ORDER BY translate(f.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",
                      f.path COLLATE "C"),'[]'::jsonb),
           count(*)::integer,COALESCE(sum(f.size_bytes),0)::bigint,
           count(*) FILTER (WHERE f.layer='source')::integer,
           COALESCE(sum(f.size_bytes) FILTER (WHERE f.layer='source'),0)::bigint,
           count(*) FILTER (WHERE f.layer='skill')::integer,
           COALESCE(sum(f.size_bytes) FILTER (WHERE f.layer='skill'),0)::bigint,
           count(*) FILTER (WHERE f.layer='overlay')::integer,
           COALESCE(sum(f.size_bytes) FILTER (WHERE f.layer='overlay'),0)::bigint
      INTO actual_files,actual_file_count,actual_total_bytes,
           actual_source_files,actual_source_bytes,actual_skill_files,actual_skill_bytes,
           actual_overlay_files,actual_overlay_bytes
      FROM evolution_eval_workspace_file f
     WHERE f.workspace_id=workspace.id AND f.revision=revision_row.revision;
    IF EXISTS (
      SELECT 1 FROM evolution_eval_input_skill_file input_skill
       WHERE input_skill.eval_input_ref=workspace.eval_input_ref
         AND NOT EXISTS (
           SELECT 1 FROM evolution_eval_workspace_file workspace_skill
            WHERE workspace_skill.workspace_id=workspace.id
              AND workspace_skill.revision=revision_row.revision
              AND workspace_skill.layer='skill' AND workspace_skill.read_only=true
              AND workspace_skill.path=input_skill.path
              AND workspace_skill.sha256=input_skill.sha256
              AND workspace_skill.size_bytes=input_skill.size_bytes
              AND workspace_skill.media_type=input_skill.media_type
              AND workspace_skill.managed_content=convert_to(input_skill.content,'UTF8')
         )
    ) OR EXISTS (
      SELECT 1 FROM evolution_eval_workspace_file workspace_skill
       WHERE workspace_skill.workspace_id=workspace.id
         AND workspace_skill.revision=revision_row.revision
         AND workspace_skill.layer='skill'
         AND NOT EXISTS (
           SELECT 1 FROM evolution_eval_input_skill_file input_skill
            WHERE input_skill.eval_input_ref=workspace.eval_input_ref
              AND input_skill.path=workspace_skill.path
              AND input_skill.sha256=workspace_skill.sha256
              AND input_skill.size_bytes=workspace_skill.size_bytes
              AND input_skill.media_type=workspace_skill.media_type
              AND convert_to(input_skill.content,'UTF8')=workspace_skill.managed_content
         )
    ) THEN
      RAISE EXCEPTION 'evolution eval workspace skill layer must exactly match immutable skill input'
        USING ERRCODE='23514';
    END IF;
    IF revision_row.file_count<>actual_file_count
       OR revision_row.total_bytes<>actual_total_bytes
       OR revision_row.source_files<>actual_source_files
       OR revision_row.source_bytes<>actual_source_bytes
       OR revision_row.skill_files<>actual_skill_files
       OR revision_row.skill_bytes<>actual_skill_bytes
       OR revision_row.overlay_files<>actual_overlay_files
       OR revision_row.overlay_bytes<>actual_overlay_bytes
       OR revision_row.manifest IS DISTINCT FROM jsonb_build_object(
         'schema','evolution-eval-workspace-manifest.v1',
         'workspace_id',workspace.id,'revision',revision_row.revision,'files',actual_files
       ) THEN
      RAISE EXCEPTION 'evolution eval workspace manifest/child totals mismatch'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  SELECT * INTO projection FROM evolution_eval_workspace_projection
    WHERE workspace_id=workspace.id;
  IF NOT FOUND OR projection.current_revision<>max_revision THEN
    RAISE EXCEPTION 'evolution eval workspace projection must point at the latest revision'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO dispatch FROM evolution_eval_dispatch WHERE eval_job_id=job.id;
  IF FOUND THEN
    PERFORM synthia_assert_evolution_eval_dispatch_parameters(job.id);
    IF projection.sealed_at IS NULL
       OR dispatch.workspace_id<>workspace.id
       OR dispatch.workspace_revision<>projection.current_revision
       OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_workspace_revision r
          WHERE r.workspace_id=workspace.id AND r.revision=projection.current_revision
            AND r.manifest_hash=dispatch.workspace_manifest_hash
       )
       OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_audit_event a
          WHERE a.id=dispatch.audit_event_id AND a.eval_job_id=job.id
            AND a.curator_run_id=job.curator_run_id AND a.project_id=job.project_id
            AND a.event_type='dispatch_sealed' AND a.from_state IS NULL AND a.to_state IS NULL
            AND a.correlation_id=(SELECT correlation_id FROM tool_run WHERE id=job.tool_run_id)
            AND a.operation=job.operation
            AND a.request_hash=dispatch.dispatch_request_hash
            AND a.workspace_manifest_hash=dispatch.workspace_manifest_hash
            AND a.evidence_manifest_hash IS NULL AND a.file_count IS NULL
            AND a.byte_count IS NULL AND a.error_code IS NULL
       )
       OR NOT EXISTS (
         SELECT 1 FROM outbox_events o
          WHERE o.event_id=dispatch.outbox_event_id
            AND o.aggregate_type='evolution_eval_job' AND o.aggregate_id=job.id
            AND o.event_type='evolution_eval.dispatch_requested'
            AND o.project_id=job.project_id
            AND o.correlation_id=(SELECT correlation_id FROM tool_run WHERE id=job.tool_run_id)
            AND o.headers='{}'::jsonb AND o.causation_id IS NULL
            AND o.classification='D1'
            AND o.payload=jsonb_build_object('dispatch_request_hash',dispatch.dispatch_request_hash)
       ) OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_dispatch d
         JOIN evolution_eval_audit_event a ON a.id=d.audit_event_id
         JOIN outbox_events o ON o.event_id=d.outbox_event_id
         WHERE d.eval_job_id=job.id
           AND d.evolution_origin_txid=a.evolution_origin_txid
           AND d.evolution_origin_txid=o.evolution_origin_txid
       ) THEN
      RAISE EXCEPTION 'evolution eval dispatch must atomically seal current revision with audit/outbox'
        USING ERRCODE='23514';
    END IF;
  ELSIF projection.sealed_at IS NOT NULL THEN
    RAISE EXCEPTION 'evolution eval workspace cannot seal without a dispatch fact'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO tombstone FROM evolution_eval_dispatch_tombstone WHERE eval_job_id=job.id;
  IF FOUND THEN
    IF NOT (
         (
           EXISTS (
             SELECT 1 FROM tool_run r
              WHERE r.id=job.tool_run_id AND r.state='rejected'
           )
           AND EXISTS (
             SELECT 1 FROM evolution_eval_transition_fact t
              WHERE t.eval_job_id=job.id
                AND t.from_state='submitted' AND t.to_state='rejected'
           )
         )
         OR (
           EXISTS (
             SELECT 1 FROM tool_run r
              WHERE r.id=job.tool_run_id
                AND r.state IN ('running','cancelled','timeout','unknown_effect')
           )
           AND EXISTS (
             SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=job.id
           )
         )
       )
       OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_audit_event a
          WHERE a.id=tombstone.audit_event_id AND a.eval_job_id=job.id
            AND a.curator_run_id=job.curator_run_id AND a.project_id=job.project_id
            AND a.event_type='dispatch_tombstone' AND a.from_state IS NULL AND a.to_state IS NULL
            AND a.correlation_id=(SELECT correlation_id FROM tool_run WHERE id=job.tool_run_id)
            AND a.operation=job.operation
            AND a.request_hash=tombstone.error_hash
            AND a.workspace_manifest_hash IS NULL AND a.evidence_manifest_hash IS NULL
            AND a.file_count IS NULL AND a.byte_count IS NULL
            AND a.error_code=tombstone.reason_code
       )
       OR NOT EXISTS (
         SELECT 1 FROM outbox_events o
          WHERE o.event_id=tombstone.outbox_event_id
            AND o.aggregate_type='evolution_eval_job' AND o.aggregate_id=job.id
            AND o.event_type='evolution_eval.dispatch_tombstoned'
            AND o.project_id=job.project_id
            AND o.correlation_id=(SELECT correlation_id FROM tool_run WHERE id=job.tool_run_id)
            AND o.headers='{}'::jsonb AND o.causation_id IS NULL
            AND o.classification='D1'
            AND o.payload=jsonb_build_object('error_hash',tombstone.error_hash)
       ) OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_dispatch_tombstone t
         JOIN evolution_eval_audit_event a ON a.id=t.audit_event_id
         JOIN outbox_events o ON o.event_id=t.outbox_event_id
         WHERE t.eval_job_id=job.id
           AND t.evolution_origin_txid=a.evolution_origin_txid
           AND t.evolution_origin_txid=o.evolution_origin_txid
       ) THEN
      RAISE EXCEPTION 'evolution eval tombstone must win the pre-effect fence with audit/outbox'
        USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
END;
$$;

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_job(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  run_row tool_run%ROWTYPE;
  transition evolution_eval_transition_fact%ROWTYPE;
  audit evolution_eval_audit_event%ROWTYPE;
  unknown_fact evolution_eval_unknown_fact%ROWTYPE;
  expected_state text := 'submitted';
  expected_sequence integer := 1;
  transition_count integer := 0;
  expected_outbox_type text;
  expected_outbox_payload jsonb;
BEGIN
  SELECT * INTO job FROM evolution_eval_job WHERE id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO run_row FROM tool_run WHERE id=job.tool_run_id;
  IF NOT FOUND OR run_row.run_class::text<>'evolution_eval' OR run_row.project_id<>job.project_id
     OR run_row.operation<>job.operation OR run_row.input_manifest_hash<>job.input_manifest_hash THEN
    RAISE EXCEPTION 'evolution eval job must have exactly one matching ToolRun' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM evolution_eval_job WHERE tool_run_id=job.tool_run_id)<>1 THEN
    RAISE EXCEPTION 'evolution eval ToolRun/job binding must be one-to-one' USING ERRCODE='23514';
  END IF;
  IF run_row.state::text IN ('queued','preparing','cancelling','lost') THEN
    RAISE EXCEPTION 'evolution eval ToolRun has no commit-stable projection for this state'
      USING ERRCODE='23514';
  END IF;
  FOR transition IN SELECT * FROM evolution_eval_transition_fact
    WHERE eval_job_id=job.id ORDER BY transition_sequence LOOP
    transition_count=transition_count+1;
    IF transition.transition_sequence<>expected_sequence OR transition.from_state::text<>expected_state THEN
      RAISE EXCEPTION 'evolution eval transition facts must be a contiguous chain from submitted'
        USING ERRCODE='23514';
    END IF;
    SELECT * INTO audit FROM evolution_eval_audit_event WHERE id=transition.audit_event_id;
    IF NOT FOUND OR audit.eval_job_id<>job.id OR audit.curator_run_id<>job.curator_run_id
       OR audit.project_id<>job.project_id OR audit.event_type<>'tool_run_transition'
       OR audit.correlation_id<>run_row.correlation_id
       OR audit.from_state IS DISTINCT FROM transition.from_state
       OR audit.to_state IS DISTINCT FROM transition.to_state OR audit.operation<>job.operation
       OR audit.request_hash IS NOT NULL OR audit.workspace_manifest_hash IS NOT NULL
       OR audit.evidence_manifest_hash IS NOT NULL OR audit.file_count IS NOT NULL
       OR audit.byte_count IS NOT NULL OR audit.error_code IS NOT NULL THEN
      RAISE EXCEPTION 'each evolution eval transition requires one exact audit fact'
        USING ERRCODE='23514';
    END IF;
    expected_outbox_type=CASE WHEN transition.to_state::text='unknown_effect'
      THEN 'evolution_eval.unknown_effect' ELSE 'evolution_eval.tool_run_transition' END;
    expected_outbox_payload=jsonb_build_object(
      'from_state',transition.from_state::text,'to_state',transition.to_state::text
    );
    IF transition.to_state::text='unknown_effect' THEN
      expected_outbox_payload=expected_outbox_payload||jsonb_build_object(
        'fact_hash',(SELECT u.fact_hash FROM evolution_eval_unknown_fact u
          WHERE u.eval_job_id=job.id)
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM outbox_events o WHERE o.event_id=transition.outbox_event_id
        AND o.aggregate_type='evolution_eval_job' AND o.aggregate_id=job.id
        AND o.event_type=expected_outbox_type
        AND o.project_id=job.project_id AND o.correlation_id=run_row.correlation_id
        AND o.headers='{}'::jsonb AND o.causation_id IS NULL AND o.classification='D1'
        AND o.payload=expected_outbox_payload
        AND o.evolution_origin_txid=transition.evolution_origin_txid
        AND o.evolution_origin_txid=audit.evolution_origin_txid
    ) THEN
      RAISE EXCEPTION 'each evolution eval transition requires one exact outbox fact'
        USING ERRCODE='23514';
    END IF;
    expected_state=transition.to_state::text;
    expected_sequence=expected_sequence+1;
  END LOOP;
  IF expected_state<>run_row.state::text
     OR (run_row.state::text='submitted' AND transition_count<>0)
     OR (run_row.state::text<>'submitted' AND transition_count=0) THEN
    RAISE EXCEPTION 'evolution eval ToolRun projection must equal its complete transition chain'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_audit_event a
     WHERE a.eval_job_id=job.id AND a.from_state IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.audit_event_id=a.id)
  ) THEN
    RAISE EXCEPTION 'evolution eval transition audit cannot be pre-seeded or orphaned'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO unknown_fact FROM evolution_eval_unknown_fact WHERE eval_job_id=job.id;
  IF run_row.state::text='unknown_effect' THEN
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_transition_fact t
       WHERE t.id=unknown_fact.transition_fact_id AND t.eval_job_id=job.id
         AND t.to_state='unknown_effect' AND t.audit_event_id=unknown_fact.audit_event_id
         AND t.outbox_event_id=unknown_fact.outbox_event_id
    ) OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_run r WHERE r.curator_run_id=job.curator_run_id
        AND r.unknown_effect_latched_at=unknown_fact.latched_at
    ) OR NOT EXISTS (
      SELECT 1 FROM outbox_events o WHERE o.event_id=unknown_fact.outbox_event_id
        AND o.event_type='evolution_eval.unknown_effect'
        AND o.payload->>'fact_hash'=unknown_fact.fact_hash
    ) OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_transition_fact t
      JOIN evolution_eval_audit_event a ON a.id=t.audit_event_id
      JOIN outbox_events o ON o.event_id=t.outbox_event_id
      JOIN evolution_eval_unknown_fact u ON u.transition_fact_id=t.id
      JOIN evolution_eval_run r ON r.curator_run_id=job.curator_run_id
       WHERE t.eval_job_id=job.id
         AND t.evolution_origin_txid=a.evolution_origin_txid
         AND t.evolution_origin_txid=o.evolution_origin_txid
         AND t.evolution_origin_txid=u.evolution_origin_txid
         AND t.evolution_origin_txid=r.unknown_effect_origin_txid
    ) THEN
      RAISE EXCEPTION 'unknown_effect requires atomic terminal/transition/audit/outbox/run-latch facts'
        USING ERRCODE='23514';
    END IF;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'unknown effect fact cannot be pre-seeded before its terminal state'
      USING ERRCODE='23514';
  END IF;
  IF run_row.state::text<>'submitted' AND NOT EXISTS (
    SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=job.id
  ) AND run_row.state::text<>'rejected' THEN
    RAISE EXCEPTION 'effect-possible evolution eval states require the durable dispatch fact'
      USING ERRCODE='23514';
  END IF;
  IF run_row.state::text='rejected' AND NOT EXISTS (
    SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.eval_job_id=job.id
  ) THEN
    RAISE EXCEPTION 'pre-effect rejection requires an immutable dispatch tombstone'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.eval_job_id=job.id
  ) AND NOT (
    run_row.state::text='rejected'
    OR (
      run_row.state::text IN ('running','cancelled','timeout','unknown_effect')
      AND EXISTS (
        SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=job.id
      )
    )
  ) THEN
    RAISE EXCEPTION 'dispatch tombstone requires a pre-effect rejection or durable effect-possible cancel projection'
      USING ERRCODE='23514';
  END IF;
  PERFORM synthia_assert_evolution_eval_parameters(job.id);
  PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
END;
$$;

INSERT INTO schema_migrations(version)
  VALUES ('0024_evolution_eval_r2_core')
  ON CONFLICT (version) DO NOTHING;

COMMIT;

BEGIN;

CREATE OR REPLACE FUNCTION synthia_is_evolution_eval_portable_path(candidate text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT octet_length(candidate) BETWEEN 1 AND 512
     AND candidate ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
     AND candidate !~ '(^|/)[^/]*\.(/|$)'
     AND translate(candidate,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
           !~ '(^|/)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|/|$)'
$$;

CREATE OR REPLACE FUNCTION synthia_are_evolution_eval_portable_paths(candidate jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(
    jsonb_typeof(candidate) = 'array'
    AND NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(candidate) = 'array' THEN candidate ELSE '[]'::jsonb END
        ) AS path(value)
       WHERE jsonb_typeof(path.value) <> 'string'
          OR NOT synthia_is_evolution_eval_portable_path(path.value #>> '{}')
    ),
    false
  )
$$;

ALTER TABLE evolution_eval_input_file
  DROP CONSTRAINT IF EXISTS evolution_eval_input_file_portable_path_check;
ALTER TABLE evolution_eval_input_file
  ADD CONSTRAINT evolution_eval_input_file_portable_path_check
  CHECK (synthia_is_evolution_eval_portable_path(path));

ALTER TABLE evolution_eval_input_skill_file
  DROP CONSTRAINT IF EXISTS evolution_eval_input_skill_file_portable_path_check;
ALTER TABLE evolution_eval_input_skill_file
  ADD CONSTRAINT evolution_eval_input_skill_file_portable_path_check
  CHECK (synthia_is_evolution_eval_portable_path(path));

ALTER TABLE evolution_eval_workspace_file
  DROP CONSTRAINT IF EXISTS evolution_eval_workspace_file_portable_path_check;
ALTER TABLE evolution_eval_workspace_file
  ADD CONSTRAINT evolution_eval_workspace_file_portable_path_check
  CHECK (synthia_is_evolution_eval_portable_path(path));

ALTER TABLE evolution_eval_job
  DROP CONSTRAINT IF EXISTS evolution_eval_job_parameter_paths_portable_check;
ALTER TABLE evolution_eval_job
  ADD CONSTRAINT evolution_eval_job_parameter_paths_portable_check CHECK (
    synthia_are_evolution_eval_portable_paths(parameters->'source_paths')
    AND (
      (operation = 'implement'
       AND synthia_are_evolution_eval_portable_paths(parameters->'constraint_paths'))
      OR (operation <> 'implement' AND (
        NOT (parameters ? 'constraint_paths')
        OR synthia_are_evolution_eval_portable_paths(parameters->'constraint_paths')
      ))
    )
  );

ALTER TABLE evolution_eval_evidence_fact
  ADD COLUMN IF NOT EXISTS connector_manifest_hash text
  CHECK (connector_manifest_hash IS NULL OR connector_manifest_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE evolution_eval_evidence_fact
  DROP CONSTRAINT IF EXISTS evolution_eval_evidence_connector_manifest_shape;
ALTER TABLE evolution_eval_evidence_fact
  ADD CONSTRAINT evolution_eval_evidence_connector_manifest_shape CHECK (
    (fact_type='frozen') = (connector_manifest_hash IS NOT NULL)
  );

CREATE TABLE IF NOT EXISTS evolution_eval_dispatcher_lease (
    event_id          uuid PRIMARY KEY REFERENCES outbox_events(event_id),
    event_type        text NOT NULL CHECK (event_type IN (
                        'evolution_eval.dispatch_requested',
                        'evolution_eval.reconcile_requested',
                        'evolution_eval.dispatch_tombstoned',
                        'evolution_eval.evidence.freeze_requested',
                        'evolution_eval.evidence.ack_requested',
                        'evolution_eval.evidence.quarantine_requested',
                        'evolution_eval.evidence.cleanup_requested'
                      )),
    aggregate_id      text NOT NULL,
    holder_id         text NOT NULL CHECK (
                        octet_length(holder_id) BETWEEN 1 AND 128
                        AND holder_id !~ '[[:cntrl:]]'
                      ),
    lease_nonce_hash  text NOT NULL UNIQUE CHECK (lease_nonce_hash ~ '^[0-9a-f]{64}$'),
    lease_expires_at  timestamptz NOT NULL,
    attempt_count     integer NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 1000000),
    claimed_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
      lease_expires_at > claimed_at
      AND lease_expires_at <= updated_at + interval '5 minutes'
    ),
    UNIQUE (event_id,lease_nonce_hash)
);

CREATE INDEX IF NOT EXISTS evolution_eval_dispatcher_lease_expiry_idx
  ON evolution_eval_dispatcher_lease(lease_expires_at,event_id);

CREATE TABLE IF NOT EXISTS evolution_eval_connector_observation (
    id                     uuid PRIMARY KEY,
    eval_job_id            text NOT NULL REFERENCES evolution_eval_job(id),
    outbox_event_id        uuid NOT NULL REFERENCES outbox_events(event_id),
    holder_id              text NOT NULL CHECK (
                               octet_length(holder_id) BETWEEN 1 AND 128
                               AND holder_id !~ '[[:cntrl:]]'
                             ),
    lease_nonce_hash       text NOT NULL CHECK (lease_nonce_hash ~ '^[0-9a-f]{64}$'),
    lease_attempt_count    integer NOT NULL CHECK (lease_attempt_count BETWEEN 1 AND 1000000),
    observation_type       text NOT NULL CHECK (observation_type IN (
                               'proven_never_accepted','accepted','terminal',
                               'transient_unavailable','ambiguous','ledger_corrupt'
                             )),
    connector_job_id       text NOT NULL CHECK (
                               octet_length(connector_job_id) BETWEEN 1 AND 128
                               AND connector_job_id !~ '[[:cntrl:]]'
                             ),
    connector_idempotency_key text NOT NULL CHECK (
                               connector_idempotency_key ~ '^[0-9a-f]{64}$'
                             ),
    dispatch_request_hash  text NOT NULL CHECK (dispatch_request_hash ~ '^[0-9a-f]{64}$'),
    ledger_epoch           text NOT NULL CHECK (
                               octet_length(ledger_epoch) BETWEEN 1 AND 128
                               AND ledger_epoch !~ '[[:cntrl:]]'
                             ),
    observation            jsonb NOT NULL CHECK (jsonb_typeof(observation)='object'),
    observation_hash       text NOT NULL CHECK (observation_hash ~ '^[0-9a-f]{64}$'),
    observed_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
    evolution_origin_txid  bigint NOT NULL DEFAULT txid_current(),
    UNIQUE (outbox_event_id,lease_nonce_hash,observation_hash)
);

CREATE INDEX IF NOT EXISTS evolution_eval_connector_observation_job_idx
  ON evolution_eval_connector_observation(eval_job_id,observed_at,id);

CREATE TABLE IF NOT EXISTS evolution_eval_connector_ledger_epoch (
    eval_job_id          text PRIMARY KEY REFERENCES evolution_eval_job(id),
    ledger_epoch         text NOT NULL CHECK (
                           octet_length(ledger_epoch) BETWEEN 1 AND 128
                           AND ledger_epoch !~ '[[:cntrl:]]'
                         ),
    first_observation_id uuid NOT NULL UNIQUE
                           REFERENCES evolution_eval_connector_observation(id)
                           DEFERRABLE INITIALLY DEFERRED,
    created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current()
);

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_dispatcher_lease()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event outbox_events%ROWTYPE;
BEGIN
  SELECT * INTO event FROM outbox_events WHERE event_id=NEW.event_id;
  IF NOT FOUND
     OR event.aggregate_type<>'evolution_eval_job'
     OR event.aggregate_id<>NEW.aggregate_id
     OR event.event_type<>NEW.event_type
     OR event.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'dispatcher lease must bind an unpublished exact evolution-eval duty'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF OLD.event_id IS DISTINCT FROM NEW.event_id
       OR OLD.event_type IS DISTINCT FROM NEW.event_type
       OR OLD.aggregate_id IS DISTINCT FROM NEW.aggregate_id THEN
      RAISE EXCEPTION 'dispatcher lease event binding is immutable'
        USING ERRCODE='23514';
    END IF;
    IF OLD.lease_nonce_hash IS DISTINCT FROM NEW.lease_nonce_hash THEN
      IF OLD.lease_expires_at>clock_timestamp()
         OR NEW.attempt_count<>OLD.attempt_count+1
         OR NEW.claimed_at<OLD.claimed_at THEN
        RAISE EXCEPTION 'dispatcher lease reclaim requires expiry and the next attempt'
          USING ERRCODE='23514';
      END IF;
    ELSIF OLD.holder_id IS DISTINCT FROM NEW.holder_id
       OR OLD.attempt_count IS DISTINCT FROM NEW.attempt_count
       OR OLD.claimed_at IS DISTINCT FROM NEW.claimed_at THEN
      RAISE EXCEPTION 'dispatcher lease renewal cannot change its claim identity'
        USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.lease_expires_at>NEW.updated_at+interval '5 minutes'
     OR NEW.updated_at>clock_timestamp() THEN
    RAISE EXCEPTION 'dispatcher lease cannot exceed five minutes'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_dispatcher_lease_guard
  ON evolution_eval_dispatcher_lease;
CREATE TRIGGER evolution_eval_dispatcher_lease_guard
  BEFORE INSERT OR UPDATE ON evolution_eval_dispatcher_lease
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_dispatcher_lease();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_connector_observation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lease evolution_eval_dispatcher_lease%ROWTYPE;
  event outbox_events%ROWTYPE;
  job evolution_eval_job%ROWTYPE;
  dispatch evolution_eval_dispatch%ROWTYPE;
BEGIN
  SELECT * INTO lease FROM evolution_eval_dispatcher_lease
   WHERE event_id=NEW.outbox_event_id;
  SELECT * INTO event FROM outbox_events WHERE event_id=NEW.outbox_event_id;
  IF NOT FOUND
     OR event.event_id IS NULL
     OR lease.event_id IS NULL
     OR lease.holder_id<>NEW.holder_id
     OR lease.lease_nonce_hash<>NEW.lease_nonce_hash
     OR lease.attempt_count<>NEW.lease_attempt_count
     OR lease.lease_expires_at<=clock_timestamp()
     OR event.published_at IS NOT NULL
     OR event.aggregate_type<>'evolution_eval_job'
     OR event.aggregate_id<>NEW.eval_job_id
     OR event.event_type<>lease.event_type THEN
    RAISE EXCEPTION 'connector observation requires the current unexpired dispatcher lease attempt'
      USING ERRCODE='23514';
  END IF;
  IF lease.aggregate_id<>NEW.eval_job_id THEN
    RAISE EXCEPTION 'connector observation job does not match claimed outbox duty'
      USING ERRCODE='23514';
  END IF;
  IF lease.event_type NOT IN (
       'evolution_eval.dispatch_requested',
       'evolution_eval.reconcile_requested',
       'evolution_eval.dispatch_tombstoned'
     ) THEN
    RAISE EXCEPTION 'ledger observation is forbidden for this dispatcher duty'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO job FROM evolution_eval_job WHERE id=NEW.eval_job_id;
  SELECT * INTO dispatch FROM evolution_eval_dispatch WHERE eval_job_id=NEW.eval_job_id;
  IF NOT FOUND
     OR job.connector_job_id<>NEW.connector_job_id
     OR job.connector_idempotency_key<>NEW.connector_idempotency_key
     OR dispatch.dispatch_request_hash<>NEW.dispatch_request_hash THEN
    RAISE EXCEPTION 'connector observation does not match the Core-issued dispatch binding'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_connector_ledger_epoch epoch
     WHERE epoch.eval_job_id=NEW.eval_job_id
       AND epoch.ledger_epoch<>NEW.ledger_epoch
  ) AND NEW.observation_type<>'ledger_corrupt' THEN
    RAISE EXCEPTION 'connector ledger epoch changed for an existing eval job'
      USING ERRCODE='23514';
  END IF;
  IF NEW.observation_type IN ('proven_never_accepted','accepted','terminal','ambiguous') THEN
    INSERT INTO evolution_eval_connector_ledger_epoch
      (eval_job_id,ledger_epoch,first_observation_id)
    VALUES (NEW.eval_job_id,NEW.ledger_epoch,NEW.id)
    ON CONFLICT (eval_job_id) DO NOTHING;
    IF NOT EXISTS (
      SELECT 1 FROM evolution_eval_connector_ledger_epoch epoch
       WHERE epoch.eval_job_id=NEW.eval_job_id
         AND epoch.ledger_epoch=NEW.ledger_epoch
    ) THEN
      RAISE EXCEPTION 'connector ledger epoch pin conflict'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_connector_observation_guard
  ON evolution_eval_connector_observation;
CREATE TRIGGER evolution_eval_connector_observation_guard
  BEFORE INSERT ON evolution_eval_connector_observation
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_connector_observation();

CREATE OR REPLACE FUNCTION synthia_reject_evolution_eval_connector_observation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'connector observations are append-only' USING ERRCODE='23514';
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_connector_observation_append_only
  ON evolution_eval_connector_observation;
CREATE TRIGGER evolution_eval_connector_observation_append_only
  BEFORE UPDATE OR DELETE ON evolution_eval_connector_observation
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_evolution_eval_connector_observation_mutation();

DROP TRIGGER IF EXISTS evolution_eval_connector_ledger_epoch_append_only
  ON evolution_eval_connector_ledger_epoch;
CREATE TRIGGER evolution_eval_connector_ledger_epoch_append_only
  BEFORE UPDATE OR DELETE ON evolution_eval_connector_ledger_epoch
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_evolution_eval_connector_observation_mutation();

-- M4-D deliberately allowed only the transition into `required`, because no
-- trusted Connector observer existed yet. M4-E may confirm reconciliation
-- only while settling an exact observation for the current unexpired
-- reconcile duty; direct or stale projection updates remain forbidden.
CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval job rejects delete' USING ERRCODE='55000';
  END IF;
  IF (to_jsonb(OLD)-'reconciliation_state') IS DISTINCT FROM
     (to_jsonb(NEW)-'reconciliation_state') THEN
    RAISE EXCEPTION 'evolution eval immutable job binding cannot change' USING ERRCODE='55000';
  END IF;
  IF OLD.reconciliation_state IS DISTINCT FROM NEW.reconciliation_state THEN
    IF NEW.reconciliation_state='required'
       AND OLD.reconciliation_state IN ('not_needed','confirmed')
       AND EXISTS (
         SELECT 1 FROM evolution_eval_reconcile_fact f
          WHERE f.eval_job_id=NEW.id AND f.evolution_origin_txid=txid_current()
       ) THEN
      RETURN NEW;
    END IF;
    IF OLD.reconciliation_state='required'
       AND NEW.reconciliation_state='confirmed'
       AND EXISTS (
         SELECT 1 FROM evolution_eval_evidence_fact conclusion
          WHERE conclusion.eval_job_id=NEW.id
            AND conclusion.fact_type IN (
              'frozen','corrupt','unavailable_at_deadline'
            )
            AND conclusion.evolution_origin_txid=txid_current()
       ) THEN
      RETURN NEW;
    END IF;
    IF OLD.reconciliation_state='required'
       AND NEW.reconciliation_state='confirmed'
       AND EXISTS (
         SELECT 1
           FROM evolution_eval_connector_observation observation
           JOIN outbox_events outbox
             ON outbox.event_id=observation.outbox_event_id
           JOIN evolution_eval_dispatcher_lease lease
             ON lease.event_id=observation.outbox_event_id
          WHERE observation.eval_job_id=NEW.id
            AND (
              (
                observation.observation_type IN ('proven_never_accepted','terminal')
                AND outbox.event_type IN (
                  'evolution_eval.dispatch_requested',
                  'evolution_eval.reconcile_requested',
                  'evolution_eval.dispatch_tombstoned'
                )
              )
              OR (
                observation.observation_type='accepted'
                AND outbox.event_type='evolution_eval.reconcile_requested'
              )
            )
            AND outbox.published_at IS NULL
            AND lease.holder_id=observation.holder_id
            AND lease.lease_nonce_hash=observation.lease_nonce_hash
            AND lease.attempt_count=observation.lease_attempt_count
            AND lease.lease_expires_at>clock_timestamp()
       ) THEN
      RETURN NEW;
    END IF;
    IF OLD.reconciliation_state='required'
       AND NEW.reconciliation_state='confirmed'
       AND EXISTS (
         SELECT 1
           FROM evolution_eval_connector_observation observation
           JOIN outbox_events outbox
             ON outbox.event_id=observation.outbox_event_id
           JOIN evolution_eval_dispatcher_lease lease
             ON lease.event_id=observation.outbox_event_id
          WHERE observation.eval_job_id=NEW.id
            AND observation.observation_type IN (
              'accepted','transient_unavailable','ambiguous','ledger_corrupt'
            )
            AND outbox.event_type IN (
              'evolution_eval.dispatch_requested',
              'evolution_eval.reconcile_requested',
              'evolution_eval.dispatch_tombstoned'
            )
            AND outbox.published_at IS NULL
            AND lease.holder_id=observation.holder_id
            AND lease.lease_nonce_hash=observation.lease_nonce_hash
            AND lease.attempt_count=observation.lease_attempt_count
            AND lease.lease_expires_at>clock_timestamp()
            AND EXISTS (
              SELECT 1
                FROM evolution_eval_unknown_fact unknown_fact
                JOIN evolution_eval_run run
                  ON run.curator_run_id=NEW.curator_run_id
                JOIN tool_run tool ON tool.id=NEW.tool_run_id
               WHERE unknown_fact.eval_job_id=NEW.id
                 AND unknown_fact.evolution_origin_txid=txid_current()
                 AND run.unknown_effect_origin_txid=txid_current()
                 AND tool.state::text='unknown_effect'
            )
       ) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'unsupported evolution eval reconciliation transition'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

-- A post-fence recovery may first tombstone a dispatch and then learn a
-- definitive terminal result from the Connector ledger. M4-D allowed only
-- the intermediate effect-possible states here, which incorrectly rejected
-- the two valid final projections (`succeeded` and `failed`). Keep the
-- no-dispatch case constrained to `rejected`; only a durable dispatch fact
-- admits an effect-possible or terminal projection beside a tombstone.
CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_job(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  run_row tool_run%ROWTYPE;
  transition evolution_eval_transition_fact%ROWTYPE;
  audit evolution_eval_audit_event%ROWTYPE;
  unknown_fact evolution_eval_unknown_fact%ROWTYPE;
  expected_state text := 'submitted';
  expected_sequence integer := 1;
  transition_count integer := 0;
  expected_outbox_type text;
  expected_outbox_payload jsonb;
BEGIN
  SELECT * INTO job FROM evolution_eval_job WHERE id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO run_row FROM tool_run WHERE id=job.tool_run_id;
  IF NOT FOUND OR run_row.run_class::text<>'evolution_eval' OR run_row.project_id<>job.project_id
     OR run_row.operation<>job.operation OR run_row.input_manifest_hash<>job.input_manifest_hash THEN
    RAISE EXCEPTION 'evolution eval job must have exactly one matching ToolRun' USING ERRCODE='23514';
  END IF;
  IF (SELECT count(*) FROM evolution_eval_job WHERE tool_run_id=job.tool_run_id)<>1 THEN
    RAISE EXCEPTION 'evolution eval ToolRun/job binding must be one-to-one' USING ERRCODE='23514';
  END IF;
  IF run_row.state::text IN ('queued','preparing','cancelling','lost') THEN
    RAISE EXCEPTION 'evolution eval ToolRun has no commit-stable projection for this state'
      USING ERRCODE='23514';
  END IF;
  FOR transition IN SELECT * FROM evolution_eval_transition_fact
    WHERE eval_job_id=job.id ORDER BY transition_sequence LOOP
    transition_count=transition_count+1;
    IF transition.transition_sequence<>expected_sequence OR transition.from_state::text<>expected_state THEN
      RAISE EXCEPTION 'evolution eval transition facts must be a contiguous chain from submitted'
        USING ERRCODE='23514';
    END IF;
    SELECT * INTO audit FROM evolution_eval_audit_event WHERE id=transition.audit_event_id;
    IF NOT FOUND OR audit.eval_job_id<>job.id OR audit.curator_run_id<>job.curator_run_id
       OR audit.project_id<>job.project_id OR audit.event_type<>'tool_run_transition'
       OR audit.correlation_id<>run_row.correlation_id
       OR audit.from_state IS DISTINCT FROM transition.from_state
       OR audit.to_state IS DISTINCT FROM transition.to_state OR audit.operation<>job.operation
       OR audit.request_hash IS NOT NULL OR audit.workspace_manifest_hash IS NOT NULL
       OR audit.evidence_manifest_hash IS NOT NULL OR audit.file_count IS NOT NULL
       OR audit.byte_count IS NOT NULL OR audit.error_code IS NOT NULL THEN
      RAISE EXCEPTION 'each evolution eval transition requires one exact audit fact'
        USING ERRCODE='23514';
    END IF;
    expected_outbox_type=CASE WHEN transition.to_state::text='unknown_effect'
      THEN 'evolution_eval.unknown_effect' ELSE 'evolution_eval.tool_run_transition' END;
    expected_outbox_payload=jsonb_build_object(
      'from_state',transition.from_state::text,'to_state',transition.to_state::text
    );
    IF transition.to_state::text='unknown_effect' THEN
      expected_outbox_payload=expected_outbox_payload||jsonb_build_object(
        'fact_hash',(SELECT u.fact_hash FROM evolution_eval_unknown_fact u
          WHERE u.eval_job_id=job.id)
      );
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM outbox_events o WHERE o.event_id=transition.outbox_event_id
        AND o.aggregate_type='evolution_eval_job' AND o.aggregate_id=job.id
        AND o.event_type=expected_outbox_type
        AND o.project_id=job.project_id AND o.correlation_id=run_row.correlation_id
        AND o.headers='{}'::jsonb AND o.causation_id IS NULL AND o.classification='D1'
        AND o.payload=expected_outbox_payload
        AND o.evolution_origin_txid=transition.evolution_origin_txid
        AND o.evolution_origin_txid=audit.evolution_origin_txid
    ) THEN
      RAISE EXCEPTION 'each evolution eval transition requires one exact outbox fact'
        USING ERRCODE='23514';
    END IF;
    expected_state=transition.to_state::text;
    expected_sequence=expected_sequence+1;
  END LOOP;
  IF expected_state<>run_row.state::text
     OR (run_row.state::text='submitted' AND transition_count<>0)
     OR (run_row.state::text<>'submitted' AND transition_count=0) THEN
    RAISE EXCEPTION 'evolution eval ToolRun projection must equal its complete transition chain'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_audit_event a
     WHERE a.eval_job_id=job.id AND a.from_state IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.audit_event_id=a.id)
  ) THEN
    RAISE EXCEPTION 'evolution eval transition audit cannot be pre-seeded or orphaned'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO unknown_fact FROM evolution_eval_unknown_fact WHERE eval_job_id=job.id;
  IF run_row.state::text='unknown_effect' THEN
    IF NOT FOUND OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_transition_fact t
       WHERE t.id=unknown_fact.transition_fact_id AND t.eval_job_id=job.id
         AND t.to_state='unknown_effect' AND t.audit_event_id=unknown_fact.audit_event_id
         AND t.outbox_event_id=unknown_fact.outbox_event_id
    ) OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_run r WHERE r.curator_run_id=job.curator_run_id
        AND r.unknown_effect_latched_at=unknown_fact.latched_at
    ) OR NOT EXISTS (
      SELECT 1 FROM outbox_events o WHERE o.event_id=unknown_fact.outbox_event_id
        AND o.event_type='evolution_eval.unknown_effect'
        AND o.payload->>'fact_hash'=unknown_fact.fact_hash
    ) OR NOT EXISTS (
      SELECT 1 FROM evolution_eval_transition_fact t
      JOIN evolution_eval_audit_event a ON a.id=t.audit_event_id
      JOIN outbox_events o ON o.event_id=t.outbox_event_id
      JOIN evolution_eval_unknown_fact u ON u.transition_fact_id=t.id
      JOIN evolution_eval_run r ON r.curator_run_id=job.curator_run_id
       WHERE t.eval_job_id=job.id
         AND t.evolution_origin_txid=a.evolution_origin_txid
         AND t.evolution_origin_txid=o.evolution_origin_txid
         AND t.evolution_origin_txid=u.evolution_origin_txid
         AND t.evolution_origin_txid=r.unknown_effect_origin_txid
    ) THEN
      RAISE EXCEPTION 'unknown_effect requires atomic terminal/transition/audit/outbox/run-latch facts'
        USING ERRCODE='23514';
    END IF;
  ELSIF FOUND THEN
    RAISE EXCEPTION 'unknown effect fact cannot be pre-seeded before its terminal state'
      USING ERRCODE='23514';
  END IF;
  IF run_row.state::text<>'submitted' AND NOT EXISTS (
    SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=job.id
  ) AND run_row.state::text<>'rejected' THEN
    RAISE EXCEPTION 'effect-possible evolution eval states require the durable dispatch fact'
      USING ERRCODE='23514';
  END IF;
  IF run_row.state::text='rejected' AND NOT EXISTS (
    SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.eval_job_id=job.id
  ) THEN
    RAISE EXCEPTION 'pre-effect rejection requires an immutable dispatch tombstone'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.eval_job_id=job.id
  ) AND NOT (
    run_row.state::text='rejected'
    OR (
      run_row.state::text IN (
        'running','succeeded','failed','cancelled','timeout','unknown_effect'
      )
      AND EXISTS (
        SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=job.id
      )
    )
  ) THEN
    RAISE EXCEPTION 'dispatch tombstone requires a pre-effect rejection or durable effect-possible projection'
      USING ERRCODE='23514';
  END IF;
  PERFORM synthia_assert_evolution_eval_parameters(job.id);
  PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
END;
$$;

CREATE TABLE IF NOT EXISTS evolution_eval_retention_receipt (
    id                     uuid PRIMARY KEY,
    eval_job_id            text NOT NULL REFERENCES evolution_eval_job(id),
    receipt_type           text NOT NULL CHECK (
                             receipt_type IN ('acknowledgement','quarantine','cleanup')
                           ),
    connector_state        text NOT NULL CHECK (
                             connector_state IN ('acknowledged','quarantined','cleaned','expired')
                           ),
    authorization_hash     text NOT NULL CHECK (authorization_hash ~ '^[0-9a-f]{64}$'),
    connector_fact_hash    text NOT NULL CHECK (connector_fact_hash ~ '^[0-9a-f]{64}$'),
    source_authorization_kind text CHECK (
                             source_authorization_kind IS NULL OR
                             source_authorization_kind IN ('ack','quarantine','expiry','discard')
                           ),
    source_authorization_hash text CHECK (
                             source_authorization_hash IS NULL OR
                             source_authorization_hash ~ '^[0-9a-f]{64}$'
                           ),
    source_connector_fact_hash text CHECK (
                             source_connector_fact_hash IS NULL OR
                             source_connector_fact_hash ~ '^[0-9a-f]{64}$'
                           ),
    outbox_event_id        uuid NOT NULL REFERENCES outbox_events(event_id),
    holder_id              text NOT NULL CHECK (
                             octet_length(holder_id) BETWEEN 1 AND 128
                             AND holder_id !~ '[[:cntrl:]]'
                           ),
    lease_nonce_hash       text NOT NULL CHECK (lease_nonce_hash ~ '^[0-9a-f]{64}$'),
    lease_attempt_count    integer NOT NULL CHECK (
                             lease_attempt_count BETWEEN 1 AND 1000000
                           ),
    evolution_origin_txid  bigint NOT NULL DEFAULT txid_current(),
    created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (eval_job_id,receipt_type),
    UNIQUE (connector_fact_hash),
    UNIQUE (source_connector_fact_hash),
    CHECK (
      (receipt_type='cleanup') = (
        source_authorization_kind IS NOT NULL
        AND source_authorization_hash IS NOT NULL
        AND source_connector_fact_hash IS NOT NULL
      )
    ),
    UNIQUE (outbox_event_id,authorization_hash)
);

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_retention_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_event_type text;
  expected_fact_type text;
BEGIN
  IF TG_OP<>'INSERT' THEN
    RAISE EXCEPTION 'evolution eval retention receipts are append-only'
      USING ERRCODE='23514';
  END IF;
  expected_event_type=CASE NEW.receipt_type
    WHEN 'acknowledgement' THEN 'evolution_eval.evidence.ack_requested'
    WHEN 'quarantine' THEN 'evolution_eval.evidence.quarantine_requested'
    ELSE 'evolution_eval.evidence.cleanup_requested' END;
  expected_fact_type=CASE NEW.receipt_type
    WHEN 'acknowledgement' THEN 'ack_pending'
    WHEN 'quarantine' THEN 'quarantine_pending'
    ELSE 'cleanup_pending' END;
  IF (NEW.receipt_type='acknowledgement' AND NEW.connector_state<>'acknowledged')
     OR (NEW.receipt_type='quarantine' AND NEW.connector_state<>'quarantined')
     OR (NEW.receipt_type='cleanup' AND NEW.connector_state<>'cleaned')
     OR (NEW.receipt_type='cleanup'
         AND NEW.source_authorization_kind IN ('ack','quarantine')
         AND NOT EXISTS (
           SELECT 1
             FROM evolution_eval_retention_receipt source
            WHERE source.eval_job_id=NEW.eval_job_id
              AND source.receipt_type=CASE NEW.source_authorization_kind
                WHEN 'ack' THEN 'acknowledgement' ELSE 'quarantine' END
              AND source.authorization_hash=NEW.source_authorization_hash
              AND source.connector_fact_hash=NEW.source_connector_fact_hash
         ))
     OR NOT EXISTS (
       SELECT 1
         FROM evolution_eval_dispatcher_lease lease
         JOIN outbox_events outbox ON outbox.event_id=lease.event_id
         JOIN evolution_eval_evidence_fact fact ON fact.outbox_event_id=outbox.event_id
        WHERE lease.event_id=NEW.outbox_event_id
          AND lease.aggregate_id=NEW.eval_job_id
          AND lease.holder_id=NEW.holder_id
          AND lease.lease_nonce_hash=NEW.lease_nonce_hash
          AND lease.attempt_count=NEW.lease_attempt_count
          AND lease.lease_expires_at>clock_timestamp()
          AND outbox.published_at IS NULL
          AND outbox.aggregate_type='evolution_eval_job'
          AND outbox.aggregate_id=NEW.eval_job_id
          AND outbox.event_type=expected_event_type
          AND fact.fact_type=expected_fact_type
          AND fact.fact_hash=NEW.authorization_hash
     ) THEN
    RAISE EXCEPTION 'retention receipt requires the exact current duty authorization'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_retention_receipt_guard
  ON evolution_eval_retention_receipt;
CREATE TRIGGER evolution_eval_retention_receipt_guard
  BEFORE INSERT OR UPDATE OR DELETE ON evolution_eval_retention_receipt
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_retention_receipt();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_retention_receipt_terminal()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job_id text;
BEGIN
  target_job_id=COALESCE(NEW.eval_job_id,OLD.eval_job_id);
  IF EXISTS (
    SELECT 1
      FROM evolution_eval_evidence_fact terminal
     WHERE terminal.eval_job_id=target_job_id
       AND terminal.fact_type='acknowledged'
       AND NOT EXISTS (
         SELECT 1
           FROM evolution_eval_retention_receipt receipt
           JOIN evolution_eval_evidence_fact pending
             ON pending.eval_job_id=terminal.eval_job_id
            AND pending.fact_type='ack_pending'
          WHERE receipt.eval_job_id=terminal.eval_job_id
            AND receipt.receipt_type='acknowledgement'
            AND receipt.connector_state='acknowledged'
            AND receipt.outbox_event_id=pending.outbox_event_id
            AND receipt.authorization_hash=pending.fact_hash
            AND receipt.evolution_origin_txid=terminal.evolution_origin_txid
       )
  ) THEN
    RAISE EXCEPTION 'acknowledged evidence requires its exact same-transaction Connector receipt'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM evolution_eval_evidence_fact terminal
     WHERE terminal.eval_job_id=target_job_id
       AND terminal.fact_type='cleaned'
       AND NOT EXISTS (
         SELECT 1
           FROM evolution_eval_retention_receipt receipt
           JOIN evolution_eval_evidence_fact pending
             ON pending.eval_job_id=terminal.eval_job_id
            AND pending.fact_type='cleanup_pending'
          WHERE receipt.eval_job_id=terminal.eval_job_id
            AND receipt.receipt_type='cleanup'
            AND receipt.connector_state='cleaned'
            AND receipt.outbox_event_id=pending.outbox_event_id
            AND receipt.authorization_hash=pending.fact_hash
            AND receipt.evolution_origin_txid=terminal.evolution_origin_txid
       )
  ) THEN
    RAISE EXCEPTION 'cleaned evidence requires its exact same-transaction Connector receipt'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM evolution_eval_retention_receipt receipt
      JOIN evolution_eval_evidence_fact pending
        ON pending.eval_job_id=receipt.eval_job_id
       AND pending.outbox_event_id=receipt.outbox_event_id
       AND pending.fact_hash=receipt.authorization_hash
     WHERE receipt.eval_job_id=target_job_id
       AND receipt.receipt_type IN ('acknowledgement','cleanup')
       AND NOT EXISTS (
         SELECT 1
           FROM evolution_eval_evidence_fact terminal
          WHERE terminal.eval_job_id=receipt.eval_job_id
            AND terminal.fact_type=CASE receipt.receipt_type
              WHEN 'acknowledgement' THEN 'acknowledged'
              ELSE 'cleaned' END
            AND terminal.evolution_origin_txid=receipt.evolution_origin_txid
       )
  ) THEN
    RAISE EXCEPTION 'Connector retention receipt requires its same-transaction terminal fact'
      USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_retention_receipt_terminal_fact_guard
  ON evolution_eval_evidence_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_retention_receipt_terminal_fact_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_evidence_fact
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_retention_receipt_terminal();
DROP TRIGGER IF EXISTS evolution_eval_retention_receipt_terminal_receipt_guard
  ON evolution_eval_retention_receipt;
CREATE CONSTRAINT TRIGGER evolution_eval_retention_receipt_terminal_receipt_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_retention_receipt
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_retention_receipt_terminal();


CREATE TABLE IF NOT EXISTS evolution_eval_temp_cleanup_owner (
    id                uuid PRIMARY KEY,
    eval_job_id       text NOT NULL REFERENCES evolution_eval_job(id),
    outbox_event_id   uuid NOT NULL REFERENCES outbox_events(event_id),
    lease_nonce_hash  text NOT NULL CHECK (lease_nonce_hash ~ '^[0-9a-f]{64}$'),
    lease_attempt_count integer NOT NULL CHECK (
                          lease_attempt_count BETWEEN 1 AND 1000000
                        ),
    owner_id          text NOT NULL CHECK (
                        octet_length(owner_id) BETWEEN 1 AND 128
                        AND owner_id !~ '[[:cntrl:]]'
                      ),
    temp_path_hash    text NOT NULL CHECK (temp_path_hash ~ '^[0-9a-f]{64}$'),
    cleanup_after     timestamptz NOT NULL,
    cleaned_at        timestamptz,
    created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    UNIQUE (eval_job_id,temp_path_hash),
    UNIQUE (outbox_event_id,lease_nonce_hash,temp_path_hash),
    CHECK (cleanup_after >= created_at),
    CHECK (cleaned_at IS NULL OR cleaned_at >= created_at)
);

CREATE INDEX IF NOT EXISTS evolution_eval_temp_cleanup_owner_due_idx
  ON evolution_eval_temp_cleanup_owner(cleanup_after,id) WHERE cleaned_at IS NULL;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_temp_cleanup_owner()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  lease evolution_eval_dispatcher_lease%ROWTYPE;
  event outbox_events%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval temp cleanup ownership is immutable'
      USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(OLD)-'cleaned_at') IS DISTINCT FROM
       (to_jsonb(NEW)-'cleaned_at')
       OR OLD.cleaned_at IS NOT NULL
       OR NEW.cleaned_at IS NULL THEN
      RAISE EXCEPTION 'evolution eval temp cleanup ownership is immutable'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO lease
    FROM evolution_eval_dispatcher_lease
   WHERE event_id=NEW.outbox_event_id;
  SELECT * INTO event FROM outbox_events WHERE event_id=NEW.outbox_event_id;
  IF NOT FOUND
     OR lease.event_id IS NULL
     OR lease.aggregate_id<>NEW.eval_job_id
     OR lease.holder_id<>NEW.owner_id
     OR lease.lease_nonce_hash<>NEW.lease_nonce_hash
     OR lease.attempt_count<>NEW.lease_attempt_count
     OR lease.lease_expires_at<=clock_timestamp()
     OR event.aggregate_type<>'evolution_eval_job'
     OR event.aggregate_id<>NEW.eval_job_id
     OR event.event_type<>lease.event_type
     OR event.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'temp cleanup owner requires the exact current evidence duty lease'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_temp_cleanup_owner_guard
  ON evolution_eval_temp_cleanup_owner;
CREATE TRIGGER evolution_eval_temp_cleanup_owner_guard
  BEFORE INSERT OR UPDATE OR DELETE ON evolution_eval_temp_cleanup_owner
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_temp_cleanup_owner();

INSERT INTO schema_migrations(version) VALUES ('0025_evolution_eval_dispatcher')
ON CONFLICT (version) DO NOTHING;

COMMIT;

BEGIN;

-- Generic governed evidence carries its own immutable classification even
-- though evolution-eval evidence lives in a separate table.  This gives every
-- formal selector an independent decision input in addition to run_class.
ALTER TABLE tool_run_evidence_entry
  ADD COLUMN IF NOT EXISTS artifact_classification text NOT NULL
    DEFAULT 'tool_run_evidence'
    CHECK (artifact_classification IN (
      'tool_run_evidence','experimental/evolution_eval','evolution_eval_evidence'
    )),
  ADD COLUMN IF NOT EXISTS usage_classification text NOT NULL
    DEFAULT 'run_class_governed'
    CHECK (usage_classification IN ('run_class_governed','evolution_eval_only'));

ALTER TABLE bitstream_result
  ADD COLUMN IF NOT EXISTS artifact_classification text NOT NULL
    DEFAULT 'tool_run_evidence'
    CHECK (artifact_classification IN (
      'tool_run_evidence','experimental/evolution_eval'
    )),
  ADD COLUMN IF NOT EXISTS usage_classification text NOT NULL
    DEFAULT 'run_class_governed'
    CHECK (usage_classification IN ('run_class_governed','evolution_eval_only'));

CREATE OR REPLACE FUNCTION synthia_validate_tool_run_evidence_classification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_run_class run_class;
BEGIN
  SELECT run_class INTO source_run_class
    FROM tool_run
   WHERE id=NEW.tool_run_id AND project_id=NEW.project_id;
  IF NOT FOUND
     OR source_run_class='evolution_eval'
     OR NEW.artifact_classification<>'tool_run_evidence'
     OR NEW.usage_classification<>'run_class_governed' THEN
    RAISE EXCEPTION 'generic evidence requires a non-evolution classification'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tool_run_evidence_classification_guard
  ON tool_run_evidence_entry;
CREATE TRIGGER tool_run_evidence_classification_guard
  BEFORE INSERT ON tool_run_evidence_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_tool_run_evidence_classification();

CREATE OR REPLACE FUNCTION synthia_validate_bitstream_result_classification()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_run_class run_class;
  source_artifact_classification text;
  source_usage_classification text;
BEGIN
  SELECT run.run_class,evidence.artifact_classification,evidence.usage_classification
    INTO source_run_class,source_artifact_classification,source_usage_classification
    FROM tool_run run
    JOIN tool_run_evidence_entry evidence
      ON evidence.tool_run_id=run.id AND evidence.project_id=run.project_id
   WHERE run.id=NEW.tool_run_id AND run.project_id=NEW.project_id
     AND evidence.manifest_id=NEW.evidence_manifest_id
     AND evidence.name=NEW.evidence_entry_name;
  IF NOT FOUND
     OR source_run_class='evolution_eval'
     OR (NEW.class='formal' AND source_run_class<>'formal')
     OR NEW.artifact_classification<>'tool_run_evidence'
     OR NEW.usage_classification<>'run_class_governed'
     OR source_artifact_classification IS DISTINCT FROM NEW.artifact_classification
     OR source_usage_classification IS DISTINCT FROM NEW.usage_classification THEN
    RAISE EXCEPTION 'bitstream classification does not match governed source evidence'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bitstream_result_classification_guard ON bitstream_result;
CREATE TRIGGER bitstream_result_classification_guard
  BEFORE INSERT ON bitstream_result
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_bitstream_result_classification();

CREATE OR REPLACE FUNCTION synthia_validate_delivery_item_classification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_type='tool_run' AND NOT EXISTS (
    SELECT 1 FROM tool_run run
     WHERE run.id=NEW.source_id AND run.project_id=NEW.project_id
       AND run.run_class='formal'
  ) THEN
    RAISE EXCEPTION 'delivery run result requires a formal ToolRun'
      USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='tool_run_evidence_manifest' AND NOT EXISTS (
    SELECT 1
      FROM tool_run_evidence_manifest manifest
      JOIN tool_run run
        ON run.id=manifest.tool_run_id AND run.project_id=manifest.project_id
     WHERE manifest.id=NEW.source_id AND manifest.project_id=NEW.project_id
       AND run.run_class='formal'
       AND NOT EXISTS (
         SELECT 1 FROM tool_run_evidence_entry evidence
          WHERE evidence.manifest_id=manifest.id
            AND evidence.project_id=manifest.project_id
            AND (
              evidence.artifact_classification<>'tool_run_evidence'
              OR evidence.usage_classification<>'run_class_governed'
            )
       )
  ) THEN
    RAISE EXCEPTION 'delivery evidence manifest requires formal non-evolution classification'
      USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='tool_run_evidence_entry' AND NOT EXISTS (
    SELECT 1
      FROM tool_run_evidence_entry evidence
      JOIN tool_run run
        ON run.id=evidence.tool_run_id AND run.project_id=evidence.project_id
     WHERE evidence.id=NEW.source_id AND evidence.project_id=NEW.project_id
       AND run.run_class='formal'
       AND evidence.artifact_classification='tool_run_evidence'
       AND evidence.usage_classification='run_class_governed'
  ) THEN
    RAISE EXCEPTION 'delivery evidence requires formal non-evolution classification'
      USING ERRCODE='23514';
  END IF;
  IF NEW.source_type='bitstream_result' AND NOT EXISTS (
    SELECT 1
      FROM bitstream_result bitstream
      JOIN tool_run run
        ON run.id=bitstream.tool_run_id AND run.project_id=bitstream.project_id
     WHERE bitstream.id=NEW.source_id AND bitstream.project_id=NEW.project_id
       AND bitstream.class='formal' AND run.run_class='formal'
       AND bitstream.artifact_classification='tool_run_evidence'
       AND bitstream.usage_classification='run_class_governed'
  ) THEN
    RAISE EXCEPTION 'delivery bitstream requires formal non-evolution classification'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_release_item_classification_guard
  ON delivery_release_item;
CREATE TRIGGER delivery_release_item_classification_guard
  BEFORE INSERT ON delivery_release_item
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_delivery_item_classification();

CREATE OR REPLACE FUNCTION synthia_validate_delivery_release_classification()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM bitstream_result bitstream
      JOIN tool_run run
        ON run.id=bitstream.tool_run_id AND run.project_id=bitstream.project_id
     WHERE bitstream.id=NEW.bitstream_result_id
       AND bitstream.project_id=NEW.project_id
       AND bitstream.class='formal' AND run.run_class='formal'
       AND bitstream.artifact_classification='tool_run_evidence'
       AND bitstream.usage_classification='run_class_governed'
  ) THEN
    RAISE EXCEPTION 'delivery release rejects evolution-eval classified bitstreams'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delivery_release_classification_guard ON delivery_release;
CREATE TRIGGER delivery_release_classification_guard
  BEFORE INSERT ON delivery_release
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_delivery_release_classification();

INSERT INTO schema_migrations(version)
VALUES ('0026_evidence_authority_classification')
ON CONFLICT (version) DO NOTHING;

COMMIT;
BEGIN;

-- Dedicated M4-F certification canary. This is an immutable Core issuance
-- record, not a Curator business job, and therefore never enters dispatcher or
-- outbox duty. One row per disposable Gate database prevents cross-project or
-- cross-scenario reuse.
CREATE TABLE IF NOT EXISTS evolution_eval_canary_binding (
    singleton_id    text PRIMARY KEY CHECK (singleton_id = 'm4f-canary'),
    database_name   text NOT NULL CHECK (
                      database_name ~ '^synthia-selfevo-gate-[A-Za-z0-9._-]+$'
                    ),
    gate_id         text NOT NULL CHECK (
                      octet_length(gate_id) BETWEEN 1 AND 128
                      AND gate_id !~ '[[:cntrl:]]'
                    ),
    scenario        text NOT NULL CHECK (scenario IN ('success','failure-quarantine')),
    project_id      text NOT NULL UNIQUE REFERENCES project(id),
    request_hash    text NOT NULL UNIQUE CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    binding_hash    text NOT NULL UNIQUE CHECK (binding_hash ~ '^[0-9a-f]{64}$'),
    binding         jsonb NOT NULL CHECK (
                      jsonb_typeof(binding) = 'object'
                      AND binding->>'project_id' = project_id
                      AND binding->>'dispatch_request_hash' ~ '^[0-9a-f]{64}$'
                      AND binding->'dispatch'->>'schema' = 'evolution-eval-dispatch-request.v1'
                      AND binding->'dispatch'->>'run_class' = 'evolution_eval'
                      AND binding->'dispatch'->>'deadline_at' = '2000-01-01T00:00:00.000Z'
                      AND binding->'dispatch'->>'requested_timeout_ms' = '1'
                    ),
    issued_by_type  actor_type NOT NULL CHECK (issued_by_type = 'human'),
    issued_by       text NOT NULL CHECK (btrim(issued_by) <> ''),
    correlation_id  text NOT NULL CHECK (
                      octet_length(correlation_id) BETWEEN 1 AND 128
                      AND correlation_id !~ '[[:cntrl:]]'
                    ),
    issued_at       timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS evolution_eval_canary_binding_append_only
  ON evolution_eval_canary_binding;
CREATE TRIGGER evolution_eval_canary_binding_append_only
  BEFORE UPDATE OR DELETE ON evolution_eval_canary_binding
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

INSERT INTO schema_migrations(version)
VALUES ('0027_evolution_eval_canary_binding')
ON CONFLICT (version) DO NOTHING;

COMMIT;
