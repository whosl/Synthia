"""Aggregate parsed-report metrics across runs for trend visualisation."""

from __future__ import annotations

import json
from typing import Any

from edagent_vivado.repository.db import get_db

DEFAULT_METRIC_KEYS: tuple[str, ...] = (
    "wns_ns",
    "whs_ns",
    "tns_ns",
    "ths_ns",
    "lut_pct",
    "ff_pct",
    "bram_pct",
    "dsp_pct",
    "drc_error_count",
    "impl_ok",
)

_STATE_FILTER = ("succeeded", "succeeded_with_warnings", "done", "failed")


def project_trend(
    project_id: str,
    *,
    limit: int = 10,
    metric_keys: tuple[str, ...] | list[str] | None = None,
) -> dict[str, Any]:
    """Return the *limit* most recent runs for *project_id* with aggregated metrics."""
    keys = tuple(metric_keys) if metric_keys else DEFAULT_METRIC_KEYS
    db = get_db()
    placeholders = ",".join("?" for _ in _STATE_FILTER)
    rows = db.execute(
        f"""SELECT id, name, state, run_type, session_id,
                   started_at, finished_at, elapsed_ms
            FROM runs
            WHERE project_id = ?
              AND state IN ({placeholders})
            ORDER BY started_at DESC
            LIMIT ?""",
        (project_id, *_STATE_FILTER, int(limit)),
    ).fetchall()

    series: list[dict[str, Any]] = []
    for row in rows:
        run = dict(row)
        metrics = _aggregate_run_metrics(run["id"])
        series.append({
            "run_id": run["id"],
            "name": run.get("name") or run["id"],
            "state": run.get("state"),
            "run_type": run.get("run_type"),
            "session_id": run.get("session_id"),
            "started_at": run.get("started_at"),
            "finished_at": run.get("finished_at"),
            "elapsed_ms": run.get("elapsed_ms"),
            "metrics": {k: metrics.get(k) for k in keys},
            "metrics_full": metrics,
        })

    # chronological order (oldest first) for chart consumption
    series.reverse()
    return {
        "project_id": project_id,
        "metric_keys": list(keys),
        "series": series,
    }


def _aggregate_run_metrics(run_id: str) -> dict[str, Any]:
    """Flatten per-report metrics_json into a single dict keyed by report_type.field."""
    db = get_db()
    rows = db.execute(
        "SELECT report_type, stage, metrics_json, data_json FROM parsed_reports WHERE run_id=?",
        (run_id,),
    ).fetchall()

    flat: dict[str, Any] = {}
    for row in rows:
        report_type = str(row["report_type"] or "")
        stage = str(row["stage"] or "")
        metrics_raw = row["metrics_json"] or "{}"
        data_raw = row["data_json"] or "{}"
        try:
            metrics = json.loads(metrics_raw) if metrics_raw else {}
        except json.JSONDecodeError:
            metrics = {}
        try:
            data = json.loads(data_raw) if data_raw else {}
        except json.JSONDecodeError:
            data = {}

        # Backfill numeric metrics from data if metrics_json empty
        if not metrics:
            metrics = _metrics_from_data(report_type, data)

        for k, v in metrics.items():
            key = f"{report_type}_{k}"
            if stage == "impl":
                flat[key] = v
            else:
                flat.setdefault(key, v)

    # Stable aliases consumed by the frontend / trend API contract.
    flat.setdefault("wns_ns", flat.get("timing_summary_wns_ns") or flat.get("timing_summary_wns"))
    flat.setdefault("whs_ns", flat.get("timing_summary_whs_ns") or flat.get("timing_summary_whs"))
    flat.setdefault("tns_ns", flat.get("timing_summary_tns_ns") or flat.get("timing_summary_tns"))
    flat.setdefault("ths_ns", flat.get("timing_summary_ths_ns") or flat.get("timing_summary_ths"))
    flat.setdefault("lut_pct", flat.get("utilization_lut_pct"))
    flat.setdefault("ff_pct", flat.get("utilization_ff_pct"))
    flat.setdefault("bram_pct", flat.get("utilization_bram_pct"))
    flat.setdefault("dsp_pct", flat.get("utilization_dsp_pct"))
    flat.setdefault("drc_error_count", flat.get("drc_error_count"))
    flat.setdefault("drc_warning_count", flat.get("drc_warning_count"))
    flat.setdefault("impl_ok", flat.get("impl_summary_ok"))
    return flat


def _metrics_from_data(report_type: str, data: dict) -> dict[str, Any]:
    """Best-effort numeric extraction from data_json when metrics_json missing."""
    if not isinstance(data, dict):
        return {}
    if report_type == "timing_summary":
        return {
            "wns_ns": data.get("wns"),
            "tns_ns": data.get("tns"),
            "whs_ns": data.get("whs"),
            "ths_ns": data.get("ths"),
        }
    if report_type == "utilization":
        return {
            "lut_pct": data.get("lut_pct"),
            "ff_pct": data.get("ff_pct"),
            "bram_pct": data.get("bram_pct"),
            "dsp_pct": data.get("dsp_pct"),
            "lut_used": data.get("lut"),
            "ff_used": data.get("ff"),
        }
    if report_type == "drc":
        errors = data.get("errors") or []
        warnings = data.get("warnings") or []
        return {
            "error_count": len(errors),
            "warning_count": len(warnings),
            "clean": bool(data.get("clean")),
        }
    if report_type == "methodology":
        return {"count": int(data.get("count") or 0)}
    if report_type == "impl_summary":
        issues = data.get("issues") or []
        return {
            "ok": bool(data.get("ok")),
            "issue_count": len(issues),
        }
    if report_type == "bitstream":
        return {
            "bit_found": bool(data.get("found")),
            "bit_count": int(data.get("count") or 0),
        }
    return {}
