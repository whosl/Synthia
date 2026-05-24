"""Post-task metric collector (SPEC §22.7).

Reads facts from existing tables (tasks / tool_calls / llm_usage / feedback /
interactions-via-events) and writes one ``metric_snapshots`` row per finished
task. Behavior is purely additive — failures only log; they must never let an
exception escape ``task.done``.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Iterable

from edagent_vivado.evolution.feedback import feedback_thumb_for_task
from edagent_vivado.evolution.metrics import metric_snapshot_create
from edagent_vivado.repository.db import get_db
from edagent_vivado.repository.store import task_get, toolcall_list, usage_list

logger = logging.getLogger(__name__)

VIVADO_EXECUTION_TOOLS = {
    "run_vivado_synth_tool",
    "run_vivado_impl_tool",
    "run_vivado_flow_tool",
    "run_vivado_tcl_tool",
    "run_vivado_script_tool",
}
VIVADO_PRIMARY_FLOW_TOOLS = {
    "run_vivado_synth_tool",
    "run_vivado_impl_tool",
    "run_vivado_flow_tool",
}
APPROVAL_GATED_TOOLS = VIVADO_EXECUTION_TOOLS | {
    "create_file_tool",
    "propose_patch_tool",
    "request_approval",
    "request_user_input",
}


def _safe_json(text: str | None) -> dict[str, Any]:
    if not text or not isinstance(text, str):
        return {}
    text = text.strip()
    if not text.startswith("{"):
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def _toolcalls_for_task(task_id: str, run_id: str) -> list[dict]:
    """Toolcalls for this task. Prefer run scope (set by ObservedToolRunner)."""
    if run_id:
        rows = toolcall_list(run_id=run_id, limit=500)
        if rows:
            return rows
    rows = get_db().execute(
        "SELECT * FROM tool_calls WHERE task_id=? ORDER BY started_at ASC LIMIT 500",
        (task_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def _first_run_success(vivado_calls: Iterable[dict]) -> bool | None:
    """Did the first invoked primary flow tool succeed?"""
    for tc in vivado_calls:
        if tc.get("tool_name") not in VIVADO_PRIMARY_FLOW_TOOLS:
            continue
        payload = _safe_json(tc.get("output_summary"))
        outcome = str(payload.get("edagent_outcome") or "").lower()
        if not outcome:
            return None if tc.get("state") not in ("completed", "error", "rejected") else (
                tc.get("state") == "completed"
            )
        return outcome == "execution_succeeded"
    return None


def _latest_timing(toolcalls: Iterable[dict]) -> tuple[int | None, int | None]:
    """Return (wns_ps, tns_ps) from the most recent successful parse_timing_tool call."""
    wns_ps: int | None = None
    tns_ps: int | None = None
    for tc in reversed(list(toolcalls)):
        if tc.get("tool_name") != "parse_timing_tool":
            continue
        payload = _safe_json(tc.get("output_summary"))
        if not payload:
            continue
        wns = payload.get("wns")
        tns = payload.get("tns")
        try:
            if wns is not None:
                # parse_timing_tool yields nanoseconds; metric stores picoseconds for precision.
                wns_ps = int(round(float(wns) * 1000.0))
            if tns is not None:
                tns_ps = int(round(float(tns) * 1000.0))
        except (TypeError, ValueError):
            continue
        if wns_ps is not None or tns_ps is not None:
            break
    return wns_ps, tns_ps


def _latest_utilization(toolcalls: Iterable[dict]) -> dict[str, Any]:
    """Return raw LUT/FF/BRAM/DSP from the most recent parse_utilization_tool call."""
    out: dict[str, Any] = {}
    for tc in reversed(list(toolcalls)):
        if tc.get("tool_name") != "parse_utilization_tool":
            continue
        payload = _safe_json(tc.get("output_summary"))
        if not payload:
            continue
        for key in ("lut", "ff", "bram", "dsp"):
            if payload.get(key) is not None:
                out[key] = payload[key]
        if out:
            break
    return out


def _approval_pass_rate(toolcalls: Iterable[dict]) -> tuple[float | None, int, int]:
    """Across approval-gated toolcalls only, how many ran vs were rejected."""
    completed = 0
    rejected = 0
    for tc in toolcalls:
        name = tc.get("tool_name") or ""
        if name not in APPROVAL_GATED_TOOLS:
            continue
        state = (tc.get("state") or "").lower()
        if state == "rejected":
            rejected += 1
            continue
        payload = _safe_json(tc.get("output_summary"))
        outcome = str(payload.get("edagent_outcome") or "").lower()
        if outcome == "user_rejected":
            rejected += 1
            continue
        if state == "completed" or outcome in ("execution_succeeded", "approved", "partially_approved"):
            completed += 1
    total = completed + rejected
    if total == 0:
        return None, completed, rejected
    return completed / total, completed, rejected


def _project_id_for_task(task_id: str) -> str | None:
    row = get_db().execute(
        "SELECT s.project_id FROM tasks t JOIN sessions s ON t.session_id=s.id WHERE t.id=?",
        (task_id,),
    ).fetchone()
    return str(row["project_id"]) if row and row["project_id"] else None


def collect_task_metrics(
    *,
    session_id: str,
    task_id: str,
    run_id: str = "",
    overlay_id: str | None = None,
    trial_id: str | None = None,
    arm: str | None = None,
    event_sink=None,
) -> dict | None:
    """Compute and persist one ``metric_snapshots`` row for a finished task.

    Returns the snapshot dict, or None on failure. Never raises.
    """
    try:
        task = task_get(task_id) or {}
        toolcalls = _toolcalls_for_task(task_id, run_id)
        vivado_calls = [tc for tc in toolcalls if tc.get("tool_name") in VIVADO_EXECUTION_TOOLS]

        # Tokens
        token_in = 0
        token_out = 0
        for u in usage_list(run_id=run_id) if run_id else []:
            token_in += int(u.get("input_tokens") or 0)
            token_out += int(u.get("output_tokens") or 0)

        # Elapsed
        started_at = int(task.get("started_at") or 0)
        finished_at = int(task.get("finished_at") or 0)
        elapsed_sec: float | None = None
        if started_at and finished_at:
            elapsed_sec = max(0.0, float(finished_at - started_at))

        # Vivado-derived
        first_run_success = _first_run_success(vivado_calls)
        wns_ps, tns_ps = _latest_timing(toolcalls)
        util = _latest_utilization(toolcalls)

        # Approval / interaction
        approval_pass_rate, completed_n, rejected_n = _approval_pass_rate(toolcalls)

        # User feedback
        thumb = feedback_thumb_for_task(task_id)

        # Vivado success rate within the task (multiple Vivado invocations possible)
        vivado_total = 0
        vivado_ok = 0
        for tc in vivado_calls:
            state = (tc.get("state") or "").lower()
            payload = _safe_json(tc.get("output_summary"))
            outcome = str(payload.get("edagent_outcome") or "").lower()
            if state == "rejected" or outcome == "user_rejected":
                continue
            vivado_total += 1
            if state == "completed" or outcome == "execution_succeeded":
                vivado_ok += 1
        vivado_success_rate: float | None = None
        if vivado_total > 0:
            vivado_success_rate = vivado_ok / vivado_total

        metrics: dict[str, Any] = {
            "first_run_success": first_run_success,
            "vivado_success_rate": vivado_success_rate,
            "wns_ps": wns_ps,
            "tns_ps": tns_ps,
            "lut": util.get("lut"),
            "ff": util.get("ff"),
            "bram": util.get("bram"),
            "dsp": util.get("dsp"),
            "task_tokens_total": token_in + token_out,
            "task_tokens_input": token_in,
            "task_tokens_output": token_out,
            "task_elapsed_sec": elapsed_sec,
            "approval_pass_rate": approval_pass_rate,
            "approval_completed": completed_n,
            "approval_rejected": rejected_n,
            "user_thumb_score": thumb,
            "toolcalls_total": len(toolcalls),
            "vivado_toolcalls": len(vivado_calls),
        }

        project_id = _project_id_for_task(task_id)
        snap = metric_snapshot_create(
            scope="task",
            window="single",
            metrics=metrics,
            project_id=project_id,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id or None,
            overlay_id=overlay_id,
            trial_id=trial_id,
            arm=arm,
            metadata={"collector_version": 1},
        )

        if event_sink is not None:
            try:
                event_sink(
                    session_id,
                    "evolution.metric.snapshot",
                    {
                        "snapshot_id": snap["id"],
                        "scope": "task",
                        "window": "single",
                        "composite_score": snap["composite_score"],
                        "project_id": project_id,
                        "task_id": task_id,
                    },
                    task_id=task_id,
                    run_id=run_id or "",
                )
            except Exception as exc:  # pragma: no cover
                logger.debug("metric.snapshot event emit failed: %s", exc)
        return snap
    except Exception as exc:  # pragma: no cover - never propagate
        logger.exception("collect_task_metrics failed: %s", exc)
        return None
