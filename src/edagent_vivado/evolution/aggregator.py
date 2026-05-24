"""Rolling-window aggregator (SPEC §22.7).

Reads the most recent task-scope snapshots for a project and writes a
project-scope snapshot for window ``rolling_10`` / ``rolling_50`` / ``all``.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterable

from edagent_vivado.evolution.metrics import metric_snapshot_create
from edagent_vivado.repository.db import get_db

logger = logging.getLogger(__name__)

VALID_WINDOWS = {"rolling_10": 10, "rolling_50": 50, "all": None}

# Fields aggregated by mean (numeric).
_MEAN_FIELDS = (
    "vivado_success_rate",
    "wns_ps",
    "tns_ps",
    "lut",
    "ff",
    "bram",
    "dsp",
    "task_tokens_total",
    "task_tokens_input",
    "task_tokens_output",
    "task_elapsed_sec",
    "approval_pass_rate",
    "user_thumb_score",
    "toolcalls_total",
    "vivado_toolcalls",
)
# Booleans aggregated as "share that succeeded".
_BOOL_FIELDS = ("first_run_success",)
# Integer counters aggregated by sum.
_SUM_FIELDS = ("approval_completed", "approval_rejected")


def _mean(values: Iterable[Any]) -> float | None:
    nums: list[float] = []
    for v in values:
        if v is None:
            continue
        try:
            nums.append(float(v))
        except (TypeError, ValueError):
            continue
    if not nums:
        return None
    return sum(nums) / len(nums)


def _bool_rate(values: Iterable[Any]) -> float | None:
    seen = 0
    truthy = 0
    for v in values:
        if v is None:
            continue
        seen += 1
        if bool(v):
            truthy += 1
    if seen == 0:
        return None
    return truthy / seen


def _sum_int(values: Iterable[Any]) -> int:
    total = 0
    for v in values:
        try:
            total += int(v or 0)
        except (TypeError, ValueError):
            continue
    return total


def _load_task_snapshots(
    project_id: str | None,
    limit: int | None,
) -> list[dict]:
    db = get_db()
    if project_id:
        q = (
            "SELECT * FROM metric_snapshots "
            "WHERE scope='task' AND window='single' AND project_id=? "
            "ORDER BY created_at DESC"
        )
        params: list[Any] = [project_id]
    else:
        q = (
            "SELECT * FROM metric_snapshots "
            "WHERE scope='task' AND window='single' "
            "ORDER BY created_at DESC"
        )
        params = []
    if limit is not None:
        q += " LIMIT ?"
        params.append(limit)
    rows = db.execute(q, params).fetchall()
    return [dict(r) for r in rows]


def aggregate_rolling(
    project_id: str | None,
    window: str = "rolling_10",
    *,
    event_sink=None,
    session_id: str = "",
    task_id: str = "",
) -> dict | None:
    """Aggregate the most recent task snapshots into a project-scope snapshot.

    Returns None when there is no input data; never raises.
    """
    if window not in VALID_WINDOWS:
        raise ValueError(f"unknown window: {window!r}")
    try:
        limit = VALID_WINDOWS[window]
        rows = _load_task_snapshots(project_id, limit)
        if not rows:
            return None

        decoded: list[dict] = []
        for row in rows:
            try:
                decoded.append(json.loads(row.get("metrics_json") or "{}"))
            except (json.JSONDecodeError, TypeError):
                continue
        if not decoded:
            return None

        agg: dict[str, Any] = {}
        for field in _MEAN_FIELDS:
            agg[field] = _mean(m.get(field) for m in decoded)
        for field in _BOOL_FIELDS:
            agg[field] = _bool_rate(m.get(field) for m in decoded)
        for field in _SUM_FIELDS:
            agg[field] = _sum_int(m.get(field) for m in decoded)
        agg["sample_size"] = len(decoded)

        snap = metric_snapshot_create(
            scope="project" if project_id else "global",
            window=window,
            metrics=agg,
            project_id=project_id,
            session_id=session_id or None,
            task_id=task_id or None,
            metadata={"aggregator_version": 1, "sample_size": len(decoded)},
        )

        if event_sink is not None and session_id:
            try:
                event_sink(
                    session_id,
                    "evolution.metric.snapshot",
                    {
                        "snapshot_id": snap["id"],
                        "scope": snap["scope"],
                        "window": window,
                        "composite_score": snap["composite_score"],
                        "project_id": project_id,
                        "sample_size": len(decoded),
                    },
                    task_id=task_id or "",
                )
            except Exception as exc:  # pragma: no cover
                logger.debug("rolling snapshot event emit failed: %s", exc)
        return snap
    except Exception as exc:  # pragma: no cover
        logger.exception("aggregate_rolling failed: %s", exc)
        return None


def latest_snapshot(
    *,
    project_id: str | None,
    scope: str,
    window: str,
) -> dict | None:
    """Most recent snapshot for (project, scope, window) or None."""
    db = get_db()
    if project_id:
        row = db.execute(
            """SELECT * FROM metric_snapshots
                 WHERE scope=? AND window=? AND project_id=?
                 ORDER BY created_at DESC, rowid DESC LIMIT 1""",
            (scope, window, project_id),
        ).fetchone()
    else:
        row = db.execute(
            """SELECT * FROM metric_snapshots
                 WHERE scope=? AND window=?
                 ORDER BY created_at DESC, rowid DESC LIMIT 1""",
            (scope, window),
        ).fetchone()
    if not row:
        return None
    out = dict(row)
    try:
        out["metrics"] = json.loads(out.get("metrics_json") or "{}")
    except (json.JSONDecodeError, TypeError):
        out["metrics"] = {}
    return out


def snapshot_series(
    *,
    project_id: str | None,
    scope: str = "task",
    window: str = "single",
    limit: int = 50,
) -> list[dict]:
    """Time-ordered series (oldest first) for charting.

    Falls back to ROWID as a tiebreaker so snapshots inserted within the
    same wall-clock second still come back in insertion order.
    """
    db = get_db()
    if project_id:
        rows = db.execute(
            """SELECT id, created_at, composite_score, metrics_json
                 FROM metric_snapshots
                 WHERE scope=? AND window=? AND project_id=?
                 ORDER BY created_at DESC, rowid DESC LIMIT ?""",
            (scope, window, project_id, limit),
        ).fetchall()
    else:
        rows = db.execute(
            """SELECT id, created_at, composite_score, metrics_json
                 FROM metric_snapshots
                 WHERE scope=? AND window=?
                 ORDER BY created_at DESC, rowid DESC LIMIT ?""",
            (scope, window, limit),
        ).fetchall()
    out = []
    for row in reversed(rows):
        d = dict(row)
        try:
            d["metrics"] = json.loads(d.pop("metrics_json", None) or "{}")
        except (json.JSONDecodeError, TypeError):
            d["metrics"] = {}
        out.append(d)
    return out
