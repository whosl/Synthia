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

DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'evolution_eval_dispatch'
          AND column_name = 'sealed_input_projection_hash'
     )
     AND EXISTS (SELECT 1 FROM evolution_eval_dispatch)
  THEN
    RAISE EXCEPTION 'M4E_0017_REQUIRES_EMPTY_PRE_RELEASE_EVOLUTION_EVAL_DISPATCH';
  END IF;
END
$$;

ALTER TABLE evolution_eval_dispatch
  ADD COLUMN IF NOT EXISTS sealed_input_projection_hash text NOT NULL
  CHECK (sealed_input_projection_hash ~ '^[0-9a-f]{64}$');

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

INSERT INTO schema_migrations(version) VALUES ('0032_evolution_eval_dispatcher')
ON CONFLICT (version) DO NOTHING;

COMMIT;
