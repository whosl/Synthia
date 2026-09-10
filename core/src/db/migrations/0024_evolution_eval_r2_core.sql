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
