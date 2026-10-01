BEGIN;

ALTER TABLE project ADD COLUMN IF NOT EXISTS config_epoch integer NOT NULL DEFAULT 1 CHECK (config_epoch > 0);
ALTER TABLE project ADD COLUMN IF NOT EXISTS settings_revision integer NOT NULL DEFAULT 1 CHECK (settings_revision > 0);

CREATE TABLE IF NOT EXISTS project_configuration (
  project_id text NOT NULL REFERENCES project(id),
  epoch integer NOT NULL CHECK (epoch > 0),
  target_part text,
  target_frequency_mhz numeric CHECK (target_frequency_mhz > 0),
  constraints jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(constraints) = 'array'),
  created_by_type text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, epoch)
);

INSERT INTO project_configuration (project_id, epoch, target_part, created_by_type, created_by)
SELECT id, config_epoch, target_part, 'migration', '0039' FROM project WHERE project_type='free'
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION synthia_configuration_initial()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.project_type='free' THEN
    INSERT INTO project_configuration (project_id,epoch,target_part,created_by_type,created_by)
    VALUES (NEW.id,NEW.config_epoch,NEW.target_part,'system','project-create');
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS project_configuration_initial ON project;
CREATE TRIGGER project_configuration_initial AFTER INSERT ON project
FOR EACH ROW EXECUTE FUNCTION synthia_configuration_initial();

CREATE OR REPLACE FUNCTION synthia_configuration_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'project configuration snapshot is immutable' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER IF EXISTS project_configuration_immutable ON project_configuration;
CREATE TRIGGER project_configuration_immutable BEFORE UPDATE OR DELETE ON project_configuration
FOR EACH ROW EXECUTE FUNCTION synthia_configuration_immutable();

ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS config_epoch integer;
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS validation_chain_hash text;
ALTER TABLE tool_run ADD COLUMN IF NOT EXISTS connector_dispatch_confirmed boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  ALTER TABLE tool_run ADD CONSTRAINT tool_run_configuration_fk FOREIGN KEY (project_id,config_epoch)
  REFERENCES project_configuration(project_id,epoch);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE agent_task ADD COLUMN IF NOT EXISTS config_epoch integer;
DO $$ BEGIN
  ALTER TABLE agent_task ADD CONSTRAINT agent_task_configuration_fk FOREIGN KEY (project_id,config_epoch)
  REFERENCES project_configuration(project_id,epoch);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS tool_run_configuration_idx ON tool_run(project_id,config_epoch,validation_chain_hash,created_at);

CREATE OR REPLACE FUNCTION synthia_configuration_activity_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_epoch integer;
BEGIN
  SELECT config_epoch INTO current_epoch FROM project WHERE id=NEW.project_id AND project_type='free' FOR UPDATE;
  IF current_epoch IS NULL THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME='agent_task' THEN
    IF NEW.status IN ('queued','running') AND (TG_OP='INSERT' OR OLD.status NOT IN ('queued','running')) THEN
      IF TG_OP='UPDATE' AND NEW.agent_role<>'project' AND OLD.config_epoch IS NOT NULL AND OLD.config_epoch<>current_epoch THEN
        RAISE EXCEPTION 'stale task configuration' USING ERRCODE='23514';
      END IF;
      NEW.config_epoch := current_epoch;
    ELSIF TG_OP='UPDATE' AND NEW.config_epoch IS DISTINCT FROM OLD.config_epoch THEN
      RAISE EXCEPTION 'active task configuration is immutable' USING ERRCODE='55000';
    END IF;
  ELSIF TG_OP='INSERT' AND NEW.config_epoch IS NOT NULL AND NEW.config_epoch<>current_epoch THEN
    RAISE EXCEPTION 'stale project configuration' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' THEN
    IF NEW.config_epoch IS DISTINCT FROM OLD.config_epoch OR NEW.validation_chain_hash IS DISTINCT FROM OLD.validation_chain_hash
      OR NEW.parameters IS DISTINCT FROM OLD.parameters OR NEW.input_manifest_hash IS DISTINCT FROM OLD.input_manifest_hash THEN
      RAISE EXCEPTION 'job configuration binding is immutable' USING ERRCODE='55000';
    END IF;
    IF NEW.state IN ('submitted','queued','preparing','running','cancelling','lost','unknown_effect')
      AND OLD.state NOT IN ('submitted','queued','preparing','running','cancelling','lost','unknown_effect')
      AND NEW.config_epoch IS DISTINCT FROM current_epoch THEN
      RAISE EXCEPTION 'stale job cannot be reactivated' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_task_configuration_binding ON agent_task;
CREATE TRIGGER agent_task_configuration_binding BEFORE INSERT OR UPDATE OF status,config_epoch ON agent_task
FOR EACH ROW EXECUTE FUNCTION synthia_configuration_activity_binding();
DROP TRIGGER IF EXISTS tool_run_configuration_binding ON tool_run;
CREATE TRIGGER tool_run_configuration_binding BEFORE INSERT OR UPDATE OF state,config_epoch,validation_chain_hash,parameters,input_manifest_hash ON tool_run
FOR EACH ROW EXECUTE FUNCTION synthia_configuration_activity_binding();

CREATE OR REPLACE FUNCTION synthia_configuration_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_type<>'free' THEN RETURN NEW; END IF;
  IF NEW.config_epoch=OLD.config_epoch THEN
    IF NEW.target_part IS DISTINCT FROM OLD.target_part THEN
      RAISE EXCEPTION 'part changes require a new configuration snapshot' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.config_epoch<>OLD.config_epoch+1 OR NOT EXISTS (
    SELECT 1 FROM project_configuration WHERE project_id=NEW.id AND epoch=NEW.config_epoch
    AND target_part IS NOT DISTINCT FROM NEW.target_part
  ) THEN
    RAISE EXCEPTION 'invalid project configuration transition' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM agent_task WHERE project_id=NEW.id AND status IN ('queued','running'))
    OR EXISTS (SELECT 1 FROM tool_run WHERE project_id=NEW.id
      AND state IN ('submitted','queued','preparing','running','cancelling','lost','unknown_effect')) THEN
    RAISE EXCEPTION 'project configuration is busy' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS project_configuration_transition ON project;
CREATE TRIGGER project_configuration_transition BEFORE UPDATE OF config_epoch,target_part ON project
FOR EACH ROW EXECUTE FUNCTION synthia_configuration_transition();


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
     OR OLD.agent_role IS DISTINCT FROM NEW.agent_role
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
  IF OLD.status = NEW.status THEN
    NULL;
  ELSIF OLD.agent_role='project' AND OLD.project_type='free' AND OLD.status NOT IN ('queued','running')
        AND NEW.status='queued' AND NEW.config_epoch IS NOT NULL THEN
    -- Reserve the next durable turn before dispatching it to Runtime.
    NULL;
  ELSIF OLD.agent_role = 'project'
        AND NEW.status IN ('running','awaiting_user','failed','cancelled','fail_closed') THEN
    -- A failed/aborted conversation turn never destroys the Project Agent.
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

INSERT INTO schema_migrations(version) VALUES ('0039_project_configuration_epochs') ON CONFLICT DO NOTHING;
COMMIT;
