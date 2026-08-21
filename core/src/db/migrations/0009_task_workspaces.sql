BEGIN;

-- P3 side-task isolation.  Core owns task identity/state, while Runtime keeps
-- only an execution cache.  Composite keys make project ownership a database
-- invariant rather than a path-string convention.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_id_project_type_unique'
       AND conrelid = 'public.project'::regclass
  ) THEN
    ALTER TABLE project ADD CONSTRAINT project_id_project_type_unique
      UNIQUE (id, project_type);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'process_instance_id_project_unique'
       AND conrelid = 'public.process_instance'::regclass
  ) THEN
    ALTER TABLE process_instance ADD CONSTRAINT process_instance_id_project_unique
      UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'artifact_id_project_unique'
       AND conrelid = 'public.artifact'::regclass
  ) THEN
    ALTER TABLE artifact ADD CONSTRAINT artifact_id_project_unique
      UNIQUE (id, project_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'artifact_revision_id_artifact_project_unique'
       AND conrelid = 'public.artifact_revision'::regclass
  ) THEN
    ALTER TABLE artifact_revision ADD CONSTRAINT artifact_revision_id_artifact_project_unique
      UNIQUE (id, artifact_id, project_id);
  END IF;
END;
$$;

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
    parent_task_id      text,
    workspace_id        text,
    process_instance_id text,
    runtime_agent_id    text,
    runtime_actor_id    text NOT NULL CONSTRAINT agent_task_runtime_actor_fk REFERENCES user_account(uid)
                         CHECK (btrim(runtime_actor_id) <> ''),
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

CREATE UNIQUE INDEX IF NOT EXISTS agent_task_one_active_engineering_main_idx
  ON agent_task(project_id)
  WHERE project_type = 'engineering'
    AND kind = 'main'
    AND status IN ('queued','running','awaiting_user');
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

-- Immutable file versions produced inside an isolated task workspace.  Only
-- UTF-8 text up to one MiB is accepted in slice 1.  A->B->A remains three
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
    content_text      text NOT NULL,
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
    CONSTRAINT task_workspace_file_content_size CHECK (size_bytes = octet_length(content_text)),
    CONSTRAINT task_workspace_file_content_digest CHECK (
      content_hash = encode(digest(convert_to(content_text, 'UTF8'), 'sha256'), 'hex')
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
       AND parent.status IN ('queued','running','awaiting_user')
  ) THEN
    RAISE EXCEPTION 'side task requires an active main parent in the same project' USING ERRCODE = '23514';
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

INSERT INTO schema_migrations(version)
  VALUES ('0009_task_workspaces')
  ON CONFLICT (version) DO NOTHING;
COMMIT;
