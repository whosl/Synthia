BEGIN;

CREATE TABLE IF NOT EXISTS process_definition (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS process_version (
  id text PRIMARY KEY,
  profile_id text NOT NULL REFERENCES process_definition(id),
  version text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(profile_id, version)
);
ALTER TABLE project ADD COLUMN IF NOT EXISTS project_type text NOT NULL DEFAULT 'free';
ALTER TABLE project ADD COLUMN IF NOT EXISTS process_version_id text;
ALTER TABLE project ADD COLUMN IF NOT EXISTS process_profile_id text;
ALTER TABLE project ADD COLUMN IF NOT EXISTS process_profile_version text;
ALTER TABLE project ADD COLUMN IF NOT EXISTS process_profile_name text;
ALTER TABLE project ALTER COLUMN target_part DROP NOT NULL;
ALTER TABLE project ALTER COLUMN target_part DROP DEFAULT;
ALTER TABLE project DROP CONSTRAINT IF EXISTS project_project_type_check;
ALTER TABLE project ADD CONSTRAINT project_project_type_check CHECK (project_type IN ('free','engineering'));
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'process_version'::regclass
       AND confrelid = 'process_definition'::regclass
       AND contype = 'f'
  ) THEN
    ALTER TABLE process_version ADD CONSTRAINT process_version_profile_fk FOREIGN KEY (profile_id) REFERENCES process_definition(id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'project'::regclass
       AND confrelid = 'process_version'::regclass
       AND contype = 'f'
  ) THEN
    ALTER TABLE project ADD CONSTRAINT project_process_version_fk FOREIGN KEY (process_version_id) REFERENCES process_version(id);
  END IF;
END $$;

INSERT INTO process_definition(id,name,description) VALUES ('GJB_REF_V1','GJB 参考流程 v1','GJB 参考流程，首版开放 G0-G4') ON CONFLICT (id) DO NOTHING;
INSERT INTO process_definition(id,name,description) VALUES ('LEGACY_COMPAT','兼容旧流程','仅用于标记迁移前项目和旧 API 请求') ON CONFLICT (id) DO NOTHING;
INSERT INTO process_version(id,profile_id,version,name,status) VALUES ('GJB_REF_V1','GJB_REF_V1','GJB_REF_V1','GJB 参考流程 v1','active') ON CONFLICT (id) DO NOTHING;
INSERT INTO process_version(id,profile_id,version,name,status) VALUES ('LEGACY_COMPAT','LEGACY_COMPAT','LEGACY_COMPAT','兼容旧流程','retired') ON CONFLICT (id) DO NOTHING;

-- A process version is an immutable registry identity. Retirement is the only
-- legal state transition; a retired version must never be edited and revived.
CREATE OR REPLACE FUNCTION synthia_reject_process_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'process version is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.profile_id IS DISTINCT FROM NEW.profile_id
     OR OLD.version IS DISTINCT FROM NEW.version
     OR OLD.name IS DISTINCT FROM NEW.name
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.status = 'retired' AND NEW.status IS DISTINCT FROM 'retired') THEN
    RAISE EXCEPTION 'process version is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS process_version_immutable ON process_version;
CREATE TRIGGER process_version_immutable BEFORE UPDATE OR DELETE ON process_version
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_process_version_mutation();
-- Only rows that existed before the first successful application are eligible
-- for the compatibility backfill. Replaying the migration must never turn a
-- deliberately-created free project (whose process fields are NULL) into a
-- legacy engineering project.
DROP TRIGGER IF EXISTS project_process_profile_immutable ON project;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version = '0006_project_type_process_version'
  ) THEN
    UPDATE project
       SET project_type='engineering',
           process_version_id='LEGACY_COMPAT',
           process_profile_id='LEGACY_COMPAT',
           process_profile_version='LEGACY_COMPAT',
           process_profile_name='兼容旧流程'
     WHERE process_version_id IS NULL AND process_profile_id IS NULL;
  END IF;
END $$;

-- A temporarily rolled-back legacy service omits all new columns. Defaults
-- therefore classify those later inserts honestly without requiring a replay
-- that could no longer distinguish them from explicit free projects.
ALTER TABLE project ALTER COLUMN project_type SET DEFAULT 'engineering';
ALTER TABLE project ALTER COLUMN process_version_id SET DEFAULT 'LEGACY_COMPAT';
ALTER TABLE project ALTER COLUMN process_profile_id SET DEFAULT 'LEGACY_COMPAT';
ALTER TABLE project ALTER COLUMN process_profile_version SET DEFAULT 'LEGACY_COMPAT';
ALTER TABLE project ALTER COLUMN process_profile_name SET DEFAULT '兼容旧流程';
ALTER TABLE project DROP CONSTRAINT IF EXISTS project_process_binding_check;
ALTER TABLE project ADD CONSTRAINT project_process_binding_check CHECK (
  (
    project_type = 'free'
    AND process_version_id IS NULL
    AND process_profile_id IS NULL
    AND process_profile_version IS NULL
    AND process_profile_name IS NULL
  )
  OR
  (
    project_type = 'engineering'
    AND process_version_id IS NOT NULL
    AND process_profile_id IS NOT NULL
    AND process_profile_version IS NOT NULL
    AND process_profile_name IS NOT NULL
    AND (
      (
        process_version_id = 'GJB_REF_V1'
        AND process_profile_id = 'GJB_REF_V1'
        AND process_profile_version = 'GJB_REF_V1'
        AND process_profile_name = 'GJB 参考流程 v1'
      )
      OR
      (
        process_version_id = 'LEGACY_COMPAT'
        AND process_profile_id = 'LEGACY_COMPAT'
        AND process_profile_version = 'LEGACY_COMPAT'
        AND process_profile_name = '兼容旧流程'
      )
    )
  )
);

CREATE OR REPLACE FUNCTION synthia_reject_process_profile_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.project_type IS DISTINCT FROM NEW.project_type
     OR OLD.process_version_id IS DISTINCT FROM NEW.process_version_id
     OR OLD.process_profile_id IS DISTINCT FROM NEW.process_profile_id
     OR OLD.process_profile_version IS DISTINCT FROM NEW.process_profile_version
     OR OLD.process_profile_name IS DISTINCT FROM NEW.process_profile_name THEN
    RAISE EXCEPTION 'project process profile is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER project_process_profile_immutable BEFORE UPDATE ON project
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_process_profile_change();
INSERT INTO schema_migrations(version) VALUES ('0006_project_type_process_version') ON CONFLICT (version) DO NOTHING;
COMMIT;
