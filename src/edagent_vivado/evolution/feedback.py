"""Per-message user feedback (SPEC §22.6 signal source `user_feedback`)."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from edagent_vivado.repository.db import get_db


def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> int:
    return int(time.time())


def feedback_create(
    *,
    session_id: str,
    task_id: str | None = None,
    message_id: str | None = None,
    user_thumb: int | None = None,
    comment: str | None = None,
    tags: list[str] | None = None,
    metadata: dict | None = None,
) -> dict:
    if user_thumb is not None and user_thumb not in (-1, 0, 1):
        raise ValueError("user_thumb must be -1, 0, or 1")
    fid = _uid()
    db = get_db()
    db.execute(
        """INSERT INTO feedback(
             id, session_id, task_id, message_id, user_thumb, comment, tags_json,
             created_at, metadata_json
           ) VALUES(?,?,?,?,?,?,?,?,?)""",
        (
            fid, session_id, task_id, message_id,
            user_thumb, comment,
            json.dumps(tags or []),
            _now(), json.dumps(metadata or {}),
        ),
    )
    db.commit()
    return feedback_get(fid)  # type: ignore[return-value]


def feedback_get(fid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM feedback WHERE id=?", (fid,)).fetchone()
    return dict(row) if row else None


def feedback_list_for_session(session_id: str, limit: int = 200) -> list[dict]:
    rows = get_db().execute(
        "SELECT * FROM feedback WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
        (session_id, limit),
    ).fetchall()
    return [dict(r) for r in rows]


def feedback_list_for_task(task_id: str) -> list[dict]:
    rows = get_db().execute(
        "SELECT * FROM feedback WHERE task_id=? ORDER BY created_at ASC",
        (task_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def feedback_thumb_for_task(task_id: str) -> int | None:
    """Return the last non-null thumb for a task, or None.

    Last wins so a user can change their mind; later PRs may switch to majority.
    """
    rows = get_db().execute(
        """SELECT user_thumb FROM feedback
             WHERE task_id=? AND user_thumb IS NOT NULL
             ORDER BY created_at DESC LIMIT 1""",
        (task_id,),
    ).fetchall()
    if not rows:
        return None
    val: Any = rows[0]["user_thumb"]
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def feedback_thumb_rolling(session_id: str, limit: int = 10) -> dict:
    """Aggregate thumbs over the last N feedback rows for a session.

    Used by SE-PR3 negative_feedback signal generator.
    """
    rows = get_db().execute(
        """SELECT user_thumb FROM feedback
             WHERE session_id=? AND user_thumb IS NOT NULL
             ORDER BY created_at DESC LIMIT ?""",
        (session_id, limit),
    ).fetchall()
    counts = {"+1": 0, "0": 0, "-1": 0}
    for row in rows:
        try:
            v = int(row["user_thumb"])
        except (TypeError, ValueError):
            continue
        key = {1: "+1", 0: "0", -1: "-1"}.get(v)
        if key:
            counts[key] += 1
    total = sum(counts.values())
    return {
        "counts": counts,
        "total": total,
        "negatives": counts["-1"],
        "negative_rate": (counts["-1"] / total) if total else 0.0,
    }
