-- Synthia Core — approval slice DB-level hardening
-- Adds append-only protection, consistency CHECKs, and deterministic uniqueness
-- constraints for the ApprovalRecord / ApprovedGateResult / Baseline vertical slice.
-- Safe to re-run; fully transactional. Depends on 0000 (core tables) and 0001
-- (outbox_events, idempotency_records, synthia_reject_append_only_mutation).
BEGIN;

-- Re-declare the append-only guard function so this migration is self-contained
-- even if applied to a database where 0001 was loaded by a different path.
CREATE OR REPLACE FUNCTION synthia_reject_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects %', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$;

-- ── consistency CHECK constraints ────────────────────────────────────────────

-- baseline must never hold a 'candidate' state (ARC-002 §5.3): baselines are
-- created exclusively by approval events and always start 'active'.
-- Mirrors schema.sql authoritative view; made idempotent here.
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

-- ── append-only triggers ─────────────────────────────────────────────────────
-- ApprovalRecord, ApprovedGateResult, and Baseline are governed records: once
-- committed they may not be UPDATEd or DELETEd. Revocation / supersession is
-- expressed exclusively through new events (new ApprovalRecord with decision
-- 'revoke'; new Baseline linked via superseded_by_baseline_id).

DO $$
BEGIN
  IF to_regclass('public.approval_record') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS approval_record_append_only ON approval_record';
    EXECUTE 'CREATE TRIGGER approval_record_append_only '
         || 'BEFORE UPDATE OR DELETE ON approval_record '
         || 'FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation()';
  END IF;

  IF to_regclass('public.approved_gate_result') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS approved_gate_result_append_only ON approved_gate_result';
    EXECUTE 'CREATE TRIGGER approved_gate_result_append_only '
         || 'BEFORE UPDATE OR DELETE ON approved_gate_result '
         || 'FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation()';
  END IF;

  IF to_regclass('public.baseline') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS baseline_append_only ON baseline';
    EXECUTE 'CREATE TRIGGER baseline_append_only '
         || 'BEFORE UPDATE OR DELETE ON baseline '
         || 'FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation()';
  END IF;
END;
$$;

-- ── deterministic uniqueness ─────────────────────────────────────────────────

-- At most one ApprovedGateResult per GateSubmission. A second approval attempt
-- for the same submission (concurrent or sequential) is rejected with a unique
-- violation rather than silently duplicating the governed result.
CREATE UNIQUE INDEX IF NOT EXISTS approved_gate_result_unique_submission
    ON approved_gate_result (gate_submission_id);

-- At most one active Baseline per (project, kind). Milestone gates G1/G3/G4/
-- G7/G9 produce B0/B1/B2/B3/B4 respectively; this index makes concurrent
-- baseline creation for the same milestone deterministic — exactly one
-- transaction commits an active row, the other receives a unique violation.
-- Superseded / invalidated / retired baselines are retained for audit history.
CREATE UNIQUE INDEX IF NOT EXISTS baseline_unique_active_project_kind
    ON baseline (project_id, kind) WHERE state = 'active';

-- At most one Baseline per ApprovedGateResult. A single approval event creates
-- exactly one baseline; prevents replay of the same approved result from
-- producing duplicate baseline rows regardless of state.
CREATE UNIQUE INDEX IF NOT EXISTS baseline_unique_approved_gate_result
    ON baseline (approved_gate_result_id);

INSERT INTO schema_migrations(version) VALUES ('0002_approval_slice_hardening') ON CONFLICT (version) DO NOTHING;
COMMIT;
