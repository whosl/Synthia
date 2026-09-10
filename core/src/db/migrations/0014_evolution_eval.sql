BEGIN;

-- This migration performs no DML that uses the new value. PostgreSQL therefore
-- permits the enum addition and all dependent schema objects in one atomic
-- transaction; Core starts creating evolution-eval ToolRuns after COMMIT.
ALTER TYPE run_class ADD VALUE IF NOT EXISTS 'evolution_eval';

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS evolution_origin_txid bigint NOT NULL DEFAULT txid_current();

CREATE TABLE IF NOT EXISTS evolution_eval_run (
    curator_run_id             text PRIMARY KEY REFERENCES curator_run(id),
    budget_started_at          timestamptz NOT NULL,
    deadline_at                timestamptz NOT NULL,
    max_jobs                   integer NOT NULL DEFAULT 3 CHECK (max_jobs = 3),
    unknown_effect_latched_at  timestamptz,
    unknown_effect_origin_txid bigint,
    created_at                 timestamptz NOT NULL DEFAULT now(),
    completed_at               timestamptz,
    CHECK (deadline_at = budget_started_at + interval '2 hours'),
    CHECK (created_at >= budget_started_at),
    CHECK (unknown_effect_latched_at IS NULL OR unknown_effect_latched_at >= budget_started_at),
    CHECK ((unknown_effect_latched_at IS NULL)=(unknown_effect_origin_txid IS NULL)),
    CHECK (completed_at IS NULL OR completed_at >= budget_started_at)
);

-- Core-issued immutable input binding.  The opaque ref is an identifier, not a
-- bearer credential; every API call still revalidates the current Curator lease
-- and source-project ACL before resolving it.
CREATE TABLE IF NOT EXISTS evolution_eval_input (
    eval_input_ref          text PRIMARY KEY CHECK (
                              octet_length(eval_input_ref) BETWEEN 1 AND 128
                              AND eval_input_ref !~ '[[:cntrl:]]'
                            ),
    curator_run_id          text NOT NULL,
    application_id          text NOT NULL,
    project_id              text NOT NULL REFERENCES project(id),
    version_id              text NOT NULL REFERENCES learned_skill_version(id),
    evidence_snapshot_hash  text NOT NULL CHECK (evidence_snapshot_hash ~ '^[0-9a-f]{64}$'),
    input_manifest_hash     text NOT NULL CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
    source_commit           text NOT NULL CHECK (
                              source_commit ~ '^[0-9a-f]{40}$'
                              OR source_commit ~ '^[0-9a-f]{64}$'
                            ),
    source_manifest_hash    text NOT NULL CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
    allowed_operations      text[] NOT NULL CHECK (
                              cardinality(allowed_operations) BETWEEN 1 AND 4
                              AND allowed_operations <@ ARRAY[
                                'validate_sources','simulate','synthesize','implement'
                              ]::text[]
                              AND array_position(allowed_operations, NULL) IS NULL
                            ),
    trial_bitstream_allowed boolean NOT NULL DEFAULT false,
    part                    text CHECK (
                              part IS NULL OR part ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
                            ),
    toolchain_profile_hash  text NOT NULL CHECK (toolchain_profile_hash ~ '^[0-9a-f]{64}$'),
    input_manifest          jsonb NOT NULL CHECK (
                              jsonb_typeof(input_manifest) = 'object'
                              AND input_manifest->>'schema' = 'evolution-eval-input-manifest.v1'
                            ),
    created_at              timestamptz NOT NULL DEFAULT now(),
    UNIQUE (curator_run_id, application_id),
    UNIQUE (eval_input_ref,version_id),
    UNIQUE (
      eval_input_ref,curator_run_id,application_id,version_id,
      evidence_snapshot_hash,input_manifest_hash
    ),
    FOREIGN KEY (curator_run_id) REFERENCES evolution_eval_run(curator_run_id),
    FOREIGN KEY (curator_run_id,application_id)
      REFERENCES curator_application_reservation(curator_run_id,application_id),
    FOREIGN KEY (application_id,version_id)
      REFERENCES skill_application_skill(application_id,version_id)
);

