BEGIN;

-- P2 historical-material library.  Import snapshots are immutable captures of
-- external/project material; confirmation is a small, explicit state change
-- on the snapshot row and never changes a formal ConfigurationSnapshot.
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

CREATE UNIQUE INDEX IF NOT EXISTS artifact_revision_id_project_unique_idx
  ON artifact_revision(id, project_id);

-- A relation is created for every copied candidate revision.  It is separate
-- from project_source_relation (which describes P1 project formalisation) so
-- imported material can be audited without pretending it is a project copy.
CREATE TABLE IF NOT EXISTS import_source_relation (
    id                text PRIMARY KEY,
    project_id        text NOT NULL REFERENCES project(id),
    snapshot_id       text NOT NULL REFERENCES import_snapshot(id),
    entry_id          text NOT NULL REFERENCES import_file_entry(id),
    source_project_id text REFERENCES project(id),
    target_revision_id text NOT NULL REFERENCES artifact_revision(id),
    source_hash       text NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    relation_kind     text NOT NULL DEFAULT 'imported_candidate'
                       CHECK (relation_kind = 'imported_candidate'),
    created_by_type   actor_type NOT NULL,
    created_by        text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (target_revision_id),
    FOREIGN KEY (snapshot_id, project_id) REFERENCES import_snapshot(id, project_id),
    FOREIGN KEY (snapshot_id, source_project_id) REFERENCES import_snapshot(id, source_project_id),
    FOREIGN KEY (entry_id, snapshot_id) REFERENCES import_file_entry(id, snapshot_id),
    FOREIGN KEY (target_revision_id, project_id) REFERENCES artifact_revision(id, project_id)
);

-- Explicit audit rows complement the outbox event stream.  They are useful to
-- operators reading a snapshot without having to reconstruct state transitions
-- from unrelated aggregate events.
CREATE TABLE IF NOT EXISTS import_audit_event (
    id            text PRIMARY KEY,
    project_id    text NOT NULL REFERENCES project(id),
    snapshot_id   text NOT NULL REFERENCES import_snapshot(id),
    entry_id      text REFERENCES import_file_entry(id),
    action        text NOT NULL
                  CHECK (action IN ('imported','confirmed','denied','failed','expired','copied')),
    actor_type    actor_type NOT NULL,
    actor_id      text NOT NULL,
    details       jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
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

-- The captured source identity and validity horizon are immutable.  Only the
-- explicit decision/result columns may change, and state transitions are
-- forward-only.  This is the DB backstop for the fixed-snapshot contract.
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
CREATE TRIGGER import_snapshot_immutable
  BEFORE UPDATE OR DELETE ON import_snapshot
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

DROP TRIGGER IF EXISTS import_file_entry_append_only ON import_file_entry;
CREATE TRIGGER import_file_entry_append_only
  BEFORE UPDATE OR DELETE ON import_file_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS import_source_append_only ON import_source;
CREATE TRIGGER import_source_append_only
  BEFORE UPDATE OR DELETE ON import_source
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS import_source_relation_append_only ON import_source_relation;
CREATE TRIGGER import_source_relation_append_only
  BEFORE UPDATE OR DELETE ON import_source_relation
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS import_audit_event_append_only ON import_audit_event;
CREATE TRIGGER import_audit_event_append_only
  BEFORE UPDATE OR DELETE ON import_audit_event
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

INSERT INTO schema_migrations(version)
  VALUES ('0008_import_snapshots')
  ON CONFLICT (version) DO NOTHING;
COMMIT;
