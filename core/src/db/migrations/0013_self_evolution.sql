BEGIN;

-- Self-evolution is a separate Core fact domain. Learned Skills never share
-- storage with the read-only System Skill pack and never carry capabilities.

CREATE TABLE IF NOT EXISTS evolution_settings (
    singleton_id           text PRIMARY KEY CHECK (singleton_id = 'global'),
    learning_paused        boolean NOT NULL DEFAULT false,
    learned_skills_enabled boolean NOT NULL DEFAULT true,
    revision               bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_by_type        actor_type NOT NULL,
    updated_by             text NOT NULL CHECK (btrim(updated_by) <> ''),
    update_reason          text NOT NULL CHECK (btrim(update_reason) <> ''),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now()
);

INSERT INTO evolution_settings
  (singleton_id, updated_by_type, updated_by, update_reason)
VALUES ('global', 'service', 'system', 'initial self-evolution settings')
ON CONFLICT (singleton_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS learning_episode (
    id                        text PRIMARY KEY,
    project_id                text NOT NULL REFERENCES project(id),
    task_id                   text NOT NULL,
    observation_key           text NOT NULL CHECK (btrim(observation_key) <> ''),
    episode_key               text NOT NULL CHECK (btrim(episode_key) <> ''),
    turn_id                   text,
    end_event_sequence        bigint NOT NULL CHECK (end_event_sequence > 0),
    content_hash              text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    outcome_claim             text,
    tool_event_start_sequence bigint CHECK (tool_event_start_sequence IS NULL OR tool_event_start_sequence > 0),
    tool_event_end_sequence   bigint CHECK (tool_event_end_sequence IS NULL OR tool_event_end_sequence > 0),
    evidence_refs             jsonb NOT NULL DEFAULT '[]'::jsonb
                                CHECK (jsonb_typeof(evidence_refs) = 'array'),
    created_by_type           actor_type NOT NULL,
    created_by                text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at                timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, task_id, project_id),
    UNIQUE (task_id, observation_key),
    UNIQUE (task_id, episode_key),
    FOREIGN KEY (task_id, project_id) REFERENCES agent_task(id, project_id),
    FOREIGN KEY (task_id, end_event_sequence)
      REFERENCES task_conversation_event(task_id, sequence),
    CHECK (
      (tool_event_start_sequence IS NULL AND tool_event_end_sequence IS NULL)
      OR (
        tool_event_start_sequence IS NOT NULL
        AND tool_event_end_sequence IS NOT NULL
        AND tool_event_start_sequence <= tool_event_end_sequence
        AND tool_event_end_sequence <= end_event_sequence
      )
    )
);
CREATE INDEX IF NOT EXISTS learning_episode_task_observation_idx
  ON learning_episode(task_id, observation_key, created_at DESC);

-- A Core status hook may seal the boundary before Runtime receives its
-- response. The later explicit create call can add the richer immutable
-- outcome/evidence projection without mutating the sealed episode identity.
CREATE TABLE IF NOT EXISTS learning_episode_enrichment (
    episode_id                 text PRIMARY KEY REFERENCES learning_episode(id),
    content_hash               text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    outcome_claim              text,
    tool_event_start_sequence  bigint CHECK (tool_event_start_sequence IS NULL OR tool_event_start_sequence > 0),
    tool_event_end_sequence    bigint CHECK (tool_event_end_sequence IS NULL OR tool_event_end_sequence > 0),
    evidence_refs              jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs)='array'),
    created_by_type            actor_type NOT NULL,
    created_by                 text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    CHECK (
      (tool_event_start_sequence IS NULL AND tool_event_end_sequence IS NULL)
      OR (tool_event_start_sequence IS NOT NULL AND tool_event_end_sequence IS NOT NULL
          AND tool_event_start_sequence <= tool_event_end_sequence)
    )
);

