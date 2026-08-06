BEGIN;

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
  actor_type text NOT NULL CHECK (actor_type IN ('human','agent','connector','system')),
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

CREATE OR REPLACE FUNCTION synthia_reject_append_only_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append-only table % rejects %', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.approval_records') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS approval_records_append_only ON approval_records';
    EXECUTE 'CREATE TRIGGER approval_records_append_only BEFORE UPDATE OR DELETE ON approval_records FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation()';
  END IF;
  IF to_regclass('public.baselines') IS NOT NULL OR to_regclass('public.baseline') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS baseline_append_only ON baseline';
    EXECUTE 'DROP TRIGGER IF EXISTS baselines_append_only ON baselines';
    IF to_regclass('public.baseline') IS NOT NULL THEN EXECUTE 'CREATE TRIGGER baseline_append_only BEFORE UPDATE OR DELETE ON baseline FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation()'; END IF;
    IF to_regclass('public.baselines') IS NOT NULL THEN EXECUTE 'CREATE TRIGGER baselines_append_only BEFORE UPDATE OR DELETE ON baselines FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation()'; END IF;
  END IF;
END;
$$;

INSERT INTO schema_migrations(version) VALUES ('0001_d1_hardening') ON CONFLICT (version) DO NOTHING;
COMMIT;
