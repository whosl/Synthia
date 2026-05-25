"""``eval_runs`` CRUD + placeholder enqueue (SPEC §22.6B, SE-PR6 stub).

Records that the user asked to evaluate a set, **without** actually executing
the cases. State machine:

    placeholder ──── (runner ships in a later PR) ──► queued ─► running ─► completed | error

SE-PR6 only writes the ``placeholder`` rows. The runner is intentionally absent
so we can land the schema, CLI, and API surface area without committing to a
specific scoring algorithm.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, Callable

from edagent_vivado.evolution.eval_set import (
    EvalSet,
    EvalSetError,
    default_eval_set_dir,
    discover_eval_sets,
    get_eval_set,
)
from edagent_vivado.repository.db import get_db

logger = logging.getLogger(__name__)

EventSink = Callable[..., Any]

VALID_STATES = (
    "placeholder",
    "queued",
    "running",
    "completed",
    "error",
)


def _uid() -> str:
    return uuid.uuid4().hex[:12]


def _now() -> int:
    return int(time.time())


def _decode(row) -> dict:
    out = dict(row)
    raw_summary = out.get("metric_summary_json")
    if isinstance(raw_summary, str) and raw_summary:
        try:
            out["metric_summary"] = json.loads(raw_summary)
        except json.JSONDecodeError:
            out["metric_summary"] = {}
    else:
        out["metric_summary"] = {}
    raw_meta = out.get("metadata_json")
    if isinstance(raw_meta, str) and raw_meta:
        try:
            out["metadata"] = json.loads(raw_meta)
        except json.JSONDecodeError:
            out["metadata"] = {}
    else:
        out["metadata"] = {}
    return out


def eval_run_create(
    *,
    eval_set: str,
    state: str = "placeholder",
    overlay_id: str | None = None,
    project_id: str | None = None,
    total_cases: int | None = None,
    metadata: dict | None = None,
) -> dict:
    if state not in VALID_STATES:
        raise ValueError(f"unknown eval_run state {state!r}")
    rid = _uid()
    db = get_db()
    db.execute(
        """INSERT INTO eval_runs(
              id, eval_set, overlay_id, state, total_cases, passed, failed,
              metric_summary_json, metadata_json
           ) VALUES(?,?,?,?,?,?,?,?,?)""",
        (
            rid, eval_set, overlay_id, state, total_cases, None, None,
            json.dumps({}),
            json.dumps({
                "project_id": project_id,
                **(metadata or {}),
            }),
        ),
    )
    db.commit()
    return eval_run_get(rid)  # type: ignore[return-value]


def eval_run_get(rid: str) -> dict | None:
    row = get_db().execute("SELECT * FROM eval_runs WHERE id=?", (rid,)).fetchone()
    return _decode(row) if row else None


def eval_run_list(
    *,
    eval_set: str | None = None,
    state: str | None = None,
    limit: int = 100,
) -> list[dict]:
    q = "SELECT * FROM eval_runs WHERE 1=1"
    params: list[Any] = []
    if eval_set:
        q += " AND eval_set=?"
        params.append(eval_set)
    if state:
        q += " AND state=?"
        params.append(state)
    q += " ORDER BY rowid DESC LIMIT ?"
    params.append(limit)
    rows = get_db().execute(q, params).fetchall()
    return [_decode(r) for r in rows]


def enqueue_eval_run(
    eval_set: str,
    *,
    project_id: str | None = None,
    overlay_id: str | None = None,
    note: str = "",
    event_sink: EventSink | None = None,
    session_id: str = "",
    root: str | None = None,
) -> dict:
    """Validate + persist a ``placeholder`` row.

    Returns the new row with an extra ``runner_implemented=false`` flag so the
    CLI / API caller can tell the user that nothing is actually running yet.
    """
    es = get_eval_set(eval_set, root=root)
    row = eval_run_create(
        eval_set=es.name,
        state="placeholder",
        overlay_id=overlay_id,
        project_id=project_id,
        total_cases=len(es.cases),
        metadata={
            "note": note or None,
            "case_ids": [c.id for c in es.cases],
            "path": str(es.path),
            "runner_version": None,
            "spec_section": "22.6B",
        },
    )
    payload = {
        "eval_run_id": row["id"],
        "eval_set": es.name,
        "case_count": len(es.cases),
        "project_id": project_id,
        "overlay_id": overlay_id,
        "state": row["state"],
        "runner_implemented": False,
    }
    if event_sink is not None:
        try:
            event_sink(session_id or "", "evolution.eval.queued", payload)
        except Exception:  # pragma: no cover
            logger.debug("evolution.eval.queued emit failed", exc_info=True)
    return {**row, "runner_implemented": False}


def list_eval_sets_dto(root: str | None = None) -> list[dict]:
    """Cheap discovery wrapper used by the CLI list view and the API."""
    sets = discover_eval_sets(root=root or default_eval_set_dir())
    return [
        {
            "name": s.name,
            "description": s.description,
            "case_count": len(s.cases),
            "path": str(s.path),
        }
        for s in sets
    ]


def get_eval_set_dto(name: str, root: str | None = None) -> dict:
    """Wrapper returning the full case list for the API/CLI detail view."""
    es: EvalSet = get_eval_set(name, root=root or default_eval_set_dir())
    return es.to_dict()


__all__ = [
    "VALID_STATES",
    "EvalSetError",
    "enqueue_eval_run",
    "eval_run_create",
    "eval_run_get",
    "eval_run_list",
    "get_eval_set_dto",
    "list_eval_sets_dto",
]