CREATE TABLE IF NOT EXISTS distillation_run (
    id                    text PRIMARY KEY,
    episode_id            text NOT NULL UNIQUE REFERENCES learning_episode(id),
    state                 text NOT NULL DEFAULT 'queued'
                            CHECK (state IN ('queued','running','succeeded','noop','quarantined','failed')),
    attempt               integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    worker_id             text,
    lease_token           text,
    lease_expires_at      timestamptz,
    ready_at              timestamptz NOT NULL DEFAULT now(),
    input_cutoff_at       timestamptz,
    terminal_request_hash text CHECK (terminal_request_hash IS NULL OR terminal_request_hash ~ '^[0-9a-f]{64}$'),
    terminal_result       jsonb CHECK (terminal_result IS NULL OR jsonb_typeof(terminal_result) = 'object'),
    error_code            text,
    details_hash          text CHECK (details_hash IS NULL OR details_hash ~ '^[0-9a-f]{64}$'),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz,
    CHECK (
      (state = 'queued' AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
      OR (state = 'running' AND worker_id IS NOT NULL AND btrim(worker_id) <> '' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND input_cutoff_at IS NOT NULL AND completed_at IS NULL)
      OR (state IN ('succeeded','noop','quarantined') AND input_cutoff_at IS NOT NULL AND terminal_request_hash IS NOT NULL AND terminal_result IS NOT NULL AND completed_at IS NOT NULL)
      OR (state = 'failed' AND input_cutoff_at IS NOT NULL AND error_code IS NOT NULL AND details_hash IS NOT NULL AND completed_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS distillation_run_claim_idx
  ON distillation_run(state, ready_at, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS learned_skill (
    id                    text PRIMARY KEY,
    slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
    name                  text NOT NULL CHECK (btrim(name) <> ''),
    summary               text NOT NULL CHECK (btrim(summary) <> ''),
    applicability_summary text NOT NULL CHECK (btrim(applicability_summary) <> ''),
    enabled               boolean NOT NULL DEFAULT true,
    pinned                boolean NOT NULL DEFAULT false,
    availability_state    text NOT NULL DEFAULT 'available'
                            CHECK (availability_state IN ('available','archived')),
    active_version_id     text,
    control_revision      bigint NOT NULL DEFAULT 1 CHECK (control_revision > 0),
    last_used_at          timestamptz,
    created_by_type       actor_type NOT NULL,
    created_by            text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, active_version_id)
);

CREATE TABLE IF NOT EXISTS curator_run (
    id                    text PRIMARY KEY,
    mode                  text NOT NULL CHECK (mode IN ('run','dry_run')),
    state                 text NOT NULL DEFAULT 'queued'
                            CHECK (state IN ('queued','running','completed','dry_run_complete','failed')),
    schedule_bucket       text NOT NULL CHECK (btrim(schedule_bucket) <> ''),
    manual_key            text,
    eligible_at           timestamptz,
    reason                text NOT NULL CHECK (btrim(reason) <> ''),
    attempt               integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    worker_id             text,
    lease_token           text,
    lease_expires_at      timestamptz,
    terminal_request_hash text CHECK (terminal_request_hash IS NULL OR terminal_request_hash ~ '^[0-9a-f]{64}$'),
    terminal_result       jsonb CHECK (terminal_result IS NULL OR jsonb_typeof(terminal_result) = 'object'),
    error_code            text,
    details_hash          text CHECK (details_hash IS NULL OR details_hash ~ '^[0-9a-f]{64}$'),
    created_by_type       actor_type NOT NULL,
    created_by            text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now(),
    completed_at          timestamptz,
    UNIQUE (manual_key),
    CHECK ((manual_key IS NULL) = (eligible_at IS NOT NULL)),
    CHECK (
      (state = 'queued' AND worker_id IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL)
      OR (state = 'running' AND worker_id IS NOT NULL AND btrim(worker_id) <> '' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND completed_at IS NULL)
      OR (state IN ('completed','dry_run_complete') AND terminal_request_hash IS NOT NULL AND terminal_result IS NOT NULL AND completed_at IS NOT NULL)
      OR (state = 'failed' AND error_code IS NOT NULL AND details_hash IS NOT NULL AND completed_at IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS curator_run_claim_idx
  ON curator_run(state, lease_expires_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS curator_run_scheduled_bucket_idx
  ON curator_run(schedule_bucket) WHERE manual_key IS NULL;

CREATE TABLE IF NOT EXISTS learned_skill_version (
    id                    text PRIMARY KEY,
    skill_id              text NOT NULL REFERENCES learned_skill(id),
    version_no            integer NOT NULL CHECK (version_no > 0),
    parent_version_id     text,
    description           text NOT NULL CHECK (btrim(description) <> ''),
    applicability         jsonb NOT NULL CHECK (jsonb_typeof(applicability) IN ('object','array')),
    outcome_contract      jsonb NOT NULL CHECK (jsonb_typeof(outcome_contract) IN ('object','array')),
    content_manifest_hash text NOT NULL CHECK (content_manifest_hash ~ '^[0-9a-f]{64}$'),
    scanner_version       text NOT NULL CHECK (btrim(scanner_version) <> ''),
    scan_decision         text NOT NULL CHECK (scan_decision IN ('pass','quarantine')),
    scan_findings         jsonb NOT NULL DEFAULT '[]'::jsonb
                            CHECK (jsonb_typeof(scan_findings) = 'array'),
    distillation_run_id   text REFERENCES distillation_run(id),
    curator_run_id        text REFERENCES curator_run(id),
    created_by_type       actor_type NOT NULL,
    created_by            text NOT NULL CHECK (btrim(created_by) <> ''),
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, skill_id),
    UNIQUE (skill_id, version_no),
    UNIQUE (distillation_run_id),
    CHECK (num_nonnulls(distillation_run_id, curator_run_id) = 1),
    FOREIGN KEY (parent_version_id, skill_id)
      REFERENCES learned_skill_version(id, skill_id)
);

ALTER TABLE learned_skill
  DROP CONSTRAINT IF EXISTS learned_skill_active_version_fk;
ALTER TABLE learned_skill
  ADD CONSTRAINT learned_skill_active_version_fk
  FOREIGN KEY (active_version_id, id)
  REFERENCES learned_skill_version(id, skill_id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE IF NOT EXISTS learned_skill_version_status (
    version_id            text PRIMARY KEY REFERENCES learned_skill_version(id),
    quality_state         text NOT NULL
                            CHECK (quality_state IN ('active_unproven','active_observed','needs_review','degraded','quarantined')),
    last_evaluation_id    text,
    updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS learned_skill_file (
    id            text PRIMARY KEY,
    version_id    text NOT NULL REFERENCES learned_skill_version(id),
    path          text NOT NULL CHECK (path <> '' AND path !~ '^/' AND path !~ '(^|/)\.\.?(/|$)'),
    kind          text NOT NULL CHECK (kind IN ('skill_md','reference','template','script')),
    language      text CHECK (language IS NULL OR language IN ('tcl','python','typescript')),
    sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes    bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 262144),
    media_type    text NOT NULL CHECK (btrim(media_type) <> ''),
    content       text NOT NULL CHECK (content <> ''),
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (version_id, path),
    CHECK ((kind = 'script') = (language IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS learned_skill_lifecycle_event (
    id               text PRIMARY KEY,
    skill_id         text NOT NULL REFERENCES learned_skill(id),
    version_id       text REFERENCES learned_skill_version(id),
    event_type       text NOT NULL CHECK (btrim(event_type) <> ''),
    from_projection  jsonb NOT NULL CHECK (jsonb_typeof(from_projection) = 'object'),
    to_projection    jsonb NOT NULL CHECK (jsonb_typeof(to_projection) = 'object'),
    reason           text NOT NULL CHECK (btrim(reason) <> ''),
    control_revision bigint NOT NULL CHECK (control_revision > 0),
    actor_type       actor_type NOT NULL,
    actor_id         text NOT NULL CHECK (btrim(actor_id) <> ''),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learned_skill_lifecycle_skill_created_idx
  ON learned_skill_lifecycle_event(skill_id, created_at, id);

CREATE TABLE IF NOT EXISTS skill_application (
    id                        text PRIMARY KEY,
    project_id                text NOT NULL REFERENCES project(id),
    task_id                   text NOT NULL,
    observation_key           text NOT NULL CHECK (btrim(observation_key) <> ''),
    episode_id                text,
    local_goal                text NOT NULL CHECK (btrim(local_goal) <> ''),
    state                     text NOT NULL DEFAULT 'open'
                                CHECK (state IN ('open','closed_pending_episode','pending_evaluation','evaluated')),
    primary_tool_call_id      text NOT NULL CHECK (btrim(primary_tool_call_id) <> ''),
    start_event_sequence      bigint NOT NULL CHECK (start_event_sequence > 0),
    end_event_sequence        bigint CHECK (end_event_sequence IS NULL OR end_event_sequence >= start_event_sequence),
    outcome_claim             text,
    human_corrections         integer CHECK (human_corrections IS NULL OR human_corrections >= 0),
    evidence_refs             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    tool_run_refs             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tool_run_refs) = 'array'),
    started_at                timestamptz NOT NULL DEFAULT now(),
    closed_at                 timestamptz,
    created_by_type           actor_type NOT NULL,
    created_by                text NOT NULL CHECK (btrim(created_by) <> ''),
    UNIQUE (id, task_id, project_id),
    UNIQUE (task_id, primary_tool_call_id),
    FOREIGN KEY (task_id, project_id) REFERENCES agent_task(id, project_id),
    FOREIGN KEY (episode_id, task_id, project_id)
      REFERENCES learning_episode(id, task_id, project_id),
    FOREIGN KEY (task_id, start_event_sequence)
      REFERENCES task_conversation_event(task_id, sequence),
    CHECK (
      (state = 'open' AND end_event_sequence IS NULL AND closed_at IS NULL AND human_corrections IS NULL)
      OR (state IN ('closed_pending_episode','pending_evaluation','evaluated') AND end_event_sequence IS NOT NULL AND closed_at IS NOT NULL AND human_corrections IS NOT NULL)
    ),
    CHECK (
      (episode_id IS NULL AND state IN ('open','closed_pending_episode'))
      OR (episode_id IS NOT NULL AND state IN ('open','pending_evaluation','evaluated'))
    )
);
CREATE INDEX IF NOT EXISTS skill_application_pending_idx
  ON skill_application(state, closed_at) WHERE state = 'pending_evaluation';
CREATE INDEX IF NOT EXISTS skill_application_observation_idx
  ON skill_application(task_id, observation_key) WHERE episode_id IS NULL;

CREATE TABLE IF NOT EXISTS skill_application_skill (
    id             text PRIMARY KEY,
    application_id text NOT NULL REFERENCES skill_application(id),
    skill_id       text NOT NULL REFERENCES learned_skill(id),
    version_id     text NOT NULL,
    role           text NOT NULL CHECK (role IN ('primary','supporting')),
    tool_call_id   text NOT NULL CHECK (btrim(tool_call_id) <> ''),
    reason_codes   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (application_id, version_id),
    UNIQUE (application_id, tool_call_id),
    FOREIGN KEY (version_id, skill_id) REFERENCES learned_skill_version(id, skill_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS skill_application_one_primary_idx
  ON skill_application_skill(application_id) WHERE role = 'primary';
CREATE INDEX IF NOT EXISTS skill_application_skill_version_idx
  ON skill_application_skill(version_id, application_id);

-- Operational reservation prevents concurrent Curator runs from receiving
-- the same pending application. Reservations survive retryable run failures
-- and are released only when the owning run reaches a terminal state.
CREATE TABLE IF NOT EXISTS curator_application_reservation (
    curator_run_id text NOT NULL REFERENCES curator_run(id),
    application_id text NOT NULL UNIQUE REFERENCES skill_application(id),
    reserved_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (curator_run_id, application_id)
);
CREATE INDEX IF NOT EXISTS curator_application_reservation_run_idx
  ON curator_application_reservation(curator_run_id, reserved_at, application_id);

CREATE TABLE IF NOT EXISTS curator_evaluation (
    id                     text PRIMARY KEY,
    curator_run_id         text REFERENCES curator_run(id),
    application_id         text NOT NULL REFERENCES skill_application(id),
    skill_id               text NOT NULL REFERENCES learned_skill(id),
    version_id             text NOT NULL,
    evidence_snapshot_hash text NOT NULL CHECK (evidence_snapshot_hash ~ '^[0-9a-f]{64}$'),
    outcome                text NOT NULL
                             CHECK (outcome IN ('success','applicability_failure','execution_failure','inconclusive')),
    confidence             double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
    reason                 text NOT NULL CHECK (btrim(reason) <> ''),
    evidence_refs          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_refs) = 'array'),
    supersedes_id          text REFERENCES curator_evaluation(id),
    evaluator_type         text NOT NULL CHECK (evaluator_type IN ('curator','human')),
    evaluator_version      text NOT NULL CHECK (btrim(evaluator_version) <> ''),
    created_at             timestamptz NOT NULL DEFAULT now(),
    UNIQUE (application_id, evidence_snapshot_hash, evaluator_version),
    FOREIGN KEY (version_id, skill_id) REFERENCES learned_skill_version(id, skill_id),
    CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);
CREATE INDEX IF NOT EXISTS curator_evaluation_application_created_idx
  ON curator_evaluation(application_id, created_at, id);
CREATE INDEX IF NOT EXISTS curator_evaluation_version_created_idx
  ON curator_evaluation(version_id, created_at, id);

CREATE TABLE IF NOT EXISTS curator_remediation_audit (
    id                  text PRIMARY KEY,
    curator_run_id      text NOT NULL REFERENCES curator_run(id),
    evaluation_id       text NOT NULL UNIQUE REFERENCES curator_evaluation(id),
    application_id      text NOT NULL REFERENCES skill_application(id),
    skill_id            text NOT NULL REFERENCES learned_skill(id),
    action              text NOT NULL CHECK (action IN ('no_op','patch','scope_change','state_action')),
    request_payload     jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
    decision            text NOT NULL CHECK (decision IN ('applied','skipped')),
    produced_version_id text REFERENCES learned_skill_version(id),
    skip_reason         text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CHECK ((decision='applied' AND skip_reason IS NULL) OR (decision='skipped' AND btrim(skip_reason) <> ''))
);
CREATE INDEX IF NOT EXISTS curator_remediation_run_idx
  ON curator_remediation_audit(curator_run_id, created_at, id);

ALTER TABLE learned_skill_version_status
  DROP CONSTRAINT IF EXISTS learned_skill_version_status_last_evaluation_fk;
ALTER TABLE learned_skill_version_status
  ADD CONSTRAINT learned_skill_version_status_last_evaluation_fk
  FOREIGN KEY (last_evaluation_id) REFERENCES curator_evaluation(id);

CREATE OR REPLACE FUNCTION synthia_validate_skill_application_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'skill application rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
     OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.observation_key IS DISTINCT FROM NEW.observation_key
     OR OLD.local_goal IS DISTINCT FROM NEW.local_goal
     OR OLD.primary_tool_call_id IS DISTINCT FROM NEW.primary_tool_call_id
     OR OLD.start_event_sequence IS DISTINCT FROM NEW.start_event_sequence
     OR OLD.started_at IS DISTINCT FROM NEW.started_at
     OR OLD.created_by_type IS DISTINCT FROM NEW.created_by_type
     OR OLD.created_by IS DISTINCT FROM NEW.created_by THEN
    RAISE EXCEPTION 'skill application identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.episode_id IS NOT NULL AND OLD.episode_id IS DISTINCT FROM NEW.episode_id THEN
    RAISE EXCEPTION 'skill application episode binding is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.end_event_sequence IS NOT NULL
     AND (
       OLD.end_event_sequence IS DISTINCT FROM NEW.end_event_sequence
       OR OLD.outcome_claim IS DISTINCT FROM NEW.outcome_claim
       OR OLD.human_corrections IS DISTINCT FROM NEW.human_corrections
       OR OLD.evidence_refs IS DISTINCT FROM NEW.evidence_refs
       OR OLD.tool_run_refs IS DISTINCT FROM NEW.tool_run_refs
       OR OLD.closed_at IS DISTINCT FROM NEW.closed_at
     ) THEN
    RAISE EXCEPTION 'skill application close facts are immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'open' AND NEW.state IN ('closed_pending_episode','pending_evaluation') THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'closed_pending_episode' AND NEW.state = 'pending_evaluation' THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'pending_evaluation' AND NEW.state = 'evaluated' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'illegal skill application transition: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER IF EXISTS skill_application_mutation_guard ON skill_application;
CREATE TRIGGER skill_application_mutation_guard
  BEFORE UPDATE OR DELETE ON skill_application
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_skill_application_mutation();

DROP TRIGGER IF EXISTS learning_episode_append_only ON learning_episode;
CREATE TRIGGER learning_episode_append_only BEFORE UPDATE OR DELETE ON learning_episode
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS learning_episode_enrichment_append_only ON learning_episode_enrichment;
CREATE TRIGGER learning_episode_enrichment_append_only BEFORE UPDATE OR DELETE ON learning_episode_enrichment
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS learned_skill_version_append_only ON learned_skill_version;
CREATE TRIGGER learned_skill_version_append_only BEFORE UPDATE OR DELETE ON learned_skill_version
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS learned_skill_file_append_only ON learned_skill_file;
CREATE TRIGGER learned_skill_file_append_only BEFORE UPDATE OR DELETE ON learned_skill_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS learned_skill_lifecycle_event_append_only ON learned_skill_lifecycle_event;
CREATE TRIGGER learned_skill_lifecycle_event_append_only BEFORE UPDATE OR DELETE ON learned_skill_lifecycle_event
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS skill_application_skill_append_only ON skill_application_skill;
CREATE TRIGGER skill_application_skill_append_only BEFORE UPDATE OR DELETE ON skill_application_skill
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS curator_evaluation_append_only ON curator_evaluation;
CREATE TRIGGER curator_evaluation_append_only BEFORE UPDATE OR DELETE ON curator_evaluation
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS curator_remediation_audit_append_only ON curator_remediation_audit;
CREATE TRIGGER curator_remediation_audit_append_only BEFORE UPDATE OR DELETE ON curator_remediation_audit
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

INSERT INTO schema_migrations(version)
  VALUES ('0013_self_evolution')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
