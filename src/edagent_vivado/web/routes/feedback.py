"""API routes: feedback."""

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
from edagent_vivado.web.schemas.feedback import FeedbackReq
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

router = APIRouter(tags=["feedback"])

@router.post("/feedback")
async def api_feedback_create(req: FeedbackReq):
    if req.user_thumb is not None and req.user_thumb not in (-1, 0, 1):
        raise HTTPException(400, "user_thumb must be -1, 0, or 1")
    sess = session_get(req.session_id)
    if not sess:
        raise HTTPException(404, "session not found")
    from edagent_vivado.evolution import feedback_create

    try:
        row = feedback_create(
            session_id=req.session_id,
            task_id=req.task_id,
            message_id=req.message_id,
            user_thumb=req.user_thumb,
            comment=(req.comment or None),
            tags=req.tags,
            metadata=req.metadata,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    event_create(
        req.session_id,
        "evolution.feedback.created",
        {
            "feedback_id": row["id"],
            "user_thumb": row.get("user_thumb"),
            "task_id": req.task_id,
            "message_id": req.message_id,
        },
        task_id=req.task_id or "",
    )
    return {"feedback": row}


@router.get("/sessions/{session_id}/feedback")
async def api_feedback_list(session_id: str, limit: int = 200):
    from edagent_vivado.evolution import feedback_list_for_session

    return {"feedback": feedback_list_for_session(session_id, limit=limit)}
