"""Project lifecycle: summary, health, hard delete cascade (SPEC §3.4)."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path
from typing import Any

from edagent_vivado.repository.db import get_db
from edagent_vivado.repository.store import knowledge_source_list, project_get


def _now() -> int:
    return int(time.time())


def _hard_delete_session(db, session_id: str) -> None:
    """Remove all DB rows for a session (hard delete)."""
    cp_ids = [
        r[0]
        for r in db.execute(
            "SELECT id FROM context_packages WHERE session_id=?", (session_id,)
        ).fetchall()
    ]
    if cp_ids:
        placeholders = ",".join("?" * len(cp_ids))
        db.execute(
            f"DELETE FROM context_package_items WHERE context_package_id IN ({placeholders})",
            cp_ids,
        )
    ra_ids = [
        r[0]
        for r in db.execute(
            "SELECT id FROM retrieval_audits WHERE session_id=?", (session_id,)
        ).fetchall()
    ]
    if ra_ids:
        placeholders = ",".join("?" * len(ra_ids))
        db.execute(
            f"DELETE FROM retrieval_audit_items WHERE retrieval_audit_id IN ({placeholders})",
            ra_ids,
        )
    ch_ids = [
        r[0]
        for r in db.execute("SELECT id FROM channels WHERE session_id=?", (session_id,)).fetchall()
    ]
    if ch_ids:
        placeholders = ",".join("?" * len(ch_ids))
        db.execute(
            f"DELETE FROM channel_messages WHERE channel_id IN ({placeholders})",
            ch_ids,
        )

    for table in (
        "events",
        "messages",
        "tasks",
        "runs",
        "tool_calls",
        "llm_usage",
        "memory_snapshots",
        "context_packages",
        "retrieval_audits",
        "problems",
        "artifacts",
        "channels",
        "channel_messages",
        "vivado_commands",
        "file_sync_records",
        "vivado_sessions",
    ):
        try:
            db.execute(f"DELETE FROM {table} WHERE session_id=?", (session_id,))
        except Exception:
            pass
    try:
        db.execute("DELETE FROM kb_candidates WHERE source_session_id=?", (session_id,))
    except Exception:
        pass
    db.execute("DELETE FROM sessions WHERE id=?", (session_id,))


def _archive_session_artifacts_dir(session_id: str) -> None:
    runtime = Path(os.environ.get("EDAGENT_RUNTIME_DIR", ".edagent"))
    src = runtime / "artifacts" / "sessions" / session_id
    if not src.is_dir():
        return
    dst = runtime / "archives" / "sessions" / session_id
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        shutil.rmtree(dst, ignore_errors=True)
    try:
        shutil.move(str(src), str(dst))
    except Exception:
        shutil.rmtree(src, ignore_errors=True)


def project_hard_delete(project_id: str) -> dict[str, Any]:
    project = project_get(project_id)
    if not project:
        raise ValueError("project not found")
    db = get_db()
    session_ids = [
        r["id"]
        for r in db.execute("SELECT id FROM sessions WHERE project_id=?", (project_id,)).fetchall()
    ]
    for sid in session_ids:
        _hard_delete_session(db, sid)
        _archive_session_artifacts_dir(sid)

    db.execute("DELETE FROM knowledge_chunks WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM knowledge_sources WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM path_mappings WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM vivado_sessions WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM file_sync_records WHERE project_id=?", (project_id,))
    db.execute("DELETE FROM projects WHERE id=?", (project_id,))
    db.commit()
    return {"ok": True, "project_id": project_id, "sessions_removed": len(session_ids)}


def project_kb_stats(project_id: str) -> dict[str, Any]:
    db = get_db()
    sources = db.execute(
        "SELECT COUNT(*) FROM knowledge_sources WHERE project_id=?", (project_id,)
    ).fetchone()[0]
    chunks = db.execute(
        "SELECT COUNT(*) FROM knowledge_chunks WHERE project_id=?", (project_id,)
    ).fetchone()[0]
    return {"sources": int(sources), "chunks": int(chunks)}


def project_session_stats(project_id: str) -> dict[str, int]:
    db = get_db()
    active = db.execute(
        """SELECT COUNT(*) FROM sessions
           WHERE project_id=? AND deleted_at IS NULL AND archived_at IS NULL""",
        (project_id,),
    ).fetchone()[0]
    archived = db.execute(
        """SELECT COUNT(*) FROM sessions
           WHERE project_id=? AND deleted_at IS NULL AND archived_at IS NOT NULL""",
        (project_id,),
    ).fetchone()[0]
    return {"active": int(active), "archived": int(archived)}


def project_vivado_health(project: dict) -> dict[str, Any]:
    from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter

    adapter = VivadoRuntimeAdapter()
    hc = adapter.health_check()
    target_id = project.get("default_vivado_target_id") or hc.get("target_id") or "default-remote"
    return {
        "target_id": target_id,
        "target": target_id,
        "host": hc.get("host", ""),
        "reachable": bool(hc.get("reachable", False)),
        "vivado_path": hc.get("vivado_path", ""),
        "version": hc.get("version"),
        "error": hc.get("error"),
        "checked_at": _now(),
    }


def project_summary(project_id: str) -> dict[str, Any]:
    project = project_get(project_id)
    if not project:
        raise ValueError("project not found")
    return {
        "project": project,
        "kb": project_kb_stats(project_id),
        "kb_recent_sources": knowledge_source_list(scope="project", project_id=project_id, limit=8),
        "sessions": project_session_stats(project_id),
        "vivado_health": project_vivado_health(project),
    }
