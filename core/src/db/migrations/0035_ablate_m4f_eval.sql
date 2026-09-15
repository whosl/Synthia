-- 0035_ablate_m4f_eval.sql
--
-- Ablation of the M4-F certified evaluation machinery. The dispatch/ledger/
-- canary pipeline shipped in 0029-0034 never carried production traffic: every
-- evolution_eval_* table except evolution_eval_run (a curator-run budget
-- side-fact) was empty after three days of real learning-loop operation, and
-- the certified gate it served is retired with this migration.
--
-- The learning loop itself (learning episodes, distillation, learned skills,
-- applications, curator runs/evaluations — 0028) is untouched.
--
-- Idempotent by IF EXISTS throughout; safe to replay.

BEGIN;

-- ── 1. triggers on SURVIVING tables that reach into eval tables ──────────────
DROP TRIGGER IF EXISTS evolution_eval_bitstream_authority_reject ON bitstream_result;
DROP TRIGGER IF EXISTS evolution_eval_curator_terminal_guard ON curator_run;
DROP TRIGGER IF EXISTS evolution_eval_delivery_authority_reject ON delivery_release_item;
DROP TRIGGER IF EXISTS evolution_eval_generic_evidence_reject ON evidence;
DROP TRIGGER IF EXISTS evolution_eval_learned_skill_file_commit_guard ON learned_skill_file;
DROP TRIGGER IF EXISTS evolution_eval_learned_skill_file_version_lock_guard ON learned_skill_file;
DROP TRIGGER IF EXISTS evolution_eval_outbox_commit_guard ON outbox_events;
DROP TRIGGER IF EXISTS evolution_eval_outbox_mutation_guard ON outbox_events;
DROP TRIGGER IF EXISTS evolution_eval_outbox_origin_stamp ON outbox_events;
DROP TRIGGER IF EXISTS evolution_eval_generic_entry_reject ON tool_run_evidence_entry;
DROP TRIGGER IF EXISTS evolution_eval_generic_manifest_reject ON tool_run_evidence_manifest;
DROP TRIGGER IF EXISTS evolution_eval_stable_state_guard ON tool_run;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_binding_mutation_guard ON tool_run;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_commit_guard ON tool_run;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_guard ON tool_run;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_initial_guard ON tool_run;
DROP TRIGGER IF EXISTS curator_evaluation_eval_job_refs_guard ON curator_evaluation;

-- ── 2. the eval fact tables themselves ───────────────────────────────────────
DROP TABLE IF EXISTS evolution_eval_audit_event CASCADE;
DROP TABLE IF EXISTS evolution_eval_canary_binding CASCADE;
DROP TABLE IF EXISTS evolution_eval_connector_ledger_epoch CASCADE;
DROP TABLE IF EXISTS evolution_eval_connector_observation CASCADE;
DROP TABLE IF EXISTS evolution_eval_dispatch_tombstone CASCADE;
DROP TABLE IF EXISTS evolution_eval_dispatch CASCADE;
DROP TABLE IF EXISTS evolution_eval_dispatcher_lease CASCADE;
DROP TABLE IF EXISTS evolution_eval_evidence_entry CASCADE;
DROP TABLE IF EXISTS evolution_eval_evidence_fact CASCADE;
DROP TABLE IF EXISTS evolution_eval_idempotency CASCADE;
DROP TABLE IF EXISTS evolution_eval_input_skill_file CASCADE;
DROP TABLE IF EXISTS evolution_eval_input_file CASCADE;
DROP TABLE IF EXISTS evolution_eval_input CASCADE;
DROP TABLE IF EXISTS evolution_eval_job CASCADE;
DROP TABLE IF EXISTS evolution_eval_operation_fact CASCADE;
DROP TABLE IF EXISTS evolution_eval_reconcile_fact CASCADE;
DROP TABLE IF EXISTS evolution_eval_retention_receipt CASCADE;
DROP TABLE IF EXISTS evolution_eval_temp_cleanup_owner CASCADE;
DROP TABLE IF EXISTS evolution_eval_workspace_file CASCADE;
DROP TABLE IF EXISTS evolution_eval_workspace_projection CASCADE;
DROP TABLE IF EXISTS evolution_eval_workspace_revision CASCADE;
DROP TABLE IF EXISTS evolution_eval_workspace CASCADE;
DROP TABLE IF EXISTS evolution_eval_transition_fact CASCADE;
DROP TABLE IF EXISTS evolution_eval_unknown_fact CASCADE;
DROP TABLE IF EXISTS evolution_eval_run CASCADE;

-- ── 3. their stored procedures ───────────────────────────────────────────────
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS signature
      FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname LIKE '%evolution_eval%'
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || fn.signature || ' CASCADE';
  END LOOP;
END $$;

-- ── 4. record the baseline ───────────────────────────────────────────────────
INSERT INTO schema_migrations(version)
VALUES ('0035_ablate_m4f_eval')
ON CONFLICT (version) DO NOTHING;

COMMIT;
