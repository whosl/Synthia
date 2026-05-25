"""Evolution candidate CRUD (SPEC §22.4).

Mirror of repository/store.py kb_candidate_* helpers, but generic over surface.
SE-PR3 will use these from generator hooks; SE-PR4 from the review UI.
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

from edagent_vivado.repository.db import get_db

VALID_STATUSES = {"pending", "approved", "rejected", "merged", "rolled_back", "trialing"}


def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> int:
    return int(time.time())


def candidate_create(
    *,
    surface: str,
    title: str,
    rationale: str = "",
    signal_source: dict | None = None,
    scope: str = "project",
    project_id: str | None = None,
    session_id: str | None = None,
    diff_artifact_id: str | None = None,
    baseline_artifact_id: str | None = None,
    confidence: float | None = None,
    created_by: str = "evolver",
    candidate_type: str = "overlay",
    metadata: dict | None = None,
) -> dict:
    cid = _uid()
    now = _now()
    db = get_db()
    db.execute(
        """INSERT INTO evolution_candidates(
            id, scope, project_id, session_id, surface, candidate_type, title, rationale,
            signal_source_json, diff_artifact_id, baseline_artifact_id, confidence,
            status, created_by, created_at, metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            cid, scope, project_id, session_id, surface, candidate_type, title, rationale,
            json.dumps(signal_source or {}),
            diff_artifact_id, baseline_artifact_id, confidence,
            "pending", created_by, now,
            json.dumps(metadata or {}),
        ),
    )
    db.commit()
    return candidate_get(cid)  # type: ignore[return-value]


def candidate_get(cid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM evolution_candidates WHERE id=?", (cid,)).fetchone()
    return dict(row) if row else None


def candidate_list(
    *,
    status: str | None = "pending",
    surface: str | None = None,
    project_id: str | None = None,
    limit: int = 100,
) -> list[dict]:
    q = "SELECT * FROM evolution_candidates WHERE 1=1"
    params: list[Any] = []
    if status:
        q += " AND status=?"
        params.append(status)
    if surface:
        q += " AND surface=?"
        params.append(surface)
    if project_id:
        q += " AND project_id=?"
        params.append(project_id)
    q += " ORDER BY created_at DESC LIMIT ?"
    params.append(limit)
    return [dict(r) for r in get_db().execute(q, params)]


def candidate_update_status(
    cid: str,
    status: str,
    *,
    reviewed_by: str = "user",
    applied_overlay_id: str | None = None,
) -> dict | None:
    if status not in VALID_STATUSES:
        raise ValueError(f"invalid candidate status: {status!r}")
    db = get_db()
    db.execute(
        """UPDATE evolution_candidates
             SET status=?, reviewed_by=?, reviewed_at=?, applied_overlay_id=COALESCE(?, applied_overlay_id)
             WHERE id=?""",
        (status, reviewed_by, _now(), applied_overlay_id, cid),
    )
    db.commit()
    return candidate_get(cid)
