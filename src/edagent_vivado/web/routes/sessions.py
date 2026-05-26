"""API routes: sessions."""

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

router = APIRouter(tags=["sessions"])

from edagent_vivado.web.schemas.projects import CreateSessionReq  # noqa: E402
from edagent_vivado.web.schemas.sessions import UpdateSessionReq  # noqa: E402

# ── Session API ──────────────────────────────────────────────

@router.get("/sessions")
async def api_sessions(
    status: str | None = None,
    limit: int = 50,
    project_id: str | None = Query(None),
    include_archived: bool = False,
):
    return {
        "sessions": session_list(
            status=status,
            limit=limit,
            project_id=project_id,
            include_archived=include_archived,
        ),
    }

@router.post("/sessions")
async def api_sessions_create(req: CreateSessionReq):
    if not req.project_id:
        raise HTTPException(400, "project_id is required; use POST /api/v1/projects/{project_id}/sessions")
    project = project_get(req.project_id)
    if not project:
        raise HTTPException(404, "project not found")
    if project_is_archived(project):
        raise HTTPException(403, "project is archived")
    try:
        s = session_create(
            name=req.name,
            project_id=req.project_id,
            manifest_path=req.manifest_path,
            metadata=req.metadata,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    _ensure_project_persona(req.project_id)
    event_create(s["id"], "session.created", {"name": s["name"], "project_id": req.project_id})
    return {"session": s}

@router.get("/sessions/{session_id}")
async def api_session_get(session_id: str):
    s = session_get(session_id)
    if not s: raise HTTPException(404, "session not found")
    return {"session": s}

@router.patch("/sessions/{session_id}")
async def api_session_update(session_id: str, req: UpdateSessionReq):
    existing = session_get(session_id)
    if not existing:
        raise HTTPException(404, "session not found")
    updates: dict = {}
    if req.name is not None:
        updates["name"] = req.name.strip() or existing["name"]
        updates["updated_at"] = int(time.time())
    if req.status is not None:
        updates["status"] = req.status
    if req.metadata is not None:
        prev = {}
        try:
            prev = json.loads(existing.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            prev = {}
        updates["metadata_json"] = json.dumps({**prev, **req.metadata})
    if not updates:
        return {"session": existing}
    s = session_update(session_id, **updates)
    if not s:
        raise HTTPException(404)
    event_create(session_id, "session.updated", {"fields": list(updates.keys())})
    return {"session": s}

@router.delete("/sessions/{session_id}")
async def api_session_delete(session_id: str, hard: bool = False):
    s = session_get(session_id)
    if not s:
        raise HTTPException(404, "session not found")
    if s.get("project_id"):
        project = project_get(s["project_id"])
        if project_is_archived(project):
            pass  # allow archive/delete on archived project's sessions
    session_delete(session_id, hard=hard)
    event_type = "session.archived" if not hard else "session.deleted"
    try: event_create(session_id, event_type, {"hard": hard})
    except: pass
    return {"ok": True}

# ── Message API ──────────────────────────────────────────────

@router.get("/sessions/{session_id}/messages")
async def api_messages(session_id: str, before: int | None = None, limit: int = 100):
    return {"messages": message_list(session_id, before=before, limit=limit)}
