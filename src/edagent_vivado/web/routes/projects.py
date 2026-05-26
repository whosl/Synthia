"""API routes: projects."""

from __future__ import annotations

import asyncio
import json
import os as _os
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
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
from edagent_vivado.web.schemas.projects import CreateProjectReq, CreateSessionReq, UpdateProjectReq
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

router = APIRouter(tags=["projects"])

# ── Project API ──────────────────────────────────────────────

@router.get("/projects")
async def api_projects(status: str | None = None, limit: int = 100, include_archived: bool = False):
    return {"projects": project_list(status=status, limit=limit, include_archived=include_archived)}


@router.post("/projects")
async def api_projects_create(req: CreateProjectReq):
    try:
        validated = validate_project_paths(
            root_path=req.root_path,
            manifest_path=req.manifest_path,
            xpr_path=req.xpr_path,
            part=req.part,
            board_part=req.board_part,
        )
    except ProjectValidationError as exc:
        raise HTTPException(400, str(exc)) from exc
    top = (req.top_module or "").strip() or validated.get("top_module")
    fields = {
        "name": req.name.strip() or Path(req.root_path).name,
        "root_path": validated["root_path"],
        "manifest_path": validated["manifest_path"],
        "xpr_path": validated["xpr_path"],
        "part": validated.get("part"),
        "board_part": validated.get("board_part"),
        "top_module": top,
        "target_language": req.target_language,
        "simulator": req.simulator,
        "source_globs": req.source_globs,
        "constraint_globs": req.constraint_globs,
        "tcl_globs": req.tcl_globs,
        "default_vivado_target_id": req.default_vivado_target_id,
        "metadata": {**(req.metadata or {}), "flow": validated.get("flow")},
    }
    p = project_create(fields)
    kb_index = None
    try:
        from edagent_vivado.knowledge.semantic_kb import reindex_project_record

        kb_index = reindex_project_record(p)
    except Exception as exc:
        kb_index = {"error": str(exc)}
    return {"project": p, "kb_index": kb_index}


@router.get("/projects/{project_id}")
async def api_project_get(project_id: str):
    p = project_get(project_id)
    if not p:
        raise HTTPException(404, "project not found")
    return {"project": p}


@router.patch("/projects/{project_id}")
async def api_project_update(project_id: str, req: UpdateProjectReq):
    existing = project_get(project_id)
    if not existing:
        raise HTTPException(404, "project not found")
    updates = req.model_dump(exclude_unset=True)
    if any(k in updates for k in ("root_path", "manifest_path", "xpr_path", "part", "board_part")):
        try:
            validated = validate_project_paths(
                root_path=updates.get("root_path") or existing["root_path"],
                manifest_path=updates.get("manifest_path") or existing["manifest_path"],
                xpr_path=updates.get("xpr_path", existing.get("xpr_path") or ""),
                part=updates.get("part") or existing.get("part"),
                board_part=updates.get("board_part") or existing.get("board_part"),
            )
        except ProjectValidationError as exc:
            raise HTTPException(400, str(exc)) from exc
        updates["root_path"] = validated["root_path"]
        updates["manifest_path"] = validated["manifest_path"]
        updates["xpr_path"] = validated["xpr_path"]
        updates["part"] = validated.get("part")
        updates["board_part"] = validated.get("board_part")
        if validated.get("top_module") and not updates.get("top_module"):
            updates["top_module"] = validated.get("top_module")
    meta = updates.pop("metadata", None)
    if meta is not None:
        prev = {}
        try:
            prev = json.loads(existing.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            prev = {}
        updates["metadata_json"] = json.dumps({**prev, **meta})
    for glob_key in ("source_globs", "constraint_globs", "tcl_globs"):
        if glob_key in updates:
            updates[f"{glob_key}_json"] = json.dumps(updates.pop(glob_key) or [])
    p = project_update(project_id, **updates)
    if not p:
        raise HTTPException(404, "project not found")
    return {"project": p}


@router.get("/projects/{project_id}/summary")
async def api_project_summary(project_id: str):
    from edagent_vivado.projects.lifecycle import project_summary

    try:
        return project_summary(project_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.post("/projects/{project_id}/reindex")
async def api_project_reindex(project_id: str):
    project = project_get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    from edagent_vivado.knowledge.semantic_kb import reindex_project_record

    return reindex_project_record(project)


@router.delete("/projects/{project_id}")
async def api_project_delete(project_id: str, hard: bool = False, confirm: str = ""):
    project = project_get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    if hard:
        expected = str(project.get("name") or project_id)
        if confirm != expected:
            raise HTTPException(
                400,
                f"hard delete requires confirm={expected!r} query parameter",
            )
    project_delete(project_id, hard=hard)
    return {"ok": True, "hard": hard}


@router.get("/projects/{project_id}/sessions")
async def api_project_sessions(
    project_id: str,
    status: str | None = None,
    limit: int = 50,
    include_archived: bool = False,
):
    if not project_get(project_id):
        raise HTTPException(404, "project not found")
    return {
        "sessions": session_list(
            status=status,
            limit=limit,
            project_id=project_id,
            include_archived=include_archived,
        ),
    }


@router.post("/projects/{project_id}/sessions")
async def api_project_sessions_create(project_id: str, req: CreateSessionReq):
    project = project_get(project_id)
    if not project:
        raise HTTPException(404, "project not found")
    if project_is_archived(project):
        raise HTTPException(403, "project is archived; unarchive before creating sessions")
    try:
        s = session_create(name=req.name, project_id=project_id, metadata=req.metadata, manifest_path=req.manifest_path)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    _ensure_project_persona(project_id)
    event_create(s["id"], "session.created", {"name": s["name"], "project_id": project_id})
    return {"session": s}

