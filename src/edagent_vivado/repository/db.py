"""Database connection and schema migration for Phase 1."""

from __future__ import annotations
import sqlite3, os, threading
from pathlib import Path

_DB_PATH = os.environ.get("EDAGENT_DB_PATH", "")
_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    archived_at INTEGER, deleted_at INTEGER,
    last_message_preview TEXT, message_count INTEGER NOT NULL DEFAULT 0,
    task_count INTEGER NOT NULL DEFAULT 0, tool_call_count INTEGER NOT NULL DEFAULT 0,
    problem_count INTEGER NOT NULL DEFAULT 0, token_input INTEGER NOT NULL DEFAULT 0,
    token_output INTEGER NOT NULL DEFAULT 0, total_cost REAL, metadata_json TEXT
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


def init_db() -> None:
    db = get_db()
    db.executescript(SCHEMA)
    db.commit()


def close_db() -> None:
    if hasattr(_local, "conn") and _local.conn:
        _local.conn.close()
        _local.conn = None
