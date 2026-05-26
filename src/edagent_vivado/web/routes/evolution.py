"""API routes: evolution."""

from __future__ import annotations

import asyncio
import json
import os as _os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from edagent_vivado.events.catalog import ALL_WIRE_EVENT_TYPES, PROTOCOL_VERSION
from edagent_vivado.events.envelope import enrich_wire_event
from edagent_vivado.harness.execution_approval import (
    is_vivado_execution_approved,
    set_vivado_execution_approval,
)
from edagent_vivado.harness.file_patch_policy import (
    is_file_patch_tool,
    is_file_tool_queued_for_approval,
    is_interaction_tool,
    normalize_tool_output,
)
from edagent_vivado.projects.snapshot import snapshot_manifest_path
from edagent_vivado.projects.validate import ProjectValidationError, validate_project_paths
from edagent_vivado.repository.store import (
    approval_get,
    approval_list,
    approval_update,
    artifact_list,
    capability_list,
    connector_get,
    connector_list,
    context_package_get,
    context_package_items,
    context_packages_for_run,
    context_packages_for_session,
    event_list,
    event_list_for_run,
    knowledge_source_list,
    kb_candidate_approve,
    kb_candidate_get,
    kb_candidate_list,
    kb_candidate_merge,
    kb_candidate_reject,
    memory_latest,
    memory_list,
    message_create,
    message_list,
    monitor_overview,
    monitor_retention_cleanup,
    parsed_report_get,
    parsed_report_list,
    parsed_report_trends,
    patch_proposal_get,
    patch_proposal_list,
    patch_proposal_update,
    problem_list,
    project_create,
    project_delete,
    project_get,
    project_is_archived,
    project_list,
    project_update,
    retrieval_audit_get,
    retrieval_audit_items,
    retrieval_audits_for_run,
    retrieval_audits_for_session,
    run_create,
    run_get,
    run_list,
    run_step_list,
    run_update,
    session_create,
    session_delete,
    session_get,
    session_list,
    session_update,
    task_active_for_session,
    task_create,
    task_get,
    task_update,
    toolcall_list,
    usage_create,
    usage_list,
    usage_totals_for_session,
    vivado_command_list,
)
from edagent_vivado.tools.patch_tools import is_patch_approved, set_patch_approval
from edagent_vivado.web.schemas.evolution import (
    CandidateApproveReq,
    CandidateMergeReq,
    CandidateRejectReq,
    CandidateRollbackReq,
    EvalRunReq,
    GeneratorRunReq,
    ToolValidateReq,
    TrialAbortReq,
    TrialConfigSetReq,
    TrialDecideReq,
)
from edagent_vivado.web.api_shared import (
    _archive_task_canvas,
    _blocked_tool_runs,
    _early_blocked_tool_runs,
    _early_completed_toolcall_ids,
    _ensure_project_persona,
    _flush_pending_file_batch,
    _langgraph_tool_run_key,
    _memory_pipeline_on_message,
    _publish,
    _stream_queues,
    _vivado_reject_run_keys,
    event_create,
)

router = APIRouter(tags=["evolution"])

def _candidate_dto(row: dict, *, include_apply_preview: bool = False) -> dict:
    """Decode JSON fields so the frontend can use them directly."""
    try:
        signal = json.loads(row.get("signal_source_json") or "{}")
    except json.JSONDecodeError:
        signal = {}
    try:
        meta = json.loads(row.get("metadata_json") or "{}")
    except json.JSONDecodeError:
        meta = {}
    out = dict(row)
    out["signal_source"] = signal
    out["metadata"] = meta
    if include_apply_preview:
        try:
            from edagent_vivado.evolution import preview_candidate_payload

            out["apply_preview"] = preview_candidate_payload(row["id"])
        except Exception:
            out["apply_preview"] = None
    return out


@router.get("/evolution/candidates")
async def api_evolution_candidates_list(
    status: str = "pending",
    surface: str = "",
    project_id: str = "",
    limit: int = Query(100, ge=1, le=500),
):
    from edagent_vivado.evolution import candidate_list

    rows = candidate_list(
        status=status or None,
        surface=surface or None,
        project_id=project_id or None,
        limit=limit,
    )
    return {
        "candidates": [_candidate_dto(r) for r in rows],
        "filters": {
            "status": status or None,
            "surface": surface or None,
            "project_id": project_id or None,
        },
        "count": len(rows),
    }


