"""API routes: approvals."""

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
from edagent_vivado.web.schemas.approvals import ApprovalDecisionReq
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

router = APIRouter(tags=["approvals"])

@router.get("/approvals")
async def api_approvals_list(
    status: str = "pending",
    project_id: str = "",
    session_id: str = "",
    connector_id: str = "",
    approval_type: str = "",
    include_interactions: bool = True,
    limit: int = 100,
):
    if include_interactions and (status or "pending") == "pending":
        from edagent_vivado.harness.approval_bridge import list_pending_approvals_unified

        rows = list_pending_approvals_unified(session_id=session_id, limit=limit)
        if connector_id:
            rows = [r for r in rows if r.get("connector_id") == connector_id]
        if approval_type:
            rows = [r for r in rows if r.get("approval_type") == approval_type]
    else:
        rows = approval_list(
            status=status or "",
            session_id=session_id,
            connector_id=connector_id,
            approval_type=approval_type,
            limit=limit,
        )
    return {"approvals": rows}


@router.get("/approvals/{approval_id}")
async def api_approval_get(approval_id: str):
    from edagent_vivado.harness.approval_bridge import get_unified_approval_detail, resolve_unified_approval_id

    kind, raw_id = resolve_unified_approval_id(approval_id)
    if kind == "interaction":
        row = get_unified_approval_detail(approval_id, raw_id)
    else:
        row = get_unified_approval_detail(approval_id)
    if not row:
        raise HTTPException(404, "approval not found")
    patch_rows = [
        p for p in patch_proposal_list(limit=200)
        if p.get("approval_id") == approval_id
    ]
    return {"approval": row, "patches": patch_rows}


@router.post("/approvals/{approval_id}/approve")
async def api_approval_approve(approval_id: str, body: ApprovalDecisionReq):
    from edagent_vivado.harness.approval_bridge import resolve_unified_approval_id

    kind, raw_id = resolve_unified_approval_id(approval_id)
    if kind == "interaction":
        from edagent_vivado.harness.interaction import (
            lookup_session_for_interaction,
            respond_interaction,
            sync_interaction_resolution_from_store,
        )

        sid = lookup_session_for_interaction(raw_id) or ""
        result = respond_interaction(raw_id, {"approved": True, "approved_indices": "all"}, session_id=sid or None)
        if not result:
            raise HTTPException(404, "interaction not found")
        sync_interaction_resolution_from_store(raw_id)
        try:
            from edagent_vivado.harness.approval_bridge import sync_approval_on_interaction_resolved as _sync

            _sync(result)
        except Exception:
            pass
        return {"approval_id": approval_id, "status": "approved", "interaction_id": raw_id}

    row = approval_get(approval_id)
    if not row:
        raise HTTPException(404, "approval not found")
    now = int(time.time())
    approval_update(
        approval_id,
        status="approved",
        decided_at=now,
        decided_by=body.decided_by,
    )
    for p in patch_proposal_list(limit=200):
        if p.get("approval_id") == approval_id and p.get("status") == "pending":
            patch_proposal_update(p["id"], status="approved")
    if row.get("session_id"):
        event_create(
            row["session_id"],
            "interaction.approved",
            {"approval_id": approval_id, "note": body.note},
            task_id=row.get("task_id"),
            run_id=row.get("run_id"),
        )
    return {"approval_id": approval_id, "status": "approved"}


@router.post("/approvals/{approval_id}/reject")
async def api_approval_reject(approval_id: str, body: ApprovalDecisionReq):
    from edagent_vivado.harness.approval_bridge import resolve_unified_approval_id

    kind, raw_id = resolve_unified_approval_id(approval_id)
    if kind == "interaction":
        from edagent_vivado.harness.interaction import (
            lookup_session_for_interaction,
            respond_interaction,
            sync_interaction_resolution_from_store,
        )

        sid = lookup_session_for_interaction(raw_id) or ""
        result = respond_interaction(raw_id, {"rejected": True}, session_id=sid or None)
        if not result:
            raise HTTPException(404, "interaction not found")
        sync_interaction_resolution_from_store(raw_id)
        try:
            from edagent_vivado.harness.approval_bridge import sync_approval_on_interaction_resolved as _sync

            _sync(result)
        except Exception:
            pass
        return {"approval_id": approval_id, "status": "rejected", "interaction_id": raw_id}

    row = approval_get(approval_id)
    if not row:
        raise HTTPException(404, "approval not found")
    now = int(time.time())
    approval_update(
        approval_id,
        status="rejected",
        decided_at=now,
        decided_by=body.decided_by,
    )
    for p in patch_proposal_list(limit=200):
        if p.get("approval_id") == approval_id:
            patch_proposal_update(p["id"], status="rejected")
            if row.get("session_id"):
                event_create(
                    row["session_id"],
                    "patch.proposal.rejected",
                    {"patch_id": p["id"], "approval_id": approval_id},
                    task_id=row.get("task_id"),
                    run_id=row.get("run_id"),
                )
    if row.get("session_id"):
        event_create(
            row["session_id"],
            "interaction.rejected",
            {"approval_id": approval_id, "note": body.note},
            task_id=row.get("task_id"),
            run_id=row.get("run_id"),
        )
    return {"approval_id": approval_id, "status": "rejected"}


@router.get("/runs/{run_id}/patches")
async def api_run_patches(run_id: str):
    r = run_get(run_id)
    if not r:
        raise HTTPException(404, "run not found")
    return {"run_id": run_id, "patches": patch_proposal_list(run_id=run_id)}


@router.post("/patches/{patch_id}/apply")
async def api_patch_apply(patch_id: str):
    from edagent_vivado.tools.patch_tools import apply_text_patch

    patch = patch_proposal_get(patch_id)
    if not patch:
        raise HTTPException(404, "patch not found")
    payload = {}
    approval = approval_get(patch.get("approval_id") or "")
    if approval:
        payload = approval.get("payload") or {}
    file_path = patch.get("target_file") or payload.get("file_path") or ""
    old_text = payload.get("old_text") or ""
    new_text = payload.get("new_text") or ""
    if not file_path:
        raise HTTPException(400, "patch missing target file")
    if not old_text or not new_text:
        raise HTTPException(400, "patch missing old_text/new_text in approval payload")
    ok, msg = apply_text_patch(file_path, old_text, new_text)
    if not ok:
        raise HTTPException(400, msg)
    now = int(time.time())
    patch_proposal_update(patch_id, status="applied", applied_at=now)
    sid = patch.get("session_id") or ""
    if sid:
        event_create(
            sid,
            "patch.proposal.applied",
            {"patch_id": patch_id, "target_file": file_path},
            task_id=patch.get("task_id"),
            run_id=patch.get("run_id"),
        )
    return {"patch_id": patch_id, "status": "applied", "message": msg}
