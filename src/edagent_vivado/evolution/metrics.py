"""Metric snapshot helpers (SPEC §22.6).

SE-PR1 only ships the storage primitive and composite-score formula. The
post-task collector that actually writes one snapshot per ``task.done`` lives
in SE-PR2, alongside the rolling aggregator.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass

from edagent_vivado.repository.db import get_db


# Default weights — overrideable via project metadata in later PRs.
DEFAULT_WEIGHTS: dict[str, float] = {
    "timing": 0.40,         # WNS-derived
    "first_run": 0.25,      # first_run_success
    "approval": 0.15,       # approval_pass_rate
    "token": 0.10,          # inverse of task_tokens_total
    "user": 0.10,           # user_thumb_score normalized
}


@dataclass
class MetricSnapshot:
    id: str
    scope: str
    metrics: dict
    composite_score: float


def composite_score(metrics: dict, weights: dict[str, float] | None = None) -> float:
    """Compute a 0..1 composite score from a metrics dict.

    Missing components contribute neutral (0.5) so partial telemetry does not
    nuke the score; SE-PR4 will expose this in the review UI with a breakdown.
    """
    w = {**DEFAULT_WEIGHTS, **(weights or {})}

    def _norm_wns(v) -> float:
        if v is None:
            return 0.5
        try:
            wns = float(v)
        except (TypeError, ValueError):
            return 0.5
        if wns >= 0:
            return 1.0
        return max(0.0, 1.0 + wns / 1000.0)  # -1000 ps -> 0

    def _norm_bool(v, default: float = 0.5) -> float:
        if isinstance(v, bool):
            return 1.0 if v else 0.0
        if v is None:
            return default
        return 0.5

    def _norm_rate(v) -> float:
        if v is None:
            return 0.5
        try:
            return max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            return 0.5

    def _norm_tokens(v) -> float:
        if v is None:
            return 0.5
        try:
            n = float(v)
        except (TypeError, ValueError):
            return 0.5
        if n <= 0:
            return 0.5
        # 5k tokens -> 1.0, 50k -> 0.0, exponential decay
        return max(0.0, min(1.0, 1.5 - (n / 30_000.0)))

    def _norm_thumb(v) -> float:
        if v is None:
            return 0.5
        try:
            t = int(v)
        except (TypeError, ValueError):
            return 0.5
        return {1: 1.0, 0: 0.5, -1: 0.0}.get(t, 0.5)

    score = (
        w["timing"]   * _norm_wns(metrics.get("wns_ps"))
        + w["first_run"] * _norm_bool(metrics.get("first_run_success"))
        + w["approval"]  * _norm_rate(metrics.get("approval_pass_rate"))
        + w["token"]     * _norm_tokens(metrics.get("task_tokens_total"))
        + w["user"]      * _norm_thumb(metrics.get("user_thumb_score"))
    )
    total_w = sum(w[k] for k in ("timing", "first_run", "approval", "token", "user"))
    return round(score / total_w if total_w else 0.0, 4)


def metric_snapshot_create(
    *,
    scope: str = "task",
    window: str = "single",
    metrics: dict,
    project_id: str | None = None,
    session_id: str | None = None,
    task_id: str | None = None,
    run_id: str | None = None,
    overlay_id: str | None = None,
    trial_id: str | None = None,
    arm: str | None = None,
    metadata: dict | None = None,
) -> dict:
    sid = uuid.uuid4().hex[:12]
    score = composite_score(metrics)
    metrics = {**metrics, "composite_score": score}
    db = get_db()
    db.execute(
        """INSERT INTO metric_snapshots(
            id, project_id, session_id, task_id, run_id, overlay_id, trial_id, arm,
            scope, window, metrics_json, composite_score, created_at, metadata_json
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            sid, project_id, session_id, task_id, run_id, overlay_id, trial_id, arm,
            scope, window, json.dumps(metrics), score, int(time.time()),
            json.dumps(metadata or {}),
        ),
    )
    db.commit()
    return {"id": sid, "scope": scope, "metrics": metrics, "composite_score": score}