@router.get("/evolution/candidates/{candidate_id}")
async def api_evolution_candidate_get(candidate_id: str):
    from edagent_vivado.evolution import candidate_get

    row = candidate_get(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {"candidate": _candidate_dto(row, include_apply_preview=True)}


@router.get("/evolution/candidates/{candidate_id}/preview")
async def api_evolution_candidate_preview(candidate_id: str):
    """Return the overlay payload that would be applied on approve (read-only)."""
    from edagent_vivado.evolution import preview_candidate_payload

    try:
        preview = preview_candidate_payload(candidate_id)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"preview": preview}



@router.post("/evolution/candidates/{candidate_id}/approve")
async def api_evolution_candidate_approve(candidate_id: str, body: CandidateApproveReq):
    from edagent_vivado.evolution import approve_candidate, candidate_get

    try:
        updated = approve_candidate(
            candidate_id,
            reviewed_by=body.reviewed_by or "user",
            payload_override=body.payload,
            force_active=body.force_active,
            confirm_source_reviewed=body.confirm_source_reviewed,
            event_sink=event_create,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    cand = candidate_get(candidate_id)
    return {
        "candidate": _candidate_dto(updated or cand or {"id": candidate_id}),
        "overlay_id": (updated or {}).get("applied_overlay_id"),
    }



@router.post("/evolution/tools/validate")
async def api_evolution_tool_validate(body: ToolValidateReq):
    """Pre-flight AST validation for evolved tool sources.

    Returns ``ok=true`` plus ``tool_name`` / ``hash`` / ``source_bytes`` on
    success. 400 on any sandbox rejection, with a structured ``reason`` so
    the review UI can show a precise error before the user hits Approve.
    """
    from edagent_vivado.evolution import SandboxError, validate_evolved_tool_source

    try:
        result = validate_evolved_tool_source(body.source)
    except SandboxError as exc:
        raise HTTPException(
            status_code=400,
            detail={"ok": False, "reason": exc.reason, "detail": exc.detail},
        ) from exc
    if body.name and result["tool_name"] != body.name:
        raise HTTPException(
            status_code=400,
            detail={
                "ok": False,
                "reason": "name_mismatch",
                "detail": f"declared {body.name!r}, source defines {result['tool_name']!r}",
            },
        )
    return result



@router.post("/evolution/candidates/{candidate_id}/reject")
async def api_evolution_candidate_reject(candidate_id: str, body: CandidateRejectReq):
    from edagent_vivado.evolution import reject_candidate

    if body.suppress_days < 0 or body.suppress_days > 365:
        raise HTTPException(400, "suppress_days must be between 0 and 365")
    try:
        updated = reject_candidate(
            candidate_id,
            reviewed_by=body.reviewed_by or "user",
            suppress_days=body.suppress_days,
            reason=body.reason,
            event_sink=event_create,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"candidate": _candidate_dto(updated or {})}



@router.post("/evolution/candidates/{candidate_id}/merge")
async def api_evolution_candidate_merge(candidate_id: str, body: CandidateMergeReq):
    from edagent_vivado.evolution import merge_candidate

    try:
        updated = merge_candidate(
            candidate_id,
            reviewed_by=body.reviewed_by or "user",
            event_sink=event_create,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"candidate": _candidate_dto(updated or {})}



@router.post("/evolution/candidates/{candidate_id}/rollback")
async def api_evolution_candidate_rollback(candidate_id: str, body: CandidateRollbackReq):
    from edagent_vivado.evolution import rollback_candidate

    try:
        updated = rollback_candidate(
            candidate_id,
            reviewed_by=body.reviewed_by or "user",
            reason=body.reason,
            event_sink=event_create,
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"candidate": _candidate_dto(updated or {})}


def _overlay_dto(row: dict) -> dict:
    """Serialise an overlay row with decoded payload + metadata."""
    out = dict(row)
    if "payload" not in out:
        try:
            out["payload"] = json.loads(out.get("payload_json") or "{}")
        except json.JSONDecodeError:
            out["payload"] = {}
    if "metadata" not in out:
        try:
            out["metadata"] = json.loads(out.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            out["metadata"] = {}
    return out


@router.get("/evolution/overlays")
async def api_evolution_overlays_list(
    project_id: str = "",
    surface: str = "",
    state: str = "",
    scope: str = "",
    limit: int = Query(200, ge=1, le=500),
):
    from edagent_vivado.evolution import overlay_list

    rows = overlay_list(
        project_id=project_id or None,
        surface=surface or None,
        state=state or None,
        scope=scope or None,
        limit=limit,
    )
    return {
        "overlays": [_overlay_dto(r) for r in rows],
        "filters": {
            "project_id": project_id or None,
            "surface": surface or None,
            "state": state or None,
            "scope": scope or None,
        },
        "count": len(rows),
    }


@router.get("/evolution/overlays/{overlay_id}")
async def api_evolution_overlay_get(overlay_id: str):
    from edagent_vivado.evolution import overlay_get

    row = overlay_get(overlay_id)
    if not row:
        raise HTTPException(404, "overlay not found")
    return {"overlay": _overlay_dto(row)}


@router.post("/evolution/overlays/{overlay_id}/retire")
async def api_evolution_overlay_retire(overlay_id: str):
    from edagent_vivado.evolution import retire_overlay

    try:
        out = retire_overlay(overlay_id, event_sink=event_create)
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    return {"overlay": _overlay_dto(out)}


# ── Trial config (SPEC §22 SE-PR5) ────────────────────────────


@router.get("/evolution/config")
async def api_evolution_config(project_id: str = ""):
    from edagent_vivado.evolution import (
        DECISION_MARGIN,
        MIN_SAMPLES_PER_ARM,
        TRIAL_FORBIDDEN_SURFACES,
        project_trial_config,
    )

    if not project_id:
        return {
            "project_id": None,
            "trials": {},
            "forbidden_surfaces": sorted(TRIAL_FORBIDDEN_SURFACES),
            "min_samples_per_arm": MIN_SAMPLES_PER_ARM,
            "decision_margin": DECISION_MARGIN,
        }
    if not project_get(project_id):
        raise HTTPException(404, "project not found")
    return {
        "project_id": project_id,
        "trials": project_trial_config(project_id),
        "forbidden_surfaces": sorted(TRIAL_FORBIDDEN_SURFACES),
        "min_samples_per_arm": MIN_SAMPLES_PER_ARM,
        "decision_margin": DECISION_MARGIN,
    }



@router.post("/evolution/config")
async def api_evolution_config_set(body: TrialConfigSetReq):
    from edagent_vivado.evolution import set_trial_enabled

    if not project_get(body.project_id):
        raise HTTPException(404, "project not found")
    try:
        out = set_trial_enabled(body.project_id, body.surface, body.enabled)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "project_id": body.project_id,
        "surface": body.surface,
        "enabled": out,
    }


# ── Trials (SPEC §22 SE-PR5) ─────────────────────────────────


def _trial_dto(row: dict) -> dict:
    """Serialise a trial row with decoded payload + per-arm score buckets."""
    out = dict(row)
    for col_json, col_decoded in (
        ("metric_baseline_json", "metric_baseline"),
        ("metric_variant_json", "metric_variant"),
        ("metadata_json", "metadata"),
    ):
        if col_decoded in out:
            continue
        raw = out.get(col_json)
        if isinstance(raw, str) and raw:
            try:
                out[col_decoded] = json.loads(raw)
            except json.JSONDecodeError:
                out[col_decoded] = {}
        else:
            out[col_decoded] = {}
    return out


@router.get("/evolution/trials")
async def api_evolution_trials_list(
    project_id: str = "",
    state: str = "",
    surface: str = "",
    limit: int = Query(200, ge=1, le=500),
):
    from edagent_vivado.evolution import trial_list

    rows = trial_list(
        project_id=project_id or None,
        state=state or None,
        surface=surface or None,
        limit=limit,
    )
    return {
        "trials": [_trial_dto(r) for r in rows],
        "filters": {
            "project_id": project_id or None,
            "state": state or None,
            "surface": surface or None,
        },
        "count": len(rows),
    }


@router.get("/evolution/trials/{trial_id}")
async def api_evolution_trial_get(trial_id: str):
    from edagent_vivado.evolution import trial_get

    row = trial_get(trial_id)
    if not row:
        raise HTTPException(404, "trial not found")
    return {"trial": _trial_dto(row)}



@router.post("/evolution/trials/{trial_id}/decide")
async def api_evolution_trial_decide(trial_id: str, body: TrialDecideReq):
    """Operator override that decides a trial regardless of sample count."""
    from edagent_vivado.evolution import force_decision

    try:
        out = force_decision(
            trial_id,
            body.decision,
            reviewed_by=body.reviewed_by or "user",
            event_sink=event_create,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    if not out:
        raise HTTPException(404, "trial not found")
    return {"trial": _trial_dto(out)}



@router.post("/evolution/trials/{trial_id}/abort")
async def api_evolution_trial_abort(trial_id: str, body: TrialAbortReq):
    from edagent_vivado.evolution import abort_trial

    out = abort_trial(trial_id, reason=body.reason or "manual_abort", event_sink=event_create)
    if not out:
        raise HTTPException(404, "trial not found")
    return {"trial": _trial_dto(out)}


# ── Eval set placeholder (SPEC §22.6B SE-PR6) ────────────────


@router.get("/evolution/eval/sets")
async def api_evolution_eval_sets_list():
    from edagent_vivado.evolution import list_eval_sets_dto

    sets = list_eval_sets_dto()
    return {"sets": sets, "count": len(sets), "runner_implemented": False}


@router.get("/evolution/eval/sets/{name}")
async def api_evolution_eval_set_get(name: str):
    from edagent_vivado.evolution import EvalSetError, get_eval_set_dto

    try:
        return {"set": get_eval_set_dto(name), "runner_implemented": False}
    except EvalSetError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/evolution/eval/runs")
async def api_evolution_eval_runs_list(
    eval_set: str = "",
    state: str = "",
    limit: int = Query(100, ge=1, le=500),
):
    from edagent_vivado.evolution import eval_run_list

    rows = eval_run_list(
        eval_set=eval_set or None,
        state=state or None,
        limit=limit,
    )
    return {"runs": rows, "count": len(rows), "runner_implemented": False}


@router.get("/evolution/eval/runs/{run_id}")
async def api_evolution_eval_run_get(run_id: str):
    from edagent_vivado.evolution import eval_run_get

    row = eval_run_get(run_id)
    if not row:
        raise HTTPException(404, "eval_run not found")
    return {"run": row, "runner_implemented": False}



@router.post("/evolution/eval/run")
async def api_evolution_eval_run(body: EvalRunReq):
    """Queue a placeholder eval_run.

    SE-PR6 ships schema + dispatch only; the runner that drives cases through
    the agent loop is not yet implemented. The response is HTTP 200 (the
    request itself succeeded — the row is in the table) and carries
    ``state="placeholder"`` together with ``runner_implemented=false`` so
    callers can distinguish "submitted but pending the future runner" from
    "ran and finished".
    """
    from edagent_vivado.evolution import EvalSetError, enqueue_eval_run

    if body.project_id and not project_get(body.project_id):
        raise HTTPException(404, "project not found")
    try:
        row = enqueue_eval_run(
            body.eval_set,
            project_id=body.project_id,
            overlay_id=body.overlay_id,
            note=body.note,
            event_sink=event_create,
        )
    except EvalSetError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {
        "run": row,
        "runner_implemented": False,
        "note": "SE-PR6 placeholder — runner lands in a later PR (SPEC §22.6B)",
    }



@router.post("/evolution/generators/run")
async def api_evolution_generators_run(body: GeneratorRunReq):
    """On-demand trigger for the SE-PR3 generators.

    Mainly for debugging / catching up after a backfill; the live system
    runs the same dispatcher automatically after every ``task.done``.
    """
    from edagent_vivado.evolution import run_generators

    if body.project_id and not project_get(body.project_id):
        raise HTTPException(404, "project not found")
    sink = event_create if body.session_id else None
    result = run_generators(
        project_id=body.project_id,
        session_id=body.session_id or "",
        task_id=body.task_id or "",
        event_sink=sink,
        only=body.only,
    )
    return {
        "project_id": body.project_id,
        "created": result.get("created", []),
        "errors": result.get("errors", {}),
    }
