"""Database connection and schema migration for Phase 1."""

from __future__ import annotations
import sqlite3, os, threading
from pathlib import Path

_DB_PATH = os.environ.get("EDAGENT_DB_PATH", "")
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    root_path TEXT NOT NULL,
    manifest_path TEXT NOT NULL,
    xpr_path TEXT NOT NULL,
    part TEXT,
    board_part TEXT,
    top_module TEXT,
    target_language TEXT,
    simulator TEXT,
    source_globs_json TEXT,
    constraint_globs_json TEXT,
    tcl_globs_json TEXT,
    default_vivado_target_id TEXT,
    default_path_mapping_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    deleted_at INTEGER,
    session_count INTEGER NOT NULL DEFAULT 0,
    run_count INTEGER NOT NULL DEFAULT 0,
    problem_count INTEGER NOT NULL DEFAULT 0,
    last_active_at INTEGER,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    archived_at INTEGER, deleted_at INTEGER,
    last_message_preview TEXT, message_count INTEGER NOT NULL DEFAULT 0,
    task_count INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0,
    problem_count INTEGER NOT NULL DEFAULT 0, token_input INTEGER NOT NULL DEFAULT 0,
    token_output INTEGER NOT NULL DEFAULT 0, total_cost REAL,
    project_snapshot_json TEXT, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, user_message_id TEXT,
    state TEXT NOT NULL DEFAULT 'created', stop_requested INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER,
    error TEXT, active_run_id TEXT, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, agent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL, content_summary TEXT,
    stopped INTEGER NOT NULL DEFAULT 0, partial INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, token_input INTEGER, token_output INTEGER, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, run_id TEXT,
    parent_run_id TEXT, agent_id TEXT, seq INTEGER NOT NULL,
    event_type TEXT NOT NULL, created_at INTEGER NOT NULL,
    payload_json TEXT NOT NULL, artifact_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'public',
    UNIQUE(session_id, seq)
);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, parent_run_id TEXT,
    agent_id TEXT, run_type TEXT NOT NULL, name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'started', started_at INTEGER NOT NULL,
    finished_at INTEGER, elapsed_ms INTEGER, error TEXT,
    input_summary TEXT, output_summary TEXT, artifact_id TEXT, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT, task_id TEXT,
    agent_id TEXT, tool_name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'started',
    started_at INTEGER NOT NULL, finished_at INTEGER, elapsed_ms INTEGER,
    input_summary TEXT, output_summary TEXT, input_artifact_id TEXT,
    output_artifact_id TEXT, error TEXT, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS llm_usage (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT, task_id TEXT,
    agent_id TEXT, provider TEXT, model TEXT NOT NULL, model_role TEXT NOT NULL DEFAULT 'primary',
    input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
    cache_write_tokens INTEGER, total_tokens INTEGER, cost_input REAL, cost_output REAL,
    cost_total REAL, usage_source TEXT NOT NULL DEFAULT 'unknown', created_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, run_id TEXT,
    artifact_type TEXT NOT NULL, path TEXT NOT NULL, mime_type TEXT,
    size_bytes INTEGER, sha256 TEXT, summary TEXT, created_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS vivado_targets (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT 'remote_ssh',
    host TEXT, ssh_user TEXT, ssh_key_path TEXT, vivado_path TEXT NOT NULL,
    settings_path TEXT, remote_work_root TEXT, vivado_version TEXT,
    is_default INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS memory_snapshots (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT,
    summary TEXT NOT NULL, summary_model TEXT,
    source_message_until TEXT, source_event_until_seq INTEGER,
    created_at INTEGER NOT NULL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS retrieval_audits (
    id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, run_id TEXT,
    agent_id TEXT, query TEXT NOT NULL, rewritten_query TEXT,
    intent_json TEXT, filters_json TEXT,
    candidate_count INTEGER, selected_count INTEGER, rejected_count INTEGER,
    token_budget INTEGER, token_used INTEGER,
    created_at INTEGER NOT NULL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS retrieval_audit_items (
    id TEXT PRIMARY KEY, retrieval_audit_id TEXT NOT NULL,
    source_type TEXT NOT NULL, source_id TEXT, chunk_id TEXT,
    kb_case_id TEXT, problem_id TEXT, artifact_id TEXT,
    title TEXT, excerpt TEXT, vector_score REAL, rerank_score REAL,
    authority_score REAL, trust_score REAL, final_score REAL,
    selected INTEGER NOT NULL DEFAULT 0, rejection_reason TEXT,
    token_count INTEGER, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS context_packages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, task_id TEXT, run_id TEXT,
    agent_id TEXT, model TEXT, max_context_tokens INTEGER, total_tokens INTEGER,
    system_tokens INTEGER, question_tokens INTEGER, memory_tokens INTEGER,
    recent_message_tokens INTEGER, project_context_tokens INTEGER,
    error_kb_tokens INTEGER, semantic_kb_tokens INTEGER,
    tool_summary_tokens INTEGER, problem_summary_tokens INTEGER,
    truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    artifact_id TEXT, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS context_package_items (
    id TEXT PRIMARY KEY, context_package_id TEXT NOT NULL,
    item_type TEXT NOT NULL, source_id TEXT, source_type TEXT,
    title TEXT, content_summary TEXT, token_count INTEGER,
    priority INTEGER NOT NULL, included INTEGER NOT NULL DEFAULT 1,
    truncation_reason TEXT, authority_score REAL, trust_score REAL,
    relevance_score REAL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS problems (
    id TEXT PRIMARY KEY, session_id TEXT, task_id TEXT, run_id TEXT,
    source TEXT NOT NULL, severity TEXT, category TEXT,
    signature TEXT, normalized_signature TEXT, message TEXT NOT NULL,
    raw_excerpt_artifact_id TEXT, detected_at INTEGER NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0, resolution_summary TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS kb_cases (
    id TEXT PRIMARY KEY, pattern TEXT NOT NULL, normalized_signature TEXT,
    category TEXT NOT NULL, likely_causes_json TEXT NOT NULL,
    suggested_actions_json TEXT NOT NULL, repro_steps TEXT,
    fix_patch_artifact_id TEXT, vivado_version TEXT, fpga_part TEXT,
    top_module TEXT, manifest_artifact_id TEXT,
    verified_resolution INTEGER NOT NULL DEFAULT 0,
    source_candidate_id TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS kb_candidates (
    id TEXT PRIMARY KEY, source_run_id TEXT, source_session_id TEXT,
    source_problem_id TEXT, pattern TEXT NOT NULL, normalized_signature TEXT,
    category TEXT, message_ids_json TEXT, raw_log_excerpt_artifact_id TEXT,
    likely_causes_json TEXT NOT NULL, suggested_actions_json TEXT NOT NULL,
    repro_steps TEXT, fix_patch_artifact_id TEXT, vivado_version TEXT,
    fpga_part TEXT, top_module TEXT, manifest_artifact_id TEXT,
    resolved INTEGER, resolution_summary TEXT, confidence REAL,
    status TEXT NOT NULL DEFAULT 'pending', created_by TEXT NOT NULL DEFAULT 'harness',
    created_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by TEXT,
    merged_into_case_id TEXT, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, name TEXT NOT NULL,
    channel_type TEXT NOT NULL, created_at INTEGER NOT NULL,
    metadata_json TEXT, UNIQUE(session_id, name)
);

CREATE TABLE IF NOT EXISTS channel_messages (
    id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, session_id TEXT NOT NULL,
    task_id TEXT, run_id TEXT, from_agent_id TEXT, to_agent_id TEXT,
    message_type TEXT NOT NULL, content TEXT, artifact_id TEXT,
    created_at INTEGER NOT NULL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS vivado_sessions (
    id TEXT PRIMARY KEY, target_id TEXT NOT NULL, project_id TEXT,
    session_id TEXT, task_id TEXT, run_id TEXT,
    state TEXT NOT NULL DEFAULT 'starting', mode TEXT NOT NULL DEFAULT 'batch',
    remote_pid INTEGER, local_pid INTEGER,
    started_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL,
    idle_timeout_sec INTEGER, work_dir TEXT, log_artifact_id TEXT,
    error TEXT, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS vivado_commands (
    id TEXT PRIMARY KEY, target_id TEXT NOT NULL, vivado_session_id TEXT,
    session_id TEXT, task_id TEXT, run_id TEXT,
    command_type TEXT NOT NULL, command_text TEXT, script_artifact_id TEXT,
    project_id TEXT, work_dir TEXT, state TEXT NOT NULL DEFAULT 'pending',
    started_at INTEGER NOT NULL, finished_at INTEGER, elapsed_ms INTEGER,
    exit_code INTEGER, log_artifact_id TEXT, stdout_artifact_id TEXT,
    stderr_artifact_id TEXT, parsed_summary_json TEXT,
    problem_count INTEGER NOT NULL DEFAULT 0,
    stopped INTEGER NOT NULL DEFAULT 0, killed INTEGER NOT NULL DEFAULT 0,
    error TEXT, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS file_sync_records (
    id TEXT PRIMARY KEY, target_id TEXT NOT NULL, project_id TEXT,
    session_id TEXT, task_id TEXT, run_id TEXT,
    local_path TEXT, remote_path TEXT, direction TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'scp', sha256 TEXT, size_bytes INTEGER,
    state TEXT NOT NULL DEFAULT 'pending', synced_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS path_mappings (
    id TEXT PRIMARY KEY, target_id TEXT NOT NULL, project_id TEXT,
    local_root TEXT NOT NULL, remote_root TEXT NOT NULL,
    created_at INTEGER NOT NULL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_sources (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'global', project_id TEXT,
    source_type TEXT NOT NULL, title TEXT NOT NULL, uri TEXT, path TEXT,
    authority_score REAL NOT NULL DEFAULT 0.5, trust_score REAL NOT NULL DEFAULT 0.5,
    version TEXT, sha256 TEXT, indexed_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'global',
    project_id TEXT, chunk_index INTEGER NOT NULL, title TEXT,
    content TEXT NOT NULL, content_summary TEXT, token_count INTEGER,
    start_offset INTEGER, end_offset INTEGER, sha256 TEXT,
    authority_score REAL NOT NULL DEFAULT 0.5, trust_score REAL NOT NULL DEFAULT 0.5,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_embeddings (
    id TEXT PRIMARY KEY, chunk_id TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT NOT NULL, dimension INTEGER, vector_store TEXT NOT NULL,
    vector_ref TEXT NOT NULL, indexed_at INTEGER NOT NULL, metadata_json TEXT
);

-- Persisted key/value settings (shared with PR1's approval flags + SE-PR5
-- per-project trial config). Both branches use IF NOT EXISTS, so the merge
-- is conflict-free regardless of order.
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- ── Self-evolution (SPEC §22) ─────────────────────────────
-- Schema is forward-compatible with the full SE-PR2..8 roadmap;
-- SE-PR1 only writes resolver indirection (no behavior change yet).

CREATE TABLE IF NOT EXISTS evolution_candidates (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'project',           -- session|project|global
    project_id TEXT,
    session_id TEXT,
    surface TEXT NOT NULL,                            -- kb|prompt|tool|flow_template|routing
    candidate_type TEXT NOT NULL DEFAULT 'overlay',
    title TEXT NOT NULL,
    rationale TEXT,
    signal_source_json TEXT,
    diff_artifact_id TEXT,
    baseline_artifact_id TEXT,
    confidence REAL,
    status TEXT NOT NULL DEFAULT 'pending',           -- pending|approved|rejected|merged|rolled_back|trialing
    created_by TEXT NOT NULL DEFAULT 'evolver',       -- harness|evolver|user|run|recurrence
    created_at INTEGER NOT NULL,
    reviewed_by TEXT,
    reviewed_at INTEGER,
    applied_overlay_id TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS overlays (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'project',            -- project|global
    project_id TEXT,
    surface TEXT NOT NULL,
    name TEXT,
    state TEXT NOT NULL DEFAULT 'active',             -- active|shadow|retired
    payload_json TEXT NOT NULL,
    source_candidate_id TEXT,
    parent_overlay_id TEXT,
    created_at INTEGER NOT NULL,
    retired_at INTEGER,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS evolution_trials (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    project_id TEXT,
    surface TEXT NOT NULL,
    baseline_overlay_id TEXT,
    variant_overlay_id TEXT,
    state TEXT NOT NULL DEFAULT 'running',            -- running|completed|reverted
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    n_baseline INTEGER NOT NULL DEFAULT 0,
    n_variant INTEGER NOT NULL DEFAULT 0,
    metric_baseline_json TEXT,
    metric_variant_json TEXT,
    decision TEXT,                                    -- variant_wins|baseline_wins|tie|insufficient_data
    decided_at INTEGER,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT,
    message_id TEXT,
    user_thumb INTEGER,                               -- +1 | 0 | -1
    comment TEXT,
    tags_json TEXT,
    created_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    session_id TEXT,
    task_id TEXT,
    run_id TEXT,
    overlay_id TEXT,
    trial_id TEXT,
    arm TEXT,                                         -- baseline|variant|none
    scope TEXT NOT NULL DEFAULT 'task',               -- task|session|project|global
    window TEXT NOT NULL DEFAULT 'single',            -- single|rolling_10|rolling_50|all
    metrics_json TEXT NOT NULL,
    composite_score REAL,
    created_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    eval_set TEXT NOT NULL,
    overlay_id TEXT,
    state TEXT NOT NULL DEFAULT 'placeholder',        -- placeholder|queued|running|completed|error
    started_at INTEGER,
    finished_at INTEGER,
    total_cases INTEGER,
    passed INTEGER,
    failed INTEGER,
    metric_summary_json TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- Task canvas (short-term memory, Phase A)
CREATE TABLE IF NOT EXISTS task_canvases (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    mermaid_artifact_id TEXT NOT NULL,
    node_count INTEGER NOT NULL DEFAULT 0,
    token_count INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS canvas_node_refs (
    id TEXT PRIMARY KEY,
    canvas_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    ref_type TEXT NOT NULL,
    ref_id TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(canvas_id, node_id)
);

CREATE INDEX IF NOT EXISTS idx_canvas_task ON task_canvases(task_id, state);
CREATE INDEX IF NOT EXISTS idx_canvas_session ON task_canvases(session_id, state);
CREATE INDEX IF NOT EXISTS idx_canvas_node_refs_node_id ON canvas_node_refs(node_id);

-- L1 memory atoms (Phase B)
CREATE TABLE IF NOT EXISTS memory_atoms (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'project',
    project_id TEXT,
    atom_type TEXT NOT NULL,
    subject TEXT NOT NULL,
    predicate TEXT,
    object TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.7,
    source_session_id TEXT,
    source_message_id TEXT,
    source_run_id TEXT,
    evidence_artifact_id TEXT,
    superseded_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_atoms_project ON memory_atoms(project_id, atom_type);
CREATE INDEX IF NOT EXISTS idx_memory_atoms_session ON memory_atoms(source_session_id, created_at);

-- L2 scenarios + L3 personas (Phase C)
CREATE TABLE IF NOT EXISTS memory_scenarios (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL DEFAULT 'project',
    project_id TEXT,
    title TEXT NOT NULL,
    summary_md_path TEXT NOT NULL,
    atom_ids_json TEXT NOT NULL,
    trigger_pattern TEXT,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    last_seen_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS memory_personas (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    project_id TEXT,
    persona_md_path TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    atom_count_at_build INTEGER,
    scenario_count_at_build INTEGER,
    built_at INTEGER NOT NULL,
    superseded_by TEXT,
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_scenarios_project ON memory_scenarios(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_personas_project_version ON memory_personas(scope, project_id, version);

CREATE TABLE IF NOT EXISTS connectors (
    id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL UNIQUE,
    tool_name TEXT NOT NULL,
    version TEXT,
    supported_versions_json TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_health_at INTEGER,
    last_health_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS connector_capabilities (
    id TEXT PRIMARY KEY,
    connector_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    display_name TEXT,
    stage TEXT,
    risk_level TEXT NOT NULL DEFAULT 'low',
    requires_approval INTEGER NOT NULL DEFAULT 0,
    supports_stop INTEGER NOT NULL DEFAULT 1,
    supports_mock INTEGER NOT NULL DEFAULT 1,
    input_schema_json TEXT,
    outputs_json TEXT,
    UNIQUE(connector_id, capability_id)
);

CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    session_id TEXT,
    task_id TEXT,
    connector_id TEXT,
    capability_id TEXT,
    stage TEXT NOT NULL,
    name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    started_at INTEGER,
    finished_at INTEGER,
    elapsed_ms INTEGER,
    command_text TEXT,
    request_artifact_id TEXT,
    log_artifact_id TEXT,
    error TEXT,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS parsed_reports (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT,
    connector_id TEXT NOT NULL,
    report_type TEXT NOT NULL,
    stage TEXT NOT NULL,
    source_artifact_id TEXT,
    data_json TEXT NOT NULL,
    metrics_json TEXT,
    created_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_run_steps_run ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_parsed_reports_run ON parsed_reports(run_id);

CREATE TABLE IF NOT EXISTS patch_proposals (
    id TEXT PRIMARY KEY,
    run_id TEXT,
    step_id TEXT,
    session_id TEXT,
    task_id TEXT,
    problem_id TEXT,
    connector_id TEXT NOT NULL,
    capability_id TEXT,
    target_file TEXT NOT NULL,
    patch_type TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'low',
    reason TEXT,
    diff_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    approval_id TEXT,
    applied_at INTEGER,
    superseded_by TEXT,
    created_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    task_id TEXT,
    run_id TEXT,
    step_id TEXT,
    connector_id TEXT,
    capability_id TEXT,
    approval_type TEXT NOT NULL,
    risk_level TEXT NOT NULL DEFAULT 'low',
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_at INTEGER,
    decided_by TEXT,
    interaction_id TEXT,
    created_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_patch_proposals_run ON patch_proposals(run_id);
CREATE INDEX IF NOT EXISTS idx_patch_proposals_status ON patch_proposals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS patch_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    patch_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_id TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patch_audits_patch ON patch_audits(patch_id, created_at);

CREATE TABLE IF NOT EXISTS tool_run_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT,
    connector_id TEXT NOT NULL,
    capability_id TEXT NOT NULL,
    command_id TEXT,
    executable TEXT,
    args_json TEXT,
    cwd TEXT,
    env_profile TEXT,
    allowed_paths_json TEXT,
    timeout_sec INTEGER DEFAULT 3600,
    state TEXT NOT NULL DEFAULT 'prepared',
    created_at INTEGER NOT NULL,
    metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_tool_run_requests_run ON tool_run_requests(run_id);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    password_hash TEXT DEFAULT '',
    api_token TEXT UNIQUE,
    is_service_account INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    global_role TEXT DEFAULT 'viewer',
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_token ON users(api_token);

CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    description TEXT DEFAULT '',
    permissions_json TEXT DEFAULT '[]',
    is_builtin INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_members (
    project_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_name TEXT NOT NULL,
    added_by TEXT DEFAULT '',
    added_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_proj_mem_user ON project_members(user_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_user_id TEXT DEFAULT '',
    actor_kind TEXT DEFAULT 'user',
    action TEXT NOT NULL,
    resource_type TEXT DEFAULT '',
    resource_id TEXT DEFAULT '',
    project_id TEXT DEFAULT '',
    session_id TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    user_agent TEXT DEFAULT '',
    details_json TEXT DEFAULT '',
    success INTEGER DEFAULT 1,
    error_message TEXT DEFAULT '',
    created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);
"""


def _db_path() -> str:
    if _DB_PATH:
        return _DB_PATH
    runtime = Path(os.environ.get("EDAGENT_RUNTIME_DIR", ".edagent"))
    runtime.mkdir(exist_ok=True)
    return str(runtime / "edagent.db")


def get_db() -> sqlite3.Connection:
    if not hasattr(_local, "conn") or _local.conn is None:
        _local.conn = sqlite3.connect(_db_path(), check_same_thread=False)
        _local.conn.row_factory = sqlite3.Row
        _local.conn.execute("PRAGMA journal_mode=WAL")
        _local.conn.execute("PRAGMA foreign_keys=ON")
    return _local.conn


def _migrate_orphan_sessions(db: sqlite3.Connection) -> None:
    import json
    import time
    import uuid

    existing = db.execute(
        "SELECT id FROM projects WHERE metadata_json LIKE '%legacy_migration%' LIMIT 1"
    ).fetchone()
    if existing:
        pid = existing["id"]
    else:
        pid = uuid.uuid4().hex[:12]
        now = int(time.time())
        db.execute(
            """INSERT INTO projects(
              id,name,status,root_path,manifest_path,xpr_path,part,created_at,updated_at,metadata_json
            ) VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (pid, "Legacy imports", "active", ".", "eda.yaml", "", "unknown", now, now, json.dumps({"legacy_migration": True})),
        )
    snap = json.dumps({"legacy_migration": True, "project_id": pid})
    db.execute(
        "UPDATE sessions SET project_id=?, project_snapshot_json=? WHERE project_id IS NULL OR project_id = ''",
        (pid, snap),
    )
    db.commit()


def _migrate_parsed_reports_metrics(db: sqlite3.Connection) -> None:
    cols = {row[1] for row in db.execute("PRAGMA table_info(parsed_reports)").fetchall()}
    if "metrics_json" not in cols:
        db.execute("ALTER TABLE parsed_reports ADD COLUMN metrics_json TEXT")
    db.commit()


def _migrate_patch_audits(db: sqlite3.Connection) -> None:
    db.execute(
        """CREATE TABLE IF NOT EXISTS patch_audits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            patch_id TEXT NOT NULL,
            action TEXT NOT NULL,
            actor_id TEXT DEFAULT '',
            reason TEXT DEFAULT '',
            metadata_json TEXT DEFAULT '',
            created_at INTEGER NOT NULL
        )"""
    )
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_patch_audits_patch ON patch_audits(patch_id, created_at)"
    )
    db.commit()


def _migrate_projects(db: sqlite3.Connection) -> None:
    cols = {row[1] for row in db.execute("PRAGMA table_info(sessions)").fetchall()}
    if "project_id" not in cols:
        db.execute("ALTER TABLE sessions ADD COLUMN project_id TEXT")
    if "project_snapshot_json" not in cols:
        db.execute("ALTER TABLE sessions ADD COLUMN project_snapshot_json TEXT")
    db.commit()

    orphan = db.execute(
        "SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL AND (project_id IS NULL OR project_id = '')"
    ).fetchone()[0]
    if orphan:
        _migrate_orphan_sessions(db)

    try:
        from edagent_vivado.projects.migrate import migrate_sessions_to_projects

        migrate_sessions_to_projects()
    except Exception:
        pass

    from edagent_vivado.repository.project_scope import (
        backfill_project_ids,
        migrate_project_id_columns,
    )

    migrate_project_id_columns(db)
    backfill_project_ids(db)


_BUILTIN_ROLES = [
    ("admin", "Full system access", ["*"]),
    (
        "project_owner",
        "Owns project, can manage members",
        [
            "project.create",
            "project.read",
            "project.update",
            "project.delete",
            "project.member.add",
            "project.member.remove",
            "run.create",
            "run.cancel",
            "run.read",
            "patch.propose",
            "patch.approve",
            "patch.approve.low",
            "patch.reject",
            "patch.revert",
            "report.read",
            "artifact.read",
            "artifact.download.bitstream",
            "knowledge.read",
            "knowledge.write",
        ],
    ),
    (
        "fpga_engineer",
        "Create runs, propose patches",
        [
            "project.read",
            "run.create",
            "run.cancel",
            "run.read",
            "patch.propose",
            "patch.approve.low",
            "patch.reject",
            "report.read",
            "artifact.read",
            "artifact.download.bitstream",
            "knowledge.read",
        ],
    ),
    (
        "reviewer",
        "Reviews patches, audit access",
        [
            "project.read",
            "run.read",
            "patch.read",
            "patch.approve",
            "patch.approve.low",
            "patch.reject",
            "report.read",
            "artifact.read",
            "knowledge.read",
            "audit.read",
        ],
    ),
    (
        "viewer",
        "Read-only access",
        [
            "project.read",
            "run.read",
            "report.read",
            "artifact.read",
            "knowledge.read",
        ],
    ),
    (
        "tool_admin",
        "Manage connectors and licenses",
        [
            "connector.read",
            "connector.write",
            "license.read",
            "license.write",
            "tool_target.read",
            "tool_target.write",
        ],
    ),
]


def _migrate_rbac_tables(db: sqlite3.Connection) -> None:
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            display_name TEXT DEFAULT '',
            email TEXT DEFAULT '',
            password_hash TEXT DEFAULT '',
            api_token TEXT UNIQUE,
            is_service_account INTEGER DEFAULT 0,
            is_active INTEGER DEFAULT 1,
            global_role TEXT DEFAULT 'viewer',
            created_at INTEGER NOT NULL,
            last_login_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_users_token ON users(api_token);
        CREATE TABLE IF NOT EXISTS roles (
            id TEXT PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            description TEXT DEFAULT '',
            permissions_json TEXT DEFAULT '[]',
            is_builtin INTEGER DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_members (
            project_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            role_name TEXT NOT NULL,
            added_by TEXT DEFAULT '',
            added_at INTEGER NOT NULL,
            PRIMARY KEY (project_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_proj_mem_user ON project_members(user_id);
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            actor_user_id TEXT DEFAULT '',
            actor_kind TEXT DEFAULT 'user',
            action TEXT NOT NULL,
            resource_type TEXT DEFAULT '',
            resource_id TEXT DEFAULT '',
            project_id TEXT DEFAULT '',
            session_id TEXT DEFAULT '',
            ip_address TEXT DEFAULT '',
            user_agent TEXT DEFAULT '',
            details_json TEXT DEFAULT '',
            success INTEGER DEFAULT 1,
            error_message TEXT DEFAULT '',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
        CREATE INDEX IF NOT EXISTS idx_audit_project ON audit_logs(project_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);
        """
    )
    db.commit()


def _seed_builtin_roles(db: sqlite3.Connection) -> None:
    import json
    import time
    import uuid

    from edagent_vivado.auth.permissions import invalidate_perm_cache

    existing = {r[0] for r in db.execute("SELECT name FROM roles").fetchall()}
    now = int(time.time() * 1000)
    for name, desc, perms in _BUILTIN_ROLES:
        payload = json.dumps(perms)
        if name in existing:
            db.execute(
                "UPDATE roles SET permissions_json=?, description=? WHERE name=?",
                (payload, desc, name),
            )
        else:
            db.execute(
                "INSERT INTO roles (id, name, description, permissions_json, is_builtin, created_at) "
                "VALUES (?,?,?,?,1,?)",
                (str(uuid.uuid4()), name, desc, payload, now),
            )
    db.commit()
    invalidate_perm_cache()


def _bootstrap_admin(db: sqlite3.Connection) -> None:
    import logging
    import secrets
    import time
    import uuid
    from pathlib import Path

    row = db.execute("SELECT COUNT(*) FROM users").fetchone()
    if row and row[0] > 0:
        return

    admin_id = str(uuid.uuid4())
    admin_token = secrets.token_urlsafe(32)

    legacy_path = Path.home() / ".synthia" / "token"
    if legacy_path.exists():
        legacy = legacy_path.read_text(encoding="utf-8").strip()
        if legacy:
            admin_token = legacy

    env_tok = os.environ.get("SYNTHIA_API_TOKEN", "").strip()
    if env_tok:
        admin_token = env_tok

    now = int(time.time() * 1000)
    db.execute(
        "INSERT INTO users (id, username, display_name, api_token, global_role, is_active, created_at) "
        "VALUES (?,?,?,?,?,1,?)",
        (admin_id, "admin", "Administrator", admin_token, "admin", now),
    )
    db.commit()

    token_path = Path.home() / ".synthia" / "admin_token"
    token_path.parent.mkdir(parents=True, exist_ok=True)
    if not legacy_path.exists() or legacy_path.read_text(encoding="utf-8").strip() != admin_token:
        legacy_path.parent.mkdir(parents=True, exist_ok=True)
        legacy_path.write_text(admin_token, encoding="utf-8")
        try:
            os.chmod(legacy_path, 0o600)
        except OSError:
            pass

    try:
        token_path.write_text(admin_token, encoding="utf-8")
        os.chmod(token_path, 0o600)
    except OSError:
        pass

    logging.getLogger(__name__).warning(
        "Bootstrap admin created (token in ~/.synthia/token and ~/.synthia/admin_token)"
    )


def init_db() -> None:
    db = get_db()
    db.executescript(SCHEMA)
    db.commit()
    _migrate_projects(db)
    _migrate_parsed_reports_metrics(db)
    _migrate_patch_audits(db)
    _migrate_rbac_tables(db)
    _seed_builtin_roles(db)
    _bootstrap_admin(db)


def close_db() -> None:
    if hasattr(_local, "conn") and _local.conn:
        _local.conn.close()
        _local.conn = None
