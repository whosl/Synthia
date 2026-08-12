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

CREATE TABLE IF NOT EXISTS project (
    id              text PRIMARY KEY,
    name            text NOT NULL,
    scope           text NOT NULL DEFAULT '',
    data_classification data_classification NOT NULL DEFAULT 'D1',
    standard_version text NOT NULL DEFAULT 'GB/T 33781-2017',
    target_part     text NOT NULL DEFAULT 'xc7vx690tffg1761-2',
    toolchain_profile_ref text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    status          text NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS process_instance (
    id                  text PRIMARY KEY,
    project_id          text NOT NULL REFERENCES project(id),
    gate_profile_version text NOT NULL,
    current_gate        gate_id NOT NULL DEFAULT 'G0',
    created_at          timestamptz NOT NULL DEFAULT now()
);

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
    created_at   timestamptz NOT NULL DEFAULT now()
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
    schema_version text NOT NULL DEFAULT 'v1',
    source_ids    text[] NOT NULL DEFAULT '{}',
    data_classification data_classification NOT NULL DEFAULT 'D1',
    tool_model_provenance jsonb,
    change_reason text NOT NULL DEFAULT '',
    created_by    text NOT NULL,
    created_by_type actor_type NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    review_ids    text[] NOT NULL DEFAULT '{}',
    UNIQUE (artifact_id, version)
);

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
