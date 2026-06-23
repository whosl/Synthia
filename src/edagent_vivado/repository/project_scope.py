"""Add and backfill project_id on session-scoped tables (SPEC §3)."""

from __future__ import annotations

import sqlite3

# table -> column used to join sessions for backfill
_SESSION_SCOPED_TABLES = (
    "tasks",
    "messages",
    "events",
    "turns",
    "turn_items",
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
)


def _table_columns(db: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}


def migrate_project_id_columns(db: sqlite3.Connection) -> None:
    for table in _SESSION_SCOPED_TABLES:
        try:
            cols = _table_columns(db, table)
        except sqlite3.OperationalError:
            continue
        if "project_id" not in cols:
            db.execute(f"ALTER TABLE {table} ADD COLUMN project_id TEXT")
    db.commit()


def backfill_project_ids(db: sqlite3.Connection) -> dict[str, int]:
    stats: dict[str, int] = {}
    for table in _SESSION_SCOPED_TABLES:
        try:
            cols = _table_columns(db, table)
        except sqlite3.OperationalError:
            continue
        if "project_id" not in cols or "session_id" not in cols:
            continue
        cur = db.execute(
            f"""UPDATE {table} SET project_id = (
                  SELECT project_id FROM sessions WHERE sessions.id = {table}.session_id
                )
                WHERE session_id IS NOT NULL
                  AND (project_id IS NULL OR project_id = '')
                  AND EXISTS (
                    SELECT 1 FROM sessions s
                    WHERE s.id = {table}.session_id AND s.project_id IS NOT NULL AND s.project_id != ''
                  )"""
        )
        stats[table] = cur.rowcount
    db.commit()
    return stats


def project_id_for_session(db: sqlite3.Connection, session_id: str) -> str | None:
    if not session_id:
        return None
    row = db.execute("SELECT project_id FROM sessions WHERE id=?", (session_id,)).fetchone()
    if not row:
        return None
    pid = row["project_id"]
    return str(pid) if pid else None
