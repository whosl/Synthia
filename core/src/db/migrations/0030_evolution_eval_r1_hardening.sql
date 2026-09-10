-- Evolution-eval R1 hardening: typed, exactly-owned reconciliation intents.
BEGIN;

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
  VALUES ('0030_evolution_eval_r1_hardening')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
