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
VALUES ('0019_evolution_eval_canary_binding')
ON CONFLICT (version) DO NOTHING;

COMMIT;