CREATE TABLE IF NOT EXISTS evolution_eval_input_file (
    eval_input_ref  text NOT NULL REFERENCES evolution_eval_input(eval_input_ref),
    path            text NOT NULL CHECK (
                      octet_length(path) <= 512
                      AND path ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
                    ),
    sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes      bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 4194304),
    media_type      text NOT NULL CHECK (
                      media_type IN ('text/x-verilog','text/x-systemverilog','application/x-xdc')
                    ),
    managed_content bytea NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (eval_input_ref,path),
    CHECK (octet_length(managed_content) = size_bytes),
    CHECK (encode(digest(managed_content,'sha256'),'hex') = sha256),
    CHECK (
      ((translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.(v|vh)$'
       AND media_type = 'text/x-verilog')
      OR ((translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.(sv|svh)$'
          AND media_type = 'text/x-systemverilog')
      OR ((translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.xdc$'
          AND media_type = 'application/x-xdc')
    )
);

CREATE TABLE IF NOT EXISTS evolution_eval_input_skill_file (
    eval_input_ref       text NOT NULL,
    version_id           text NOT NULL,
    learned_skill_file_id text NOT NULL REFERENCES learned_skill_file(id),
    path                 text NOT NULL CHECK (
                           octet_length(path) <= 512
                           AND path ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
                         ),
    kind                 text NOT NULL CHECK (kind IN ('skill_md','reference','template','script')),
    language             text CHECK (language IS NULL OR language IN ('tcl','python','typescript')),
    sha256               text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes           bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 262144),
    media_type           text NOT NULL CHECK (btrim(media_type) <> ''),
    content              text NOT NULL CHECK (content <> ''),
    created_at           timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (eval_input_ref,path),
    UNIQUE (eval_input_ref,learned_skill_file_id),
    FOREIGN KEY (eval_input_ref,version_id)
      REFERENCES evolution_eval_input(eval_input_ref,version_id),
    CHECK ((kind='script')=(language IS NOT NULL)),
    CHECK (octet_length(convert_to(content,'UTF8'))=size_bytes),
    CHECK (encode(digest(convert_to(content,'UTF8'),'sha256'),'hex')=sha256)
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_input_skill_file_portable_key_idx
  ON evolution_eval_input_skill_file(eval_input_ref,
    (translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C"));

CREATE TABLE IF NOT EXISTS evolution_eval_job (
    id                         text PRIMARY KEY,
    curator_run_id             text NOT NULL REFERENCES evolution_eval_run(curator_run_id),
    application_id             text NOT NULL,
    project_id                 text NOT NULL REFERENCES project(id),
    version_id                 text NOT NULL,
    eval_input_ref             text NOT NULL,
    input_manifest_hash        text NOT NULL CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
    evidence_snapshot_hash     text NOT NULL CHECK (evidence_snapshot_hash ~ '^[0-9a-f]{64}$'),
    tool_run_id                text NOT NULL,
    workspace_id               text NOT NULL UNIQUE,
    connector_job_id           text NOT NULL UNIQUE CHECK (
                                 octet_length(connector_job_id) BETWEEN 1 AND 128
                                 AND connector_job_id !~ '[[:cntrl:]]'
                               ),
    connector_idempotency_key  text NOT NULL CHECK (connector_idempotency_key ~ '^[0-9a-f]{64}$'),
    request_key                text NOT NULL CHECK (
                                 octet_length(request_key) BETWEEN 1 AND 128
                                 AND request_key !~ '[[:cntrl:]]'
                               ),
    prepare_request_hash       text NOT NULL CHECK (prepare_request_hash ~ '^[0-9a-f]{64}$'),
    ordinal                    integer NOT NULL CHECK (ordinal BETWEEN 1 AND 3),
    operation                  text NOT NULL CHECK (
                                 operation IN ('validate_sources','simulate','synthesize','implement')
                               ),
    parameters                 jsonb NOT NULL CHECK (jsonb_typeof(parameters) = 'object'),
    requested_timeout_ms       integer NOT NULL CHECK (requested_timeout_ms BETWEEN 1 AND 7200000),
    effective_timeout_ms       integer NOT NULL CHECK (
                                 effective_timeout_ms BETWEEN 1 AND requested_timeout_ms
                               ),
    deadline_at                timestamptz NOT NULL,
    reconciliation_state       text NOT NULL DEFAULT 'not_needed' CHECK (
                                 reconciliation_state IN ('not_needed','confirmed','required')
                               ),
    evolution_origin_txid      bigint NOT NULL DEFAULT txid_current(),
    created_at                 timestamptz NOT NULL DEFAULT now(),
    UNIQUE (curator_run_id,request_key),
    UNIQUE (curator_run_id,ordinal),
    UNIQUE (tool_run_id),
    UNIQUE (id,curator_run_id),
    UNIQUE (id,application_id),
    UNIQUE (id,workspace_id),
    UNIQUE (id,deadline_at),
    FOREIGN KEY (tool_run_id,project_id) REFERENCES tool_run(id,project_id),
    FOREIGN KEY (curator_run_id,application_id)
      REFERENCES curator_application_reservation(curator_run_id,application_id),
    FOREIGN KEY (application_id,version_id)
      REFERENCES skill_application_skill(application_id,version_id),
    FOREIGN KEY (
      eval_input_ref,curator_run_id,application_id,version_id,
      evidence_snapshot_hash,input_manifest_hash
    ) REFERENCES evolution_eval_input(
      eval_input_ref,curator_run_id,application_id,version_id,
      evidence_snapshot_hash,input_manifest_hash
    )
);
CREATE INDEX IF NOT EXISTS evolution_eval_job_run_created_idx
  ON evolution_eval_job(curator_run_id,ordinal);
CREATE INDEX IF NOT EXISTS evolution_eval_job_application_idx
  ON evolution_eval_job(application_id,created_at,id);

CREATE TABLE IF NOT EXISTS evolution_eval_workspace (
    id                    text PRIMARY KEY,
    eval_job_id           text NOT NULL UNIQUE REFERENCES evolution_eval_job(id)
                            DEFERRABLE INITIALLY DEFERRED,
    eval_input_ref        text NOT NULL REFERENCES evolution_eval_input(eval_input_ref),
    source_commit         text NOT NULL CHECK (
                            source_commit ~ '^[0-9a-f]{40}$'
                            OR source_commit ~ '^[0-9a-f]{64}$'
                          ),
    input_manifest_hash   text NOT NULL CHECK (input_manifest_hash ~ '^[0-9a-f]{64}$'),
    source_manifest_hash  text NOT NULL CHECK (source_manifest_hash ~ '^[0-9a-f]{64}$'),
    created_at            timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id,eval_job_id)
);

ALTER TABLE evolution_eval_job
  DROP CONSTRAINT IF EXISTS evolution_eval_job_workspace_fk;
ALTER TABLE evolution_eval_job
  ADD CONSTRAINT evolution_eval_job_workspace_fk
  FOREIGN KEY (workspace_id,id) REFERENCES evolution_eval_workspace(id,eval_job_id)
  DEFERRABLE INITIALLY DEFERRED;

-- A revision is the immutable canonical manifest; file rows contain the Core
-- content-addressed bytes used by read and by the future Connector dispatcher.
CREATE TABLE IF NOT EXISTS evolution_eval_workspace_revision (
    workspace_id   text NOT NULL REFERENCES evolution_eval_workspace(id),
    revision       integer NOT NULL CHECK (revision > 0),
    manifest       jsonb NOT NULL CHECK (
                     jsonb_typeof(manifest) = 'object'
                     AND manifest->>'schema' = 'evolution-eval-workspace-manifest.v1'
                   ),
    manifest_hash  text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
    file_count     integer NOT NULL CHECK (file_count BETWEEN 0 AND 5120),
    total_bytes    bigint NOT NULL CHECK (total_bytes BETWEEN 0 AND 603979776),
    source_files   integer NOT NULL CHECK (source_files BETWEEN 0 AND 4096),
    source_bytes   bigint NOT NULL CHECK (source_bytes BETWEEN 0 AND 536870912),
    skill_files    integer NOT NULL CHECK (skill_files BETWEEN 0 AND 512),
    skill_bytes    bigint NOT NULL CHECK (skill_bytes BETWEEN 0 AND 33554432),
    overlay_files  integer NOT NULL CHECK (overlay_files BETWEEN 0 AND 512),
    overlay_bytes  bigint NOT NULL CHECK (overlay_bytes BETWEEN 0 AND 33554432),
    created_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id,revision),
    UNIQUE (workspace_id,manifest_hash),
    UNIQUE (workspace_id,revision,manifest_hash),
    CHECK (file_count = source_files + skill_files + overlay_files),
    CHECK (total_bytes = source_bytes + skill_bytes + overlay_bytes)
);

CREATE TABLE IF NOT EXISTS evolution_eval_workspace_file (
    workspace_id    text NOT NULL,
    revision        integer NOT NULL,
    path            text NOT NULL CHECK (
                      octet_length(path) <= 512
                      AND path ~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
                    ),
    sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
    media_type      text NOT NULL CHECK (btrim(media_type) <> ''),
    layer           text NOT NULL CHECK (layer IN ('source','skill','overlay')),
    read_only       boolean NOT NULL,
    managed_content bytea NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id,revision,path),
    FOREIGN KEY (workspace_id,revision)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (octet_length(managed_content) = size_bytes),
    CHECK (encode(digest(managed_content,'sha256'),'hex') = sha256),
    CHECK ((layer = 'overlay' AND read_only = false) OR (layer <> 'overlay' AND read_only = true)),
    CHECK (
      (layer = 'source' AND size_bytes <= 4194304)
      OR (layer IN ('skill','overlay') AND size_bytes <= 1048576)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_input_file_portable_key_idx
  ON evolution_eval_input_file(eval_input_ref,
    (translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C"));
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_workspace_file_portable_key_idx
  ON evolution_eval_workspace_file(workspace_id,revision,
    (translate(path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C"));

CREATE TABLE IF NOT EXISTS evolution_eval_workspace_projection (
    workspace_id      text PRIMARY KEY REFERENCES evolution_eval_workspace(id),
    current_revision  integer NOT NULL CHECK (current_revision > 0),
    sealed_at         timestamptz,
    discarded_at      timestamptz,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (workspace_id,current_revision)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (discarded_at IS NULL OR sealed_at IS NOT NULL),
    CHECK (sealed_at IS NULL OR discarded_at IS NULL OR discarded_at >= sealed_at)
);

CREATE TABLE IF NOT EXISTS evolution_eval_dispatch (
    eval_job_id              text PRIMARY KEY REFERENCES evolution_eval_job(id),
    workspace_id             text NOT NULL,
    workspace_revision       integer NOT NULL CHECK (workspace_revision > 0),
    workspace_manifest_hash  text NOT NULL CHECK (workspace_manifest_hash ~ '^[0-9a-f]{64}$'),
    dispatch_request_hash    text NOT NULL CHECK (dispatch_request_hash ~ '^[0-9a-f]{64}$'),
    requested_timeout_ms     integer NOT NULL CHECK (requested_timeout_ms BETWEEN 1 AND 7200000),
    operation_cap_ms         integer NOT NULL DEFAULT 7200000 CHECK (operation_cap_ms = 7200000),
    deadline_at              timestamptz NOT NULL,
    audit_event_id           text NOT NULL UNIQUE,
    outbox_event_id          uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                              DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid    bigint NOT NULL DEFAULT txid_current(),
    created_at               timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (eval_job_id,workspace_id)
      REFERENCES evolution_eval_job(id,workspace_id),
    FOREIGN KEY (workspace_id,workspace_revision)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision),
    FOREIGN KEY (workspace_id,workspace_revision,workspace_manifest_hash)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision,manifest_hash),
    FOREIGN KEY (eval_job_id,deadline_at)
      REFERENCES evolution_eval_job(id,deadline_at),
    UNIQUE (eval_job_id,dispatch_request_hash)
);

CREATE TABLE IF NOT EXISTS evolution_eval_dispatch_tombstone (
    eval_job_id   text PRIMARY KEY REFERENCES evolution_eval_job(id),
    reason_code   text NOT NULL CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,127}$'),
    error_hash    text NOT NULL CHECK (error_hash ~ '^[0-9a-f]{64}$'),
    audit_event_id text NOT NULL UNIQUE,
    outbox_event_id uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                      DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS evolution_eval_evidence_fact (
    id             text PRIMARY KEY,
    eval_job_id    text NOT NULL REFERENCES evolution_eval_job(id),
    fact_type      text NOT NULL CHECK (fact_type IN (
                       'freeze_pending','frozen','corrupt','unavailable_at_deadline',
                       'ack_pending','acknowledged','quarantine_pending','expired',
                       'cleanup_pending','cleaned'
                     )),
    manifest_hash  text CHECK (manifest_hash IS NULL OR manifest_hash ~ '^[0-9a-f]{64}$'),
    error_code     text CHECK (
                       error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'
                     ),
    fact_hash      text NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
    manifest       jsonb CHECK (
                     manifest IS NULL OR (
                       jsonb_typeof(manifest)='object'
                       AND manifest->>'schema'='evolution-eval-evidence-manifest.v1'
                     )
                   ),
    entry_count    integer NOT NULL DEFAULT 0 CHECK (entry_count BETWEEN 0 AND 128),
    total_bytes    bigint NOT NULL DEFAULT 0 CHECK (total_bytes BETWEEN 0 AND 268435456),
    audit_event_id text NOT NULL UNIQUE,
    outbox_event_id uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                      DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (eval_job_id,fact_type),
    UNIQUE (id,eval_job_id),
    UNIQUE (id,eval_job_id,fact_type),
    CHECK ((fact_type IN ('frozen','ack_pending','acknowledged','expired')) = (manifest_hash IS NOT NULL)),
    CHECK ((fact_type='frozen') = (manifest IS NOT NULL)),
    CHECK ((fact_type IN ('corrupt','unavailable_at_deadline')) = (error_code IS NOT NULL)),
    CHECK (
      (fact_type='frozen')
      OR (entry_count=0 AND total_bytes=0)
    )
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_evidence_frozen_manifest_idx
  ON evolution_eval_evidence_fact(eval_job_id,manifest_hash)
  WHERE fact_type='frozen';
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_evidence_one_conclusion_idx
  ON evolution_eval_evidence_fact(eval_job_id)
  WHERE fact_type IN ('frozen','corrupt','unavailable_at_deadline');

CREATE TABLE IF NOT EXISTS evolution_eval_evidence_entry (
    id                       text PRIMARY KEY,
    evidence_fact_id         text NOT NULL,
    eval_job_id              text NOT NULL REFERENCES evolution_eval_job(id),
    fact_type                text NOT NULL DEFAULT 'frozen' CHECK (fact_type='frozen'),
    name                     text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$'),
    sha256                   text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size_bytes               bigint NOT NULL CHECK (size_bytes BETWEEN 0 AND 67108864),
    media_type               text NOT NULL CHECK (
                               media_type IN ('application/json','text/plain','application/octet-stream')
                             ),
    artifact_classification  text NOT NULL CHECK (
                               artifact_classification IN (
                                 'experimental/evolution_eval','evolution_eval_evidence'
                               )
                             ),
    usage_classification     text NOT NULL DEFAULT 'evolution_eval_only'
                               CHECK (usage_classification = 'evolution_eval_only'),
    managed_content          bytea NOT NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (evidence_fact_id,name),
    UNIQUE (eval_job_id,name),
    FOREIGN KEY (evidence_fact_id,eval_job_id,fact_type)
      REFERENCES evolution_eval_evidence_fact(id,eval_job_id,fact_type)
      DEFERRABLE INITIALLY DEFERRED,
    CHECK (octet_length(managed_content) = size_bytes),
    CHECK (encode(digest(managed_content,'sha256'),'hex') = sha256),
    CHECK (
      (lower(name) ~ '\.json$' AND media_type = 'application/json')
      OR (lower(name) ~ '\.(rpt|log|tcl)$' AND media_type = 'text/plain')
      OR (lower(name) ~ '\.(bit|dcp)$' AND media_type = 'application/octet-stream')
      OR lower(name) !~ '\.(json|rpt|log|tcl|bit|dcp)$'
    ),
    CHECK (
      (lower(name) ~ '\.bit$' AND artifact_classification = 'experimental/evolution_eval')
      OR (lower(name) !~ '\.bit$' AND artifact_classification = 'evolution_eval_evidence')
    )
);

CREATE TABLE IF NOT EXISTS evolution_eval_idempotency (
    id                text PRIMARY KEY,
    scope             text NOT NULL CHECK (scope = 'core:evolution-eval'),
    curator_run_id    text NOT NULL REFERENCES curator_run(id),
    eval_job_id       text,
    action            text NOT NULL CHECK (btrim(action) <> ''),
    idempotency_key   text NOT NULL CHECK (
                        octet_length(idempotency_key) BETWEEN 1 AND 128
                        AND idempotency_key !~ '[[:cntrl:]]'
                      ),
    request_hash      text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    response_status   integer CHECK (response_status BETWEEN 200 AND 299),
    response          jsonb CHECK (response IS NULL OR jsonb_typeof(response) = 'object'),
    created_at        timestamptz NOT NULL DEFAULT now(),
    completed_at      timestamptz,
    FOREIGN KEY (eval_job_id,curator_run_id)
      REFERENCES evolution_eval_job(id,curator_run_id),
    CHECK ((response_status IS NULL) = (response IS NULL)),
    CHECK ((completed_at IS NULL) = (response IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_idempotency_scope_idx
  ON evolution_eval_idempotency(
    scope,curator_run_id,COALESCE(eval_job_id,''),action,idempotency_key
  );

CREATE TABLE IF NOT EXISTS evolution_eval_audit_event (
    id                       text PRIMARY KEY,
    curator_run_id           text NOT NULL REFERENCES curator_run(id),
    eval_job_id              text,
    project_id               text REFERENCES project(id),
    event_type               text NOT NULL CHECK (btrim(event_type) <> ''),
    actor_type               actor_type NOT NULL,
    actor_id                 text NOT NULL CHECK (btrim(actor_id) <> ''),
    correlation_id           text NOT NULL CHECK (btrim(correlation_id) <> ''),
    request_hash             text CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
    from_state               tool_run_state,
    to_state                 tool_run_state,
    operation                text CHECK (
                               operation IS NULL OR operation IN (
                                 'validate_sources','simulate','synthesize','implement'
                               )
                             ),
    workspace_manifest_hash  text CHECK (
                               workspace_manifest_hash IS NULL
                               OR workspace_manifest_hash ~ '^[0-9a-f]{64}$'
                             ),
    evidence_manifest_hash   text CHECK (
                               evidence_manifest_hash IS NULL
                               OR evidence_manifest_hash ~ '^[0-9a-f]{64}$'
                             ),
    file_count               integer CHECK (file_count IS NULL OR file_count BETWEEN 0 AND 5120),
    byte_count               bigint CHECK (byte_count IS NULL OR byte_count BETWEEN 0 AND 603979776),
    error_code               text CHECK (
                               error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'
                             ),
    evolution_origin_txid    bigint NOT NULL DEFAULT txid_current(),
    created_at               timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (eval_job_id,curator_run_id)
      REFERENCES evolution_eval_job(id,curator_run_id),
    CHECK ((from_state IS NULL) = (to_state IS NULL))
);
CREATE INDEX IF NOT EXISTS evolution_eval_audit_run_created_idx
  ON evolution_eval_audit_event(curator_run_id,created_at,id);

CREATE TABLE IF NOT EXISTS evolution_eval_transition_fact (
    id                   text PRIMARY KEY,
    eval_job_id          text NOT NULL REFERENCES evolution_eval_job(id),
    transition_sequence  integer NOT NULL CHECK (transition_sequence BETWEEN 1 AND 6),
    from_state           tool_run_state NOT NULL,
    to_state             tool_run_state NOT NULL,
    audit_event_id       text NOT NULL UNIQUE REFERENCES evolution_eval_audit_event(id)
                           DEFERRABLE INITIALLY DEFERRED,
    outbox_event_id      uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                           DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    created_at           timestamptz NOT NULL DEFAULT now(),
    UNIQUE (eval_job_id,transition_sequence),
    UNIQUE (eval_job_id,from_state,to_state),
    UNIQUE (id,eval_job_id),
    CHECK (
      (from_state='submitted' AND to_state IN ('rejected','queued'))
      OR (from_state='queued' AND to_state='preparing')
      OR (from_state='preparing' AND to_state IN ('running','failed','cancelled'))
      OR (from_state='running' AND to_state IN (
        'succeeded','failed','cancelling','timeout','unknown_effect'
      ))
      OR (from_state='cancelling' AND to_state='cancelled')
    )
);

CREATE TABLE IF NOT EXISTS evolution_eval_unknown_fact (
    eval_job_id        text PRIMARY KEY REFERENCES evolution_eval_job(id),
    transition_fact_id text NOT NULL UNIQUE,
    audit_event_id     text NOT NULL UNIQUE REFERENCES evolution_eval_audit_event(id)
                         DEFERRABLE INITIALLY DEFERRED,
    outbox_event_id    uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                         DEFERRABLE INITIALLY DEFERRED,
    fact_hash          text NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
    latched_at         timestamptz NOT NULL,
    evolution_origin_txid bigint NOT NULL DEFAULT txid_current(),
    FOREIGN KEY (transition_fact_id,eval_job_id)
      REFERENCES evolution_eval_transition_fact(id,eval_job_id)
      DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS evolution_eval_operation_fact (
    id                       text PRIMARY KEY,
    eval_job_id              text NOT NULL REFERENCES evolution_eval_job(id),
    fact_type                text NOT NULL CHECK (fact_type IN (
                               'prepare','workspace_revision',
                               'workspace_projection','workspace_seal'
                             )),
    workspace_id             text,
    workspace_revision       integer CHECK (workspace_revision IS NULL OR workspace_revision > 0),
    workspace_manifest_hash  text CHECK (
                               workspace_manifest_hash IS NULL
                               OR workspace_manifest_hash ~ '^[0-9a-f]{64}$'
                             ),
    audit_event_id           text NOT NULL UNIQUE REFERENCES evolution_eval_audit_event(id)
                               DEFERRABLE INITIALLY DEFERRED,
    outbox_event_id          uuid NOT NULL UNIQUE REFERENCES outbox_events(event_id)
                               DEFERRABLE INITIALLY DEFERRED,
    evolution_origin_txid    bigint NOT NULL DEFAULT txid_current(),
    created_at               timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id,eval_job_id),
    CHECK (
      (fact_type='prepare' AND workspace_id IS NULL AND workspace_revision IS NULL
       AND workspace_manifest_hash IS NULL)
      OR
      (fact_type<>'prepare' AND workspace_id IS NOT NULL AND workspace_revision IS NOT NULL
       AND workspace_manifest_hash IS NOT NULL)
    ),
    FOREIGN KEY (eval_job_id,workspace_id)
      REFERENCES evolution_eval_job(id,workspace_id)
      DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (workspace_id,workspace_revision,workspace_manifest_hash)
      REFERENCES evolution_eval_workspace_revision(workspace_id,revision,manifest_hash)
      DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_operation_prepare_idx
  ON evolution_eval_operation_fact(eval_job_id) WHERE fact_type='prepare';
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_operation_workspace_idx
  ON evolution_eval_operation_fact(workspace_id,fact_type,workspace_revision)
  WHERE fact_type IN ('workspace_revision','workspace_projection','workspace_seal');
CREATE UNIQUE INDEX IF NOT EXISTS evolution_eval_operation_seal_idx
  ON evolution_eval_operation_fact(workspace_id) WHERE fact_type='workspace_seal';

ALTER TABLE evolution_eval_dispatch
  ADD CONSTRAINT evolution_eval_dispatch_audit_fk
  FOREIGN KEY (audit_event_id) REFERENCES evolution_eval_audit_event(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE evolution_eval_dispatch_tombstone
  ADD CONSTRAINT evolution_eval_tombstone_audit_fk
  FOREIGN KEY (audit_event_id) REFERENCES evolution_eval_audit_event(id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE evolution_eval_evidence_fact
  ADD CONSTRAINT evolution_eval_evidence_audit_fk
  FOREIGN KEY (audit_event_id) REFERENCES evolution_eval_audit_event(id)
  DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION synthia_stamp_evolution_eval_origin()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.evolution_origin_txid=txid_current();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_outbox_origin_stamp ON outbox_events;
CREATE TRIGGER evolution_eval_outbox_origin_stamp BEFORE INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_dispatch_origin_stamp ON evolution_eval_dispatch;
CREATE TRIGGER evolution_eval_dispatch_origin_stamp BEFORE INSERT ON evolution_eval_dispatch
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_tombstone_origin_stamp ON evolution_eval_dispatch_tombstone;
CREATE TRIGGER evolution_eval_tombstone_origin_stamp BEFORE INSERT ON evolution_eval_dispatch_tombstone
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_evidence_origin_stamp ON evolution_eval_evidence_fact;
CREATE TRIGGER evolution_eval_evidence_origin_stamp BEFORE INSERT ON evolution_eval_evidence_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_audit_origin_stamp ON evolution_eval_audit_event;
CREATE TRIGGER evolution_eval_audit_origin_stamp BEFORE INSERT ON evolution_eval_audit_event
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_transition_origin_stamp ON evolution_eval_transition_fact;
CREATE TRIGGER evolution_eval_transition_origin_stamp BEFORE INSERT ON evolution_eval_transition_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_unknown_origin_stamp ON evolution_eval_unknown_fact;
CREATE TRIGGER evolution_eval_unknown_origin_stamp BEFORE INSERT ON evolution_eval_unknown_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_operation_origin_stamp ON evolution_eval_operation_fact;
CREATE TRIGGER evolution_eval_operation_origin_stamp BEFORE INSERT ON evolution_eval_operation_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_job_origin_stamp ON evolution_eval_job;
CREATE TRIGGER evolution_eval_job_origin_stamp BEFORE INSERT ON evolution_eval_job
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();
DROP TRIGGER IF EXISTS evolution_eval_workspace_projection_origin_stamp ON evolution_eval_workspace_projection;
CREATE TRIGGER evolution_eval_workspace_projection_origin_stamp
  BEFORE INSERT ON evolution_eval_workspace_projection
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_origin();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_insert_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  locked_run evolution_eval_run%ROWTYPE;
  existing_jobs integer;
  prior_tool_run_id text;
  prior_state text;
BEGIN
  SELECT r.* INTO locked_run FROM evolution_eval_run r
   WHERE r.curator_run_id=NEW.curator_run_id FOR UPDATE;
  IF NOT FOUND OR locked_run.unknown_effect_latched_at IS NOT NULL THEN
    RAISE EXCEPTION 'evolution eval unknown-effect latch forbids new jobs'
      USING ERRCODE='23514';
  END IF;
  SELECT count(*)::integer INTO existing_jobs FROM evolution_eval_job j
   WHERE j.curator_run_id=NEW.curator_run_id;
  IF existing_jobs>=locked_run.max_jobs OR NEW.ordinal<>existing_jobs+1 THEN
    RAISE EXCEPTION 'evolution eval job ordinal must be the next authoritative run ordinal'
      USING ERRCODE='23514';
  END IF;
  IF NEW.ordinal>1 THEN
    SELECT j.tool_run_id INTO prior_tool_run_id FROM evolution_eval_job j
     WHERE j.curator_run_id=NEW.curator_run_id AND j.ordinal=NEW.ordinal-1
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'evolution eval prior ordinal job is missing'
        USING ERRCODE='23514';
    END IF;
    SELECT r.state::text INTO prior_state FROM tool_run r
     WHERE r.id=prior_tool_run_id FOR UPDATE;
    IF prior_state NOT IN ('rejected','succeeded','failed','cancelled','timeout') THEN
      RAISE EXCEPTION 'evolution eval prior ordinal must be terminal before the next job'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_job_insert_fence_guard ON evolution_eval_job;
CREATE TRIGGER evolution_eval_job_insert_fence_guard BEFORE INSERT ON evolution_eval_job
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_job_insert_fence();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_dispatch_insert_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_curator_run_id text;
  bound_tool_run_id text;
  bound_state text;
BEGIN
  SELECT j.curator_run_id INTO bound_curator_run_id
    FROM evolution_eval_job j WHERE j.id=NEW.eval_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval dispatch requires its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  PERFORM 1 FROM evolution_eval_run r
   WHERE r.curator_run_id=bound_curator_run_id
     AND r.unknown_effect_latched_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval unknown-effect latch forbids dispatch'
      USING ERRCODE='23514';
  END IF;
  SELECT j.tool_run_id INTO bound_tool_run_id
    FROM evolution_eval_job j
   WHERE j.id=NEW.eval_job_id AND j.curator_run_id=bound_curator_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval dispatch lost its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  SELECT r.state::text INTO bound_state
    FROM tool_run r WHERE r.id=bound_tool_run_id FOR UPDATE;
  IF bound_state IS DISTINCT FROM 'submitted'
     OR EXISTS (
       SELECT 1 FROM evolution_eval_dispatch_tombstone t
        WHERE t.eval_job_id=NEW.eval_job_id
     ) THEN
    RAISE EXCEPTION 'evolution eval dispatch requires submitted state without tombstone'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_dispatch_insert_fence_guard ON evolution_eval_dispatch;
CREATE TRIGGER evolution_eval_dispatch_insert_fence_guard
  BEFORE INSERT ON evolution_eval_dispatch
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_dispatch_insert_fence();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_transition_fence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_curator_run_id text;
  bound_tool_run_id text;
  bound_state text;
BEGIN
  IF NEW.from_state::text<>'submitted'
     OR NEW.to_state::text NOT IN ('queued','rejected') THEN
    RETURN NEW;
  END IF;
  SELECT j.curator_run_id INTO bound_curator_run_id
    FROM evolution_eval_job j WHERE j.id=NEW.eval_job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval transition fence requires its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  IF NEW.to_state::text='queued' THEN
    PERFORM 1 FROM evolution_eval_run r
     WHERE r.curator_run_id=bound_curator_run_id
       AND r.unknown_effect_latched_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'evolution eval unknown-effect latch forbids the effect fence'
        USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT j.tool_run_id INTO bound_tool_run_id
    FROM evolution_eval_job j
   WHERE j.id=NEW.eval_job_id AND j.curator_run_id=bound_curator_run_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'evolution eval transition fence lost its authoritative job lock'
      USING ERRCODE='23514';
  END IF;
  SELECT r.state::text INTO bound_state
    FROM tool_run r WHERE r.id=bound_tool_run_id FOR UPDATE;
  IF bound_state IS DISTINCT FROM 'submitted' THEN
    RAISE EXCEPTION 'evolution eval transition fence lost submitted-state CAS'
      USING ERRCODE='23514';
  END IF;
  IF NEW.to_state::text='queued' AND (
    NOT EXISTS (
      SELECT 1 FROM evolution_eval_dispatch d WHERE d.eval_job_id=NEW.eval_job_id
    ) OR EXISTS (
      SELECT 1 FROM evolution_eval_dispatch_tombstone t
       WHERE t.eval_job_id=NEW.eval_job_id
    )
  ) THEN
    RAISE EXCEPTION 'evolution eval effect fence requires dispatch without tombstone'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_transition_fence_guard ON evolution_eval_transition_fact;
CREATE TRIGGER evolution_eval_transition_fence_guard
  BEFORE INSERT ON evolution_eval_transition_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_transition_fence();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_input(binding_ref text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  binding evolution_eval_input%ROWTYPE;
  actual_files jsonb;
  actual_skill_files jsonb;
  actual_file_count integer;
  actual_total_bytes bigint;
  actual_skill_file_count integer;
  actual_skill_total_bytes bigint;
  manifest_keys text[];
BEGIN
  SELECT i.* INTO binding FROM evolution_eval_input i WHERE i.eval_input_ref=binding_ref;
  IF NOT FOUND THEN RETURN; END IF;
  IF cardinality(binding.allowed_operations) IS DISTINCT FROM (
    SELECT count(DISTINCT operation)::integer FROM unnest(binding.allowed_operations) operation
  ) THEN
    RAISE EXCEPTION 'evolution eval allowed operations must be unique' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM skill_application a
    JOIN skill_application_skill primary_skill
      ON primary_skill.application_id=a.id
     AND primary_skill.version_id=binding.version_id
     AND primary_skill.role='primary'
    WHERE a.id=binding.application_id AND a.project_id=binding.project_id
  ) THEN
    RAISE EXCEPTION 'evolution eval input must bind the application primary version'
      USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'path',f.path,'sha256',f.sha256,'size_bytes',f.size_bytes,
           'media_type',f.media_type
         ) ORDER BY translate(f.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",
                    f.path COLLATE "C"),'[]'::jsonb),
         count(*)::integer,COALESCE(sum(f.size_bytes),0)::bigint
    INTO actual_files,actual_file_count,actual_total_bytes
    FROM evolution_eval_input_file f WHERE f.eval_input_ref=binding_ref;
  IF actual_file_count > 4096 OR actual_total_bytes > 536870912 THEN
    RAISE EXCEPTION 'evolution eval source input budget exceeded' USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_input_skill_file input_skill
    LEFT JOIN learned_skill_file learned ON learned.id=input_skill.learned_skill_file_id
     WHERE input_skill.eval_input_ref=binding_ref
       AND (
         learned.id IS NULL OR learned.version_id<>binding.version_id
         OR input_skill.version_id<>binding.version_id
         OR learned.path<>input_skill.path OR learned.kind<>input_skill.kind
         OR learned.language IS DISTINCT FROM input_skill.language
         OR learned.sha256<>input_skill.sha256 OR learned.size_bytes<>input_skill.size_bytes
         OR learned.media_type<>input_skill.media_type OR learned.content<>input_skill.content
       )
  ) OR EXISTS (
    SELECT 1 FROM learned_skill_file learned
     WHERE learned.version_id=binding.version_id
       AND NOT EXISTS (
         SELECT 1 FROM evolution_eval_input_skill_file input_skill
          WHERE input_skill.eval_input_ref=binding_ref
            AND input_skill.learned_skill_file_id=learned.id
       )
  ) THEN
    RAISE EXCEPTION 'evolution eval skill input must exactly bind the fixed SkillVersion files'
      USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'path',f.path,'kind',f.kind,'language',f.language,'sha256',f.sha256,
           'size_bytes',f.size_bytes,'media_type',f.media_type
         ) ORDER BY translate(f.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",
                    f.path COLLATE "C"),'[]'::jsonb),
         count(*)::integer,COALESCE(sum(f.size_bytes),0)::bigint
    INTO actual_skill_files,actual_skill_file_count,actual_skill_total_bytes
    FROM evolution_eval_input_skill_file f WHERE f.eval_input_ref=binding_ref;
  IF actual_skill_file_count>512 OR actual_skill_total_bytes>33554432 THEN
    RAISE EXCEPTION 'evolution eval skill input budget exceeded' USING ERRCODE='23514';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO manifest_keys
    FROM jsonb_object_keys(binding.input_manifest) key;
  IF manifest_keys IS DISTINCT FROM ARRAY[
    'allowed_operations','application_id','curator_run_id','eval_input_ref',
    'evidence_snapshot_hash','files','part','project_id','schema','skill_files','source_commit',
    'source_manifest_hash','toolchain_profile_hash','trial_bitstream_allowed','version_id'
  ]::text[]
     OR binding.input_manifest->>'schema' <> 'evolution-eval-input-manifest.v1'
     OR binding.input_manifest->>'eval_input_ref' <> binding.eval_input_ref
     OR binding.input_manifest->>'curator_run_id' <> binding.curator_run_id
     OR binding.input_manifest->>'application_id' <> binding.application_id
     OR binding.input_manifest->>'project_id' <> binding.project_id
     OR binding.input_manifest->>'version_id' <> binding.version_id
     OR binding.input_manifest->>'evidence_snapshot_hash' <> binding.evidence_snapshot_hash
     OR binding.input_manifest->>'source_commit' <> binding.source_commit
     OR binding.input_manifest->>'source_manifest_hash' <> binding.source_manifest_hash
     OR binding.input_manifest->>'toolchain_profile_hash' <> binding.toolchain_profile_hash
     OR binding.input_manifest->'allowed_operations' IS DISTINCT FROM to_jsonb(binding.allowed_operations)
     OR binding.input_manifest->'trial_bitstream_allowed' IS DISTINCT FROM to_jsonb(binding.trial_bitstream_allowed)
     OR binding.input_manifest->'part' IS DISTINCT FROM to_jsonb(binding.part)
     OR binding.input_manifest->'files' IS DISTINCT FROM actual_files
     OR binding.input_manifest->'skill_files' IS DISTINCT FROM actual_skill_files THEN
    RAISE EXCEPTION 'evolution eval input manifest does not match immutable binding/files'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_input_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_input(COALESCE(NEW.eval_input_ref,OLD.eval_input_ref));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_input_commit_guard ON evolution_eval_input;
CREATE CONSTRAINT TRIGGER evolution_eval_input_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_input
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_input_commit();
DROP TRIGGER IF EXISTS evolution_eval_input_file_commit_guard ON evolution_eval_input_file;
CREATE CONSTRAINT TRIGGER evolution_eval_input_file_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_input_file
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_input_commit();
DROP TRIGGER IF EXISTS evolution_eval_input_skill_file_commit_guard ON evolution_eval_input_skill_file;
CREATE CONSTRAINT TRIGGER evolution_eval_input_skill_file_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_input_skill_file
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_input_commit();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_parameters(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  binding evolution_eval_input%ROWTYPE;
  parameter_keys text[];
  source_paths jsonb;
  constraint_paths jsonb;
BEGIN
  SELECT * INTO job FROM evolution_eval_job WHERE id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO binding FROM evolution_eval_input WHERE eval_input_ref=job.eval_input_ref;
  IF NOT FOUND OR NOT job.operation=ANY(binding.allowed_operations)
     OR job.parameters->>'operation' IS DISTINCT FROM job.operation THEN
    RAISE EXCEPTION 'evolution eval operation must be allowed by its immutable input binding'
      USING ERRCODE='23514';
  END IF;
  SELECT array_agg(key ORDER BY key) INTO parameter_keys
    FROM jsonb_object_keys(job.parameters) key;
  IF (job.operation='validate_sources' AND parameter_keys IS DISTINCT FROM
      ARRAY['operation','source_paths','top']::text[])
     OR (job.operation='simulate' AND parameter_keys IS DISTINCT FROM
      ARRAY['operation','source_paths','testbench','top']::text[])
     OR (job.operation='synthesize' AND parameter_keys IS DISTINCT FROM
      ARRAY['operation','part','source_paths','top']::text[])
     OR (job.operation='implement' AND parameter_keys IS DISTINCT FROM
      ARRAY['constraint_paths','generate_trial_bitstream','operation','part','source_paths','top']::text[]) THEN
    RAISE EXCEPTION 'evolution eval operation parameters have non-canonical keys'
      USING ERRCODE='23514';
  END IF;
  source_paths=job.parameters->'source_paths';
  IF jsonb_typeof(source_paths)<>'array' OR jsonb_array_length(source_paths) NOT BETWEEN 1 AND 512
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(source_paths) p
        WHERE jsonb_typeof(p)<>'string'
           OR p#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
           OR p#>>'{}' !~* '\.(v|vh|sv|svh)$'
     ) OR (
       SELECT count(*)<>count(DISTINCT translate(p#>>'{}','ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))
         FROM jsonb_array_elements(source_paths) p
     ) THEN
    RAISE EXCEPTION 'evolution eval source_paths are not unique ASCII Vivado inputs'
      USING ERRCODE='23514';
  END IF;
  IF job.parameters->'top' IS NOT NULL
     AND job.parameters->'top'<>'null'::jsonb
     AND (jsonb_typeof(job.parameters->'top')<>'string'
          OR job.parameters->>'top' !~ '^[A-Za-z_][A-Za-z0-9_$]{0,127}$') THEN
    RAISE EXCEPTION 'evolution eval top is not a canonical HDL identifier'
      USING ERRCODE='23514';
  END IF;
  IF job.operation<>'validate_sources' AND (
    jsonb_typeof(job.parameters->'top')<>'string'
    OR job.parameters->>'top' !~ '^[A-Za-z_][A-Za-z0-9_$]{0,127}$'
  ) THEN
    RAISE EXCEPTION 'evolution eval operation requires a top identifier'
      USING ERRCODE='23514';
  END IF;
  IF job.operation='simulate' AND (
    jsonb_typeof(job.parameters->'testbench')<>'string'
    OR job.parameters->>'testbench' !~ '^[A-Za-z_][A-Za-z0-9_$]{0,127}$'
  ) THEN
    RAISE EXCEPTION 'evolution eval simulation requires a testbench identifier'
      USING ERRCODE='23514';
  END IF;
  IF job.operation IN ('synthesize','implement') AND (
    jsonb_typeof(job.parameters->'part')<>'string'
    OR job.parameters->>'part' IS DISTINCT FROM binding.part
  ) THEN
    RAISE EXCEPTION 'evolution eval part must match its immutable input binding'
      USING ERRCODE='23514';
  END IF;
  IF job.operation='implement' THEN
    constraint_paths=job.parameters->'constraint_paths';
    IF jsonb_typeof(constraint_paths)<>'array' OR jsonb_array_length(constraint_paths)>128
       OR EXISTS (
         SELECT 1 FROM jsonb_array_elements(constraint_paths) p
          WHERE jsonb_typeof(p)<>'string'
             OR p#>>'{}' !~ '^[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*){0,31}$'
             OR p#>>'{}' !~* '\.xdc$'
       ) OR (
         SELECT count(*)<>count(DISTINCT translate(p#>>'{}','ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))
           FROM jsonb_array_elements(constraint_paths) p
       ) OR jsonb_typeof(job.parameters->'generate_trial_bitstream')<>'boolean'
       OR ((job.parameters->>'generate_trial_bitstream')::boolean AND NOT binding.trial_bitstream_allowed) THEN
      RAISE EXCEPTION 'evolution eval implement parameters violate constraint/bitstream policy'
        USING ERRCODE='23514';
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_dispatch_parameters(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  workspace evolution_eval_workspace%ROWTYPE;
  projection evolution_eval_workspace_projection%ROWTYPE;
BEGIN
  SELECT j.* INTO job FROM evolution_eval_job j WHERE j.id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT w.* INTO workspace FROM evolution_eval_workspace w WHERE w.eval_job_id=job.id;
  SELECT p.* INTO projection FROM evolution_eval_workspace_projection p
    WHERE p.workspace_id=workspace.id;
  IF workspace.id IS NULL OR projection.workspace_id IS NULL OR projection.sealed_at IS NULL THEN
    RAISE EXCEPTION 'evolution eval dispatch parameters require a sealed current workspace'
      USING ERRCODE='23514';
  END IF;

  -- The immutable source layer is an exact byte-for-byte projection of the
  -- Core-issued input.  Future generated files are allowed only as overlays.
  IF EXISTS (
    SELECT 1 FROM evolution_eval_input_file input_file
     WHERE input_file.eval_input_ref=job.eval_input_ref
       AND NOT EXISTS (
         SELECT 1 FROM evolution_eval_workspace_file workspace_file
          WHERE workspace_file.workspace_id=workspace.id
            AND workspace_file.revision=projection.current_revision
            AND workspace_file.layer='source'
            AND workspace_file.path=input_file.path
            AND workspace_file.sha256=input_file.sha256
            AND workspace_file.size_bytes=input_file.size_bytes
            AND workspace_file.media_type=input_file.media_type
            AND workspace_file.managed_content=input_file.managed_content
       )
  ) OR EXISTS (
    SELECT 1 FROM evolution_eval_workspace_file workspace_file
     WHERE workspace_file.workspace_id=workspace.id
       AND workspace_file.revision=projection.current_revision
       AND workspace_file.layer='source'
       AND NOT EXISTS (
         SELECT 1 FROM evolution_eval_input_file input_file
          WHERE input_file.eval_input_ref=job.eval_input_ref
            AND input_file.path=workspace_file.path
            AND input_file.sha256=workspace_file.sha256
            AND input_file.size_bytes=workspace_file.size_bytes
            AND input_file.media_type=workspace_file.media_type
            AND input_file.managed_content=workspace_file.managed_content
       )
  ) THEN
    RAISE EXCEPTION 'evolution eval sealed source layer must exactly match immutable input'
      USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(job.parameters->'source_paths') declared(path)
     WHERE NOT EXISTS (
       SELECT 1 FROM evolution_eval_workspace_file workspace_file
        WHERE workspace_file.workspace_id=workspace.id
          AND workspace_file.revision=projection.current_revision
          AND workspace_file.path=declared.path
          AND workspace_file.layer IN ('source','overlay')
          AND (
            (workspace_file.media_type='text/x-verilog'
             AND (translate(workspace_file.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.(v|vh)$')
            OR (workspace_file.media_type='text/x-systemverilog'
                AND (translate(workspace_file.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.(sv|svh)$')
          )
     )
  ) THEN
    RAISE EXCEPTION 'evolution eval source_paths must name sealed source/overlay HDL files'
      USING ERRCODE='23514';
  END IF;

  IF job.operation='implement' AND (
    EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(job.parameters->'constraint_paths') declared(path)
       WHERE NOT EXISTS (
         SELECT 1 FROM evolution_eval_workspace_file workspace_file
          WHERE workspace_file.workspace_id=workspace.id
            AND workspace_file.revision=projection.current_revision
            AND workspace_file.path=declared.path
            AND workspace_file.layer IN ('source','overlay')
            AND workspace_file.media_type='application/x-xdc'
            AND (translate(workspace_file.path,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C") ~ '\.xdc$'
       )
    )
  ) THEN
    RAISE EXCEPTION 'evolution eval constraint_paths must name sealed source/overlay XDC files'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_operation_facts(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  tool_correlation text;
  workspace evolution_eval_workspace%ROWTYPE;
  projection evolution_eval_workspace_projection%ROWTYPE;
  revision_row evolution_eval_workspace_revision%ROWTYPE;
  operation_fact record;
  audit record;
  event record;
  expected_audit_type text;
  expected_event_type text;
  expected_payload jsonb;
BEGIN
  SELECT j.* INTO job FROM evolution_eval_job j WHERE j.id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT r.correlation_id INTO tool_correlation FROM tool_run r WHERE r.id=job.tool_run_id;
  SELECT w.* INTO workspace FROM evolution_eval_workspace w WHERE w.eval_job_id=job.id;
  SELECT p.* INTO projection FROM evolution_eval_workspace_projection p
    WHERE p.workspace_id=workspace.id;
  IF (SELECT count(*) FROM evolution_eval_operation_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='prepare')<>1 THEN
    RAISE EXCEPTION 'evolution eval job requires exactly one prepare operation fact'
      USING ERRCODE='23514';
  END IF;
  FOR revision_row IN SELECT r.* FROM evolution_eval_workspace_revision r
    WHERE r.workspace_id=workspace.id LOOP
    IF (SELECT count(*) FROM evolution_eval_operation_fact f
         WHERE f.workspace_id=workspace.id AND f.workspace_revision=revision_row.revision
           AND f.fact_type='workspace_revision')<>1
       OR (SELECT count(*) FROM evolution_eval_operation_fact f
         WHERE f.workspace_id=workspace.id AND f.workspace_revision=revision_row.revision
           AND f.fact_type='workspace_projection')<>1 THEN
      RAISE EXCEPTION 'each evolution eval revision/projection write requires typed operation facts'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (projection.sealed_at IS NULL) IS DISTINCT FROM NOT EXISTS (
    SELECT 1 FROM evolution_eval_operation_fact f
     WHERE f.workspace_id=workspace.id AND f.fact_type='workspace_seal'
  ) THEN
    RAISE EXCEPTION 'evolution eval seal projection and operation fact must be atomic'
      USING ERRCODE='23514';
  END IF;
  FOR operation_fact IN SELECT * FROM evolution_eval_operation_fact f
    WHERE f.eval_job_id=job.id LOOP
    SELECT a.* INTO audit FROM evolution_eval_audit_event a
      WHERE a.id=operation_fact.audit_event_id;
    SELECT o.* INTO event FROM outbox_events o
      WHERE o.event_id=operation_fact.outbox_event_id;
    IF operation_fact.fact_type='prepare' THEN
      SELECT r.* INTO revision_row FROM evolution_eval_workspace_revision r
       WHERE r.workspace_id=workspace.id AND r.revision=1;
      expected_audit_type='eval_job.prepared';
      expected_event_type='evolution_eval.job_prepared';
      expected_payload=jsonb_build_object(
        'fact_id',operation_fact.id,'prepare_request_hash',job.prepare_request_hash,
        'input_manifest_hash',job.input_manifest_hash,
        'workspace_manifest_hash',revision_row.manifest_hash
      );
    ELSE
      SELECT r.* INTO revision_row FROM evolution_eval_workspace_revision r
       WHERE r.workspace_id=operation_fact.workspace_id
         AND r.revision=operation_fact.workspace_revision;
      expected_audit_type=CASE operation_fact.fact_type
        WHEN 'workspace_revision' THEN 'workspace_revision'
        WHEN 'workspace_projection' THEN 'workspace_projection'
        ELSE 'workspace_sealed' END;
      expected_event_type=CASE operation_fact.fact_type
        WHEN 'workspace_revision' THEN 'evolution_eval.workspace_revision'
        WHEN 'workspace_projection' THEN 'evolution_eval.workspace_projection'
        ELSE 'evolution_eval.workspace_sealed' END;
      expected_payload=jsonb_build_object(
        'fact_id',operation_fact.id,'workspace_id',workspace.id,
        'revision',revision_row.revision,'workspace_manifest_hash',revision_row.manifest_hash,
        'file_count',revision_row.file_count,'byte_count',revision_row.total_bytes
      );
    END IF;
    IF audit.id IS NULL OR event.event_id IS NULL
       OR operation_fact.evolution_origin_txid<>audit.evolution_origin_txid
       OR operation_fact.evolution_origin_txid<>event.evolution_origin_txid
       OR audit.eval_job_id<>job.id OR audit.curator_run_id<>job.curator_run_id
       OR audit.project_id<>job.project_id OR audit.correlation_id<>tool_correlation
       OR audit.event_type<>expected_audit_type OR audit.operation<>job.operation
       OR audit.from_state IS NOT NULL OR audit.to_state IS NOT NULL
       OR audit.request_hash IS DISTINCT FROM (CASE
         WHEN operation_fact.fact_type='prepare' THEN job.prepare_request_hash ELSE NULL END)
       OR audit.workspace_manifest_hash IS DISTINCT FROM revision_row.manifest_hash
       OR audit.evidence_manifest_hash IS NOT NULL OR audit.error_code IS NOT NULL
       OR audit.file_count IS DISTINCT FROM revision_row.file_count
       OR audit.byte_count IS DISTINCT FROM revision_row.total_bytes
       OR event.aggregate_type<>'evolution_eval_job' OR event.aggregate_id<>job.id
       OR event.event_type<>expected_event_type OR event.project_id<>job.project_id
       OR event.correlation_id<>tool_correlation OR event.headers<>'{}'::jsonb
       OR event.causation_id IS NOT NULL OR event.classification<>'D1'
       OR event.payload IS DISTINCT FROM expected_payload THEN
      RAISE EXCEPTION 'evolution eval operation fact requires same-transaction exact audit/outbox'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
END;
$$;

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
    IF NOT EXISTS (SELECT 1 FROM tool_run r WHERE r.id=job.tool_run_id AND r.state='rejected')
       OR NOT EXISTS (
         SELECT 1 FROM evolution_eval_transition_fact t
          WHERE t.eval_job_id=job.id AND t.from_state='submitted' AND t.to_state='rejected'
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

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_workspace_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target text;
BEGIN
  IF TG_TABLE_NAME='evolution_eval_workspace' THEN
    target=COALESCE(NEW.id,OLD.id);
  ELSIF TG_TABLE_NAME IN ('evolution_eval_workspace_revision','evolution_eval_workspace_file','evolution_eval_workspace_projection') THEN
    target=COALESCE(NEW.workspace_id,OLD.workspace_id);
  ELSE
    SELECT workspace_id INTO target FROM evolution_eval_job
      WHERE id=COALESCE(NEW.eval_job_id,OLD.eval_job_id);
  END IF;
  PERFORM synthia_assert_evolution_eval_workspace(target);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_workspace_commit_guard ON evolution_eval_workspace;
CREATE CONSTRAINT TRIGGER evolution_eval_workspace_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_workspace DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_workspace_revision_commit_guard ON evolution_eval_workspace_revision;
CREATE CONSTRAINT TRIGGER evolution_eval_workspace_revision_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_workspace_revision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_workspace_file_commit_guard ON evolution_eval_workspace_file;
CREATE CONSTRAINT TRIGGER evolution_eval_workspace_file_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_workspace_file DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_workspace_projection_commit_guard ON evolution_eval_workspace_projection;
CREATE CONSTRAINT TRIGGER evolution_eval_workspace_projection_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_workspace_projection DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_dispatch_commit_guard ON evolution_eval_dispatch;
CREATE CONSTRAINT TRIGGER evolution_eval_dispatch_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_dispatch DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();
DROP TRIGGER IF EXISTS evolution_eval_tombstone_commit_guard ON evolution_eval_dispatch_tombstone;
CREATE CONSTRAINT TRIGGER evolution_eval_tombstone_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_dispatch_tombstone DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_commit();

CREATE OR REPLACE FUNCTION synthia_lock_evolution_eval_skill_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1
    FROM learned_skill_version skill_version
   WHERE skill_version.id=NEW.version_id
   FOR UPDATE;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_input_version_lock_guard ON evolution_eval_input;
CREATE TRIGGER evolution_eval_input_version_lock_guard
  BEFORE INSERT ON evolution_eval_input
  FOR EACH ROW EXECUTE FUNCTION synthia_lock_evolution_eval_skill_version();
DROP TRIGGER IF EXISTS evolution_eval_learned_skill_file_version_lock_guard ON learned_skill_file;
CREATE TRIGGER evolution_eval_learned_skill_file_version_lock_guard
  BEFORE INSERT ON learned_skill_file
  FOR EACH ROW EXECUTE FUNCTION synthia_lock_evolution_eval_skill_version();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_learned_skill_file_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  binding record;
  bound_workspace record;
BEGIN
  FOR binding IN
    SELECT i.eval_input_ref
      FROM evolution_eval_input i
     WHERE i.version_id=NEW.version_id
     ORDER BY i.eval_input_ref
  LOOP
    PERFORM synthia_assert_evolution_eval_input(binding.eval_input_ref);
    FOR bound_workspace IN
      SELECT w.id
        FROM evolution_eval_workspace w
       WHERE w.eval_input_ref=binding.eval_input_ref
       ORDER BY w.id
    LOOP
      PERFORM synthia_assert_evolution_eval_workspace(bound_workspace.id);
    END LOOP;
  END LOOP;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS evolution_eval_learned_skill_file_commit_guard ON learned_skill_file;
CREATE CONSTRAINT TRIGGER evolution_eval_learned_skill_file_commit_guard
  AFTER INSERT ON learned_skill_file
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_learned_skill_file_commit();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_run_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unknown_job_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evolution eval run rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.curator_run_id IS DISTINCT FROM NEW.curator_run_id
     OR OLD.budget_started_at IS DISTINCT FROM NEW.budget_started_at
     OR OLD.deadline_at IS DISTINCT FROM NEW.deadline_at
     OR OLD.max_jobs IS DISTINCT FROM NEW.max_jobs
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.unknown_effect_latched_at IS NOT NULL
         AND OLD.unknown_effect_latched_at IS DISTINCT FROM NEW.unknown_effect_latched_at)
     OR (OLD.unknown_effect_origin_txid IS NOT NULL
         AND OLD.unknown_effect_origin_txid IS DISTINCT FROM NEW.unknown_effect_origin_txid)
     OR (OLD.completed_at IS NOT NULL AND OLD.completed_at IS DISTINCT FROM NEW.completed_at) THEN
    RAISE EXCEPTION 'evolution eval run immutable facts cannot change' USING ERRCODE = '55000';
  END IF;
  IF OLD.unknown_effect_latched_at IS NULL AND NEW.unknown_effect_latched_at IS NOT NULL THEN
    SELECT j.id INTO unknown_job_id
      FROM evolution_eval_job j
      JOIN evolution_eval_transition_fact t ON t.eval_job_id=j.id
     WHERE j.curator_run_id=NEW.curator_run_id
       AND t.to_state='unknown_effect'
       AND t.evolution_origin_txid=txid_current()
     LIMIT 1 FOR UPDATE OF j;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown-effect latch requires its same-transaction job fact before latching'
        USING ERRCODE='23514';
    END IF;
    NEW.unknown_effect_origin_txid=txid_current();
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_run_mutation_guard ON evolution_eval_run;
CREATE TRIGGER evolution_eval_run_mutation_guard
  BEFORE UPDATE OR DELETE ON evolution_eval_run
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_run_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_run_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.unknown_effect_latched_at IS NOT NULL AND TG_OP='INSERT' THEN
    RAISE EXCEPTION 'initial evolution eval run cannot pre-seed unknown effect latch'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM curator_run c
     WHERE c.id=NEW.curator_run_id AND c.mode='run'
       AND c.state IN ('running','completed','failed')
  ) THEN
    RAISE EXCEPTION 'evolution eval budget requires a persistent run Curator claim'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_run_binding_guard ON evolution_eval_run;
CREATE CONSTRAINT TRIGGER evolution_eval_run_binding_guard
  AFTER INSERT OR UPDATE ON evolution_eval_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_run_binding();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_workspace_projection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.current_revision<>1 OR NEW.sealed_at IS NOT NULL OR NEW.discarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'initial evolution eval projection must be unsealed revision 1'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evolution eval workspace projection rejects delete' USING ERRCODE = '55000';
  END IF;
  IF OLD.evolution_origin_txid=txid_current() THEN
    RAISE EXCEPTION 'initial evolution eval projection revision 1 must commit before update'
      USING ERRCODE='23514';
  END IF;
  IF OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
     OR OLD.evolution_origin_txid IS DISTINCT FROM NEW.evolution_origin_txid
     OR NEW.current_revision < OLD.current_revision
     OR NEW.current_revision > OLD.current_revision + 1
     OR (OLD.sealed_at IS NOT NULL AND OLD.sealed_at IS DISTINCT FROM NEW.sealed_at)
     OR (OLD.discarded_at IS NOT NULL AND OLD.discarded_at IS DISTINCT FROM NEW.discarded_at)
     OR (NEW.current_revision > OLD.current_revision AND OLD.sealed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'evolution eval workspace projection is monotonic' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_workspace_projection_guard ON evolution_eval_workspace_projection;
CREATE TRIGGER evolution_eval_workspace_projection_guard
  BEFORE INSERT OR UPDATE OR DELETE ON evolution_eval_workspace_projection
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_workspace_projection();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_tool_run()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_run_id text;
BEGIN
  IF NEW.run_class::text <> 'evolution_eval' AND OLD.run_class::text <> 'evolution_eval' THEN
    RETURN NEW;
  END IF;
  IF OLD.run_class IS DISTINCT FROM NEW.run_class THEN
    RAISE EXCEPTION 'evolution eval run class is immutable' USING ERRCODE = '55000';
  END IF;
  IF NEW.state::text = 'lost' THEN
    RAISE EXCEPTION 'lost is not valid for evolution eval' USING ERRCODE = '23514';
  END IF;
  IF OLD.state IS NOT DISTINCT FROM NEW.state THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.state::text = 'submitted' AND NEW.state::text IN ('rejected','queued'))
    OR (OLD.state::text = 'queued' AND NEW.state::text = 'preparing')
    OR (OLD.state::text = 'preparing' AND NEW.state::text IN ('running','failed','cancelled'))
    OR (OLD.state::text = 'running' AND NEW.state::text IN (
      'succeeded','failed','cancelling','timeout','unknown_effect'
    ))
    OR (OLD.state::text = 'cancelling' AND NEW.state::text = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'illegal evolution eval tool run transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = '55000';
  END IF;
  SELECT curator_run_id INTO job_run_id
    FROM evolution_eval_job WHERE tool_run_id = NEW.id;
  IF job_run_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM evolution_eval_audit_event a
     WHERE a.eval_job_id = (SELECT id FROM evolution_eval_job WHERE tool_run_id=NEW.id)
       AND a.from_state = OLD.state AND a.to_state = NEW.state
  ) THEN
    RAISE EXCEPTION 'evolution eval transition requires append-only audit' USING ERRCODE = '23514';
  END IF;
  IF NEW.state::text = 'unknown_effect' AND job_run_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM evolution_eval_run r
       WHERE r.curator_run_id=job_run_id AND r.unknown_effect_latched_at IS NOT NULL
    ) OR NOT EXISTS (
      SELECT 1 FROM outbox_events o
       WHERE o.aggregate_type='evolution_eval_job'
         AND o.aggregate_id=(SELECT id FROM evolution_eval_job WHERE tool_run_id=NEW.id)
         AND o.event_type='evolution_eval.unknown_effect'
    ) THEN
      RAISE EXCEPTION 'unknown effect requires run latch and durable outbox' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_guard ON tool_run;
CREATE CONSTRAINT TRIGGER evolution_eval_tool_run_guard
  AFTER UPDATE OF state,run_class ON tool_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_tool_run();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evolution eval job binding rejects delete' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.id IS DISTINCT FROM NEW.id OR OLD.curator_run_id IS DISTINCT FROM NEW.curator_run_id
    OR OLD.application_id IS DISTINCT FROM NEW.application_id OR OLD.project_id IS DISTINCT FROM NEW.project_id
    OR OLD.version_id IS DISTINCT FROM NEW.version_id OR OLD.eval_input_ref IS DISTINCT FROM NEW.eval_input_ref
    OR OLD.input_manifest_hash IS DISTINCT FROM NEW.input_manifest_hash
    OR OLD.evidence_snapshot_hash IS DISTINCT FROM NEW.evidence_snapshot_hash
    OR OLD.tool_run_id IS DISTINCT FROM NEW.tool_run_id OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.connector_job_id IS DISTINCT FROM NEW.connector_job_id
    OR OLD.connector_idempotency_key IS DISTINCT FROM NEW.connector_idempotency_key
    OR OLD.request_key IS DISTINCT FROM NEW.request_key OR OLD.prepare_request_hash IS DISTINCT FROM NEW.prepare_request_hash
    OR OLD.ordinal IS DISTINCT FROM NEW.ordinal OR OLD.operation IS DISTINCT FROM NEW.operation
    OR OLD.parameters IS DISTINCT FROM NEW.parameters OR OLD.requested_timeout_ms IS DISTINCT FROM NEW.requested_timeout_ms
    OR OLD.effective_timeout_ms IS DISTINCT FROM NEW.effective_timeout_ms OR OLD.deadline_at IS DISTINCT FROM NEW.deadline_at
    OR OLD.evolution_origin_txid IS DISTINCT FROM NEW.evolution_origin_txid
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
  ) THEN
    RAISE EXCEPTION 'evolution eval immutable job binding cannot change' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM tool_run r
     WHERE r.id=NEW.tool_run_id AND r.project_id=NEW.project_id
       AND r.run_class::text='evolution_eval'
       AND r.operation=NEW.operation
       AND r.state::text <> 'lost'
  ) THEN
    RAISE EXCEPTION 'evolution eval job and tool run binding mismatch' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM evolution_eval_run r
     WHERE r.curator_run_id=NEW.curator_run_id
       AND NEW.deadline_at <= r.deadline_at
  ) THEN
    RAISE EXCEPTION 'evolution eval job exceeds run deadline' USING ERRCODE = '23514';
  END IF;
  PERFORM synthia_assert_evolution_eval_parameters(NEW.id);
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_job_binding_guard ON evolution_eval_job;
CREATE CONSTRAINT TRIGGER evolution_eval_job_binding_guard
  AFTER INSERT OR UPDATE OR DELETE ON evolution_eval_job
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_job_binding();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_stable_state()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  committed_state text;
  committed_class text;
BEGIN
  SELECT state::text,run_class::text INTO committed_state,committed_class
    FROM tool_run WHERE id=NEW.id;
  IF committed_class='evolution_eval'
     AND committed_state IN ('queued','preparing','cancelling') THEN
    RAISE EXCEPTION 'evolution eval intermediate state cannot be committed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_stable_state_guard ON tool_run;
CREATE CONSTRAINT TRIGGER evolution_eval_stable_state_guard
  AFTER INSERT OR UPDATE OF state,run_class ON tool_run
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_stable_state();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_tool_run_initial()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.run_class::text='evolution_eval' THEN
    IF TG_OP<>'INSERT' OR NEW.state::text<>'submitted'
       OR NEW.start_time IS NOT NULL OR NEW.end_time IS NOT NULL THEN
      RAISE EXCEPTION 'evolution eval ToolRun must be inserted as submitted and cannot be reclassified'
        USING ERRCODE='23514';
    END IF;
  ELSIF TG_OP='UPDATE' AND OLD.run_class::text='evolution_eval' THEN
    RAISE EXCEPTION 'evolution eval run class is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_initial_guard ON tool_run;
CREATE TRIGGER evolution_eval_tool_run_initial_guard
  BEFORE INSERT OR UPDATE OF run_class ON tool_run
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_tool_run_initial();

CREATE OR REPLACE FUNCTION synthia_guard_evolution_eval_tool_run_binding_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.run_class::text<>'evolution_eval' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval ToolRun rejects delete' USING ERRCODE='55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.project_id IS DISTINCT FROM NEW.project_id
     OR OLD.operation IS DISTINCT FROM NEW.operation OR OLD.run_class IS DISTINCT FROM NEW.run_class
     OR OLD.input_manifest_hash IS DISTINCT FROM NEW.input_manifest_hash
     OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (OLD.start_time IS NOT NULL AND OLD.start_time IS DISTINCT FROM NEW.start_time)
     OR (OLD.end_time IS NOT NULL AND OLD.end_time IS DISTINCT FROM NEW.end_time) THEN
    RAISE EXCEPTION 'evolution eval ToolRun immutable binding/time cannot change'
      USING ERRCODE='55000';
  END IF;
  IF NEW.state::text IN ('rejected','succeeded','failed','cancelled','timeout','unknown_effect') THEN
    IF NEW.end_time IS NULL THEN
      RAISE EXCEPTION 'terminal evolution eval ToolRun requires immutable terminal time'
        USING ERRCODE='23514';
    END IF;
  ELSIF NEW.end_time IS NOT NULL THEN
    RAISE EXCEPTION 'non-terminal evolution eval ToolRun cannot set terminal time'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_binding_mutation_guard ON tool_run;
CREATE TRIGGER evolution_eval_tool_run_binding_mutation_guard
  BEFORE UPDATE OR DELETE ON tool_run
  FOR EACH ROW EXECUTE FUNCTION synthia_guard_evolution_eval_tool_run_binding_mutation();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_run(target_run_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  run evolution_eval_run%ROWTYPE;
  unknown_count integer;
  first_latch timestamptz;
BEGIN
  SELECT * INTO run FROM evolution_eval_run WHERE curator_run_id=target_run_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT count(*)::integer,min(u.latched_at) INTO unknown_count,first_latch
    FROM evolution_eval_unknown_fact u
    JOIN evolution_eval_job j ON j.id=u.eval_job_id
   WHERE j.curator_run_id=target_run_id;
  IF (run.unknown_effect_latched_at IS NULL AND unknown_count<>0)
     OR (run.unknown_effect_latched_at IS NOT NULL
         AND (unknown_count<>1 OR first_latch<>run.unknown_effect_latched_at)) THEN
    RAISE EXCEPTION 'evolution eval unknown latch and per-job fact must be atomic and exact'
      USING ERRCODE='23514';
  END IF;
  IF run.unknown_effect_latched_at IS NOT NULL AND (
    EXISTS (
      SELECT 1 FROM evolution_eval_job j
       WHERE j.curator_run_id=target_run_id
         AND j.evolution_origin_txid>=run.unknown_effect_origin_txid
    ) OR EXISTS (
      SELECT 1 FROM evolution_eval_dispatch d
      JOIN evolution_eval_job j ON j.id=d.eval_job_id
       WHERE j.curator_run_id=target_run_id
         AND d.evolution_origin_txid>=run.unknown_effect_origin_txid
    ) OR EXISTS (
      SELECT 1 FROM evolution_eval_transition_fact t
      JOIN evolution_eval_job j ON j.id=t.eval_job_id
       WHERE j.curator_run_id=target_run_id
         AND t.from_state='submitted' AND t.to_state='queued'
         AND t.evolution_origin_txid>=run.unknown_effect_origin_txid
    )
  ) THEN
    RAISE EXCEPTION 'unknown-effect latch forbids same-or-later job/dispatch/effect facts'
      USING ERRCODE='23514';
  END IF;
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
  IF run_row.state::text<>'rejected' AND EXISTS (
    SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.eval_job_id=job.id
  ) THEN
    RAISE EXCEPTION 'dispatch tombstone requires rejected terminal projection'
      USING ERRCODE='23514';
  END IF;
  PERFORM synthia_assert_evolution_eval_parameters(job.id);
  PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_tool_run_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_job text;
  final_class text;
BEGIN
  SELECT run_class::text INTO final_class FROM tool_run WHERE id=COALESCE(NEW.id,OLD.id);
  SELECT id INTO target_job FROM evolution_eval_job WHERE tool_run_id=COALESCE(NEW.id,OLD.id);
  IF final_class='evolution_eval' AND target_job IS NULL THEN
    RAISE EXCEPTION 'evolution eval ToolRun cannot commit without its one-to-one job binding'
      USING ERRCODE='23514';
  END IF;
  IF target_job IS NOT NULL THEN PERFORM synthia_assert_evolution_eval_job(target_job); END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_tool_run_commit_guard ON tool_run;
CREATE CONSTRAINT TRIGGER evolution_eval_tool_run_commit_guard
  AFTER INSERT OR UPDATE OR DELETE ON tool_run DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION synthia_validate_evolution_eval_tool_run_commit();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_job_fact_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_job text;
BEGIN
  target_job=COALESCE(NEW.eval_job_id,OLD.eval_job_id);
  PERFORM synthia_assert_evolution_eval_job(target_job);
  PERFORM synthia_assert_evolution_eval_run((SELECT curator_run_id FROM evolution_eval_job WHERE id=target_job));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_transition_commit_guard ON evolution_eval_transition_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_transition_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_transition_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_job_fact_commit();
DROP TRIGGER IF EXISTS evolution_eval_unknown_commit_guard ON evolution_eval_unknown_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_unknown_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_unknown_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_job_fact_commit();
DROP TRIGGER IF EXISTS evolution_eval_operation_commit_guard ON evolution_eval_operation_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_operation_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_operation_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_job_fact_commit();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_run_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_run(COALESCE(NEW.curator_run_id,OLD.curator_run_id));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_run_commit_guard ON evolution_eval_run;
CREATE CONSTRAINT TRIGGER evolution_eval_run_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_run DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_run_commit();

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
  ELSE
    PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_audit_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_audit(COALESCE(NEW.id,OLD.id));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_audit_commit_guard ON evolution_eval_audit_event;
CREATE CONSTRAINT TRIGGER evolution_eval_audit_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_audit_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_audit_commit();

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
  ELSE
    PERFORM synthia_assert_evolution_eval_operation_facts(job.id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_guard_evolution_eval_outbox_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  protected boolean;
BEGIN
  protected=(OLD.aggregate_type='evolution_eval_job' OR OLD.event_type ~ '^evolution_eval\.'
    OR EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.outbox_event_id=OLD.event_id)
    OR EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.outbox_event_id=OLD.event_id)
    OR EXISTS (SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.outbox_event_id=OLD.event_id)
    OR EXISTS (SELECT 1 FROM evolution_eval_evidence_fact e WHERE e.outbox_event_id=OLD.event_id)
    OR EXISTS (SELECT 1 FROM evolution_eval_operation_fact f WHERE f.outbox_event_id=OLD.event_id));
  IF TG_OP='UPDATE' THEN
    protected=protected OR NEW.aggregate_type='evolution_eval_job'
      OR NEW.event_type ~ '^evolution_eval\.';
  END IF;
  IF NOT protected THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval outbox is immutable except first publication timestamp'
      USING ERRCODE='55000';
  END IF;
  IF NOT (
    OLD.event_id IS NOT DISTINCT FROM NEW.event_id
    AND OLD.aggregate_type IS NOT DISTINCT FROM NEW.aggregate_type
    AND OLD.aggregate_id IS NOT DISTINCT FROM NEW.aggregate_id
    AND OLD.sequence IS NOT DISTINCT FROM NEW.sequence
    AND OLD.event_type IS NOT DISTINCT FROM NEW.event_type
    AND OLD.project_id IS NOT DISTINCT FROM NEW.project_id
    AND OLD.payload IS NOT DISTINCT FROM NEW.payload
    AND OLD.headers IS NOT DISTINCT FROM NEW.headers
    AND OLD.correlation_id IS NOT DISTINCT FROM NEW.correlation_id
    AND OLD.causation_id IS NOT DISTINCT FROM NEW.causation_id
    AND OLD.classification IS NOT DISTINCT FROM NEW.classification
    AND OLD.evolution_origin_txid IS NOT DISTINCT FROM NEW.evolution_origin_txid
    AND OLD.occurred_at IS NOT DISTINCT FROM NEW.occurred_at
    AND OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'evolution eval outbox is immutable except first publication timestamp'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_outbox_mutation_guard ON outbox_events;
CREATE TRIGGER evolution_eval_outbox_mutation_guard BEFORE UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION synthia_guard_evolution_eval_outbox_mutation();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_outbox_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(NEW.aggregate_type,OLD.aggregate_type)='evolution_eval_job'
     OR COALESCE(NEW.event_type,OLD.event_type) ~ '^evolution_eval\.'
     OR EXISTS (SELECT 1 FROM evolution_eval_transition_fact t WHERE t.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id))
     OR EXISTS (SELECT 1 FROM evolution_eval_dispatch d WHERE d.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id))
     OR EXISTS (SELECT 1 FROM evolution_eval_dispatch_tombstone t WHERE t.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id))
     OR EXISTS (SELECT 1 FROM evolution_eval_evidence_fact e WHERE e.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id))
     OR EXISTS (SELECT 1 FROM evolution_eval_operation_fact f WHERE f.outbox_event_id=COALESCE(NEW.event_id,OLD.event_id)) THEN
    PERFORM synthia_assert_evolution_eval_outbox(COALESCE(NEW.event_id,OLD.event_id));
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_outbox_commit_guard ON outbox_events;
CREATE CONSTRAINT TRIGGER evolution_eval_outbox_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON outbox_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_outbox_commit();

CREATE OR REPLACE FUNCTION synthia_stamp_evolution_eval_evidence_fact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_evidence_fact_stamp_guard ON evolution_eval_evidence_fact;
CREATE TRIGGER evolution_eval_evidence_fact_stamp_guard
  BEFORE INSERT ON evolution_eval_evidence_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_stamp_evolution_eval_evidence_fact();

CREATE OR REPLACE FUNCTION synthia_assert_evolution_eval_evidence(target_job_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  job evolution_eval_job%ROWTYPE;
  run_state text;
  run_end_time timestamptz;
  tool_correlation text;
  fact record;
  prior_xid bigint;
  audit record;
  event record;
  frozen evolution_eval_evidence_fact%ROWTYPE;
  actual_entries jsonb;
  actual_count integer;
  actual_bytes bigint;
  expected_event_type text;
  expected_payload jsonb;
BEGIN
  SELECT * INTO job FROM evolution_eval_job WHERE id=target_job_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT state::text,end_time,correlation_id INTO run_state,run_end_time,tool_correlation
    FROM tool_run WHERE id=job.tool_run_id;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_evidence_fact f
     WHERE f.eval_job_id=job.id AND f.fact_type='freeze_pending'
  ) AND run_state NOT IN ('succeeded','failed','cancelled','timeout') THEN
    RAISE EXCEPTION 'freeze intent requires an accepted terminal evolution eval job'
      USING ERRCODE='23514';
  END IF;
  IF EXISTS (
    SELECT 1 FROM evolution_eval_evidence_fact conclusion
     WHERE conclusion.eval_job_id=job.id
       AND conclusion.fact_type IN ('frozen','corrupt','unavailable_at_deadline')
  ) AND run_state NOT IN ('succeeded','failed','cancelled','timeout') THEN
    RAISE EXCEPTION 'evolution eval evidence conclusion requires an accepted terminal job'
      USING ERRCODE='23514';
  END IF;
  SELECT * INTO frozen FROM evolution_eval_evidence_fact
    WHERE eval_job_id=job.id AND fact_type='frozen';
  IF FOUND THEN
    IF run_state NOT IN ('succeeded','failed','cancelled','timeout') THEN
      RAISE EXCEPTION 'only accepted terminal evolution eval jobs can freeze valid evidence'
        USING ERRCODE='23514';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'name',e.name,'sha256',e.sha256,'size_bytes',e.size_bytes,
             'media_type',e.media_type,'artifact_classification',e.artifact_classification,
             'usage_classification',e.usage_classification
           ) ORDER BY e.name COLLATE "C"),'[]'::jsonb),
           count(*)::integer,COALESCE(sum(e.size_bytes),0)::bigint
      INTO actual_entries,actual_count,actual_bytes
      FROM evolution_eval_evidence_entry e WHERE e.evidence_fact_id=frozen.id;
    IF frozen.entry_count<>actual_count OR frozen.total_bytes<>actual_bytes
       OR actual_count>128 OR actual_bytes>268435456
       OR frozen.manifest IS DISTINCT FROM jsonb_build_object(
         'schema','evolution-eval-evidence-manifest.v1','eval_job_id',job.id,
         'tool_run_id',job.tool_run_id,'entries',actual_entries
       ) THEN
      RAISE EXCEPTION 'frozen evolution eval evidence manifest/children/count/total mismatch'
        USING ERRCODE='23514';
    END IF;
  END IF;
  FOR fact IN SELECT * FROM evolution_eval_evidence_fact f
    WHERE f.eval_job_id=job.id LOOP
    SELECT * INTO audit FROM evolution_eval_audit_event a WHERE a.id=fact.audit_event_id;
    SELECT * INTO event FROM outbox_events o WHERE o.event_id=fact.outbox_event_id;
    expected_event_type=CASE fact.fact_type
      WHEN 'freeze_pending' THEN 'evolution_eval.evidence.freeze_requested'
      WHEN 'frozen' THEN 'evolution_eval.evidence.frozen'
      WHEN 'corrupt' THEN 'evolution_eval.evidence.corrupt'
      WHEN 'unavailable_at_deadline' THEN 'evolution_eval.evidence.unavailable_at_deadline'
      WHEN 'ack_pending' THEN 'evolution_eval.evidence.ack_requested'
      WHEN 'acknowledged' THEN 'evolution_eval.evidence.acknowledged'
      WHEN 'quarantine_pending' THEN 'evolution_eval.evidence.quarantine_requested'
      WHEN 'expired' THEN 'evolution_eval.evidence.expired'
      WHEN 'cleanup_pending' THEN 'evolution_eval.evidence.cleanup_requested'
      ELSE 'evolution_eval.evidence.cleaned' END;
    expected_payload=jsonb_strip_nulls(jsonb_build_object(
      'fact_id',fact.id,'fact_type',fact.fact_type,'fact_hash',fact.fact_hash,
      'manifest_hash',fact.manifest_hash,'error_code',fact.error_code
    ));
    IF audit.id IS NULL OR event.event_id IS NULL
       OR fact.evolution_origin_txid<>audit.evolution_origin_txid
       OR fact.evolution_origin_txid<>event.evolution_origin_txid
       OR audit.eval_job_id<>job.id OR audit.curator_run_id<>job.curator_run_id
       OR audit.project_id<>job.project_id OR audit.correlation_id<>tool_correlation
       OR audit.event_type<>('evidence.'||fact.fact_type) OR audit.operation<>job.operation
       OR audit.request_hash IS DISTINCT FROM fact.fact_hash
       OR audit.from_state IS NOT NULL OR audit.to_state IS NOT NULL
       OR audit.workspace_manifest_hash IS NOT NULL
       OR audit.evidence_manifest_hash IS DISTINCT FROM fact.manifest_hash
       OR audit.file_count IS DISTINCT FROM (CASE
         WHEN fact.fact_type='frozen' THEN fact.entry_count ELSE NULL END)
       OR audit.byte_count IS DISTINCT FROM (CASE
         WHEN fact.fact_type='frozen' THEN fact.total_bytes ELSE NULL END)
       OR audit.error_code IS DISTINCT FROM fact.error_code
       OR event.aggregate_type<>'evolution_eval_job' OR event.aggregate_id<>job.id
       OR event.event_type<>expected_event_type OR event.project_id<>job.project_id
       OR event.correlation_id<>tool_correlation OR event.headers<>'{}'::jsonb
       OR event.causation_id IS NOT NULL OR event.classification<>'D1'
       OR event.payload IS DISTINCT FROM expected_payload THEN
      RAISE EXCEPTION 'evolution eval evidence fact requires same-transaction exact audit/outbox'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='frozen' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='freeze_pending';
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'frozen evidence requires a previously committed freeze intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type IN ('ack_pending','acknowledged') AND (
      frozen.id IS NULL OR fact.manifest_hash<>frozen.manifest_hash
    ) THEN
      RAISE EXCEPTION 'evolution eval evidence ack must bind the frozen manifest hash'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='ack_pending' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='frozen'
         AND f.manifest_hash=fact.manifest_hash;
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'ack intent requires previously committed frozen evidence'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='acknowledged' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='ack_pending'
         AND f.manifest_hash=fact.manifest_hash;
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'acknowledged evidence requires a previously committed ack intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='corrupt' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='freeze_pending';
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'corrupt evidence requires a previously committed freeze intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='corrupt' AND (
      NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact q WHERE q.eval_job_id=job.id
         AND q.fact_type='quarantine_pending'
         AND q.evolution_origin_txid=fact.evolution_origin_txid
      ) OR NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact c WHERE c.eval_job_id=job.id
         AND c.fact_type='cleanup_pending'
         AND c.evolution_origin_txid=fact.evolution_origin_txid
      )
    ) THEN
      RAISE EXCEPTION 'corrupt evidence requires atomic quarantine and cleanup intents'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='quarantine_pending' AND (
      NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact c WHERE c.eval_job_id=job.id
         AND c.fact_type='corrupt' AND c.evolution_origin_txid=fact.evolution_origin_txid
      ) OR NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact p WHERE p.eval_job_id=job.id
         AND p.fact_type='cleanup_pending'
         AND p.evolution_origin_txid=fact.evolution_origin_txid
      )
    ) THEN
      RAISE EXCEPTION 'quarantine intent must be atomic with corrupt evidence and cleanup intent'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='unavailable_at_deadline' THEN
      IF clock_timestamp()<job.deadline_at OR NOT EXISTS (
        SELECT 1 FROM evolution_eval_evidence_fact c WHERE c.eval_job_id=job.id
         AND c.fact_type='cleanup_pending'
         AND c.evolution_origin_txid=fact.evolution_origin_txid
      ) THEN
        RAISE EXCEPTION 'unavailable evidence requires Core deadline and atomic cleanup intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='expired' THEN
      IF frozen.id IS NULL OR fact.manifest_hash<>frozen.manifest_hash
         OR frozen.evolution_origin_txid=fact.evolution_origin_txid
         OR EXISTS (
           SELECT 1 FROM evolution_eval_evidence_fact acknowledged
            WHERE acknowledged.eval_job_id=job.id
              AND acknowledged.fact_type='acknowledged'
         )
         OR run_state NOT IN ('succeeded','failed','cancelled','timeout')
         OR run_end_time IS NULL OR clock_timestamp()<run_end_time+interval '7 days'
         OR NOT EXISTS (
           SELECT 1 FROM evolution_eval_evidence_fact c WHERE c.eval_job_id=job.id
            AND c.fact_type='cleanup_pending'
            AND c.evolution_origin_txid=fact.evolution_origin_txid
         ) THEN
        RAISE EXCEPTION 'evidence expiry requires prior unacknowledged frozen evidence, terminal plus 7 days, and atomic cleanup intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
    IF fact.fact_type='cleanup_pending' AND NOT EXISTS (
      SELECT 1 FROM evolution_eval_evidence_fact prior WHERE prior.eval_job_id=job.id
       AND prior.fact_type IN ('acknowledged','corrupt','unavailable_at_deadline','expired')
       AND (
         prior.fact_type<>'acknowledged'
         OR prior.evolution_origin_txid<>fact.evolution_origin_txid
       )
    ) THEN
      RAISE EXCEPTION 'cleanup intent requires acknowledged or abnormal evidence terminal fact'
        USING ERRCODE='23514';
    END IF;
    IF fact.fact_type='cleaned' THEN
      SELECT f.evolution_origin_txid INTO prior_xid FROM evolution_eval_evidence_fact f
       WHERE f.eval_job_id=job.id AND f.fact_type='cleanup_pending';
      IF prior_xid IS NULL OR prior_xid=fact.evolution_origin_txid THEN
        RAISE EXCEPTION 'cleaned evidence requires a previously committed cleanup intent'
          USING ERRCODE='23514';
      END IF;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM evolution_eval_evidence_fact f WHERE f.eval_job_id=job.id AND f.fact_type='expired')
     AND EXISTS (SELECT 1 FROM evolution_eval_evidence_fact f WHERE f.eval_job_id=job.id AND f.fact_type='acknowledged') THEN
    RAISE EXCEPTION 'evolution eval retention cannot be both acknowledged and expired'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_evidence_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM synthia_assert_evolution_eval_evidence(COALESCE(NEW.eval_job_id,OLD.eval_job_id));
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_evidence_fact_commit_guard ON evolution_eval_evidence_fact;
CREATE CONSTRAINT TRIGGER evolution_eval_evidence_fact_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_evidence_fact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_evidence_commit();
DROP TRIGGER IF EXISTS evolution_eval_evidence_entry_commit_guard ON evolution_eval_evidence_entry;
CREATE CONSTRAINT TRIGGER evolution_eval_evidence_entry_commit_guard AFTER INSERT OR UPDATE OR DELETE
  ON evolution_eval_evidence_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_evidence_commit();

CREATE OR REPLACE FUNCTION synthia_validate_evolution_eval_idempotency_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'evolution eval idempotency rejects delete' USING ERRCODE='55000';
  END IF;
  IF OLD.id IS DISTINCT FROM NEW.id OR OLD.scope IS DISTINCT FROM NEW.scope
     OR OLD.curator_run_id IS DISTINCT FROM NEW.curator_run_id
     OR OLD.eval_job_id IS DISTINCT FROM NEW.eval_job_id OR OLD.action IS DISTINCT FROM NEW.action
     OR OLD.idempotency_key IS DISTINCT FROM NEW.idempotency_key
     OR OLD.request_hash IS DISTINCT FROM NEW.request_hash OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR OLD.response IS NOT NULL OR OLD.response_status IS NOT NULL OR OLD.completed_at IS NOT NULL
     OR NEW.response IS NULL OR NEW.response_status IS NULL OR NEW.completed_at IS NULL THEN
    RAISE EXCEPTION 'evolution eval idempotency permits exactly one incomplete-to-complete mutation'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS evolution_eval_idempotency_mutation_guard ON evolution_eval_idempotency;
CREATE TRIGGER evolution_eval_idempotency_mutation_guard BEFORE UPDATE OR DELETE
  ON evolution_eval_idempotency FOR EACH ROW
  EXECUTE FUNCTION synthia_validate_evolution_eval_idempotency_mutation();

-- Immutable facts.  The two mutable projections above have dedicated guards.
DROP TRIGGER IF EXISTS evolution_eval_input_append_only ON evolution_eval_input;
CREATE TRIGGER evolution_eval_input_append_only BEFORE UPDATE OR DELETE ON evolution_eval_input
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_input_file_append_only ON evolution_eval_input_file;
CREATE TRIGGER evolution_eval_input_file_append_only BEFORE UPDATE OR DELETE ON evolution_eval_input_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_input_skill_file_append_only ON evolution_eval_input_skill_file;
CREATE TRIGGER evolution_eval_input_skill_file_append_only BEFORE UPDATE OR DELETE ON evolution_eval_input_skill_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_workspace_append_only ON evolution_eval_workspace;
CREATE TRIGGER evolution_eval_workspace_append_only BEFORE UPDATE OR DELETE ON evolution_eval_workspace
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_workspace_revision_append_only ON evolution_eval_workspace_revision;
CREATE TRIGGER evolution_eval_workspace_revision_append_only BEFORE UPDATE OR DELETE ON evolution_eval_workspace_revision
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_workspace_file_append_only ON evolution_eval_workspace_file;
CREATE TRIGGER evolution_eval_workspace_file_append_only BEFORE UPDATE OR DELETE ON evolution_eval_workspace_file
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_dispatch_append_only ON evolution_eval_dispatch;
CREATE TRIGGER evolution_eval_dispatch_append_only BEFORE UPDATE OR DELETE ON evolution_eval_dispatch
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_dispatch_tombstone_append_only ON evolution_eval_dispatch_tombstone;
CREATE TRIGGER evolution_eval_dispatch_tombstone_append_only BEFORE UPDATE OR DELETE ON evolution_eval_dispatch_tombstone
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_evidence_fact_append_only ON evolution_eval_evidence_fact;
CREATE TRIGGER evolution_eval_evidence_fact_append_only BEFORE UPDATE OR DELETE ON evolution_eval_evidence_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_evidence_entry_append_only ON evolution_eval_evidence_entry;
CREATE TRIGGER evolution_eval_evidence_entry_append_only BEFORE UPDATE OR DELETE ON evolution_eval_evidence_entry
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_audit_event_append_only ON evolution_eval_audit_event;
CREATE TRIGGER evolution_eval_audit_event_append_only BEFORE UPDATE OR DELETE ON evolution_eval_audit_event
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_transition_fact_append_only ON evolution_eval_transition_fact;
CREATE TRIGGER evolution_eval_transition_fact_append_only BEFORE UPDATE OR DELETE ON evolution_eval_transition_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_unknown_fact_append_only ON evolution_eval_unknown_fact;
CREATE TRIGGER evolution_eval_unknown_fact_append_only BEFORE UPDATE OR DELETE ON evolution_eval_unknown_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();
DROP TRIGGER IF EXISTS evolution_eval_operation_fact_append_only ON evolution_eval_operation_fact;
CREATE TRIGGER evolution_eval_operation_fact_append_only BEFORE UPDATE OR DELETE ON evolution_eval_operation_fact
  FOR EACH ROW EXECUTE FUNCTION synthia_reject_append_only_mutation();

INSERT INTO schema_migrations(version)
  VALUES ('0014_evolution_eval')
  ON CONFLICT (version) DO NOTHING;

COMMIT;
