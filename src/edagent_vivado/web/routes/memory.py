"""API routes: memory."""

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

router = APIRouter(tags=["memory"])

@router.get("/memory/canvas/active")
async def api_memory_canvas_active(task_id: str = Query(...)):
    from edagent_vivado.memory.canvas import get_active_canvas

    data = get_active_canvas(task_id)
    if not data:
        return {"mermaid": "graph TD\n", "version": 0, "node_count": 0, "nodes": []}
    canvas = data["canvas"]
    nodes = [
        {
            "node_id": n["node_id"],
            "label": n.get("label") or "",
            "ref_type": n.get("ref_type") or "",
            "ref_id": n.get("ref_id") or "",
        }
        for n in data["nodes"]
    ]
    return {
        "mermaid": data["mermaid"],
        "version": canvas.get("version") or 1,
        "node_count": canvas.get("node_count") or len(nodes),
        "nodes": nodes,
    }


@router.get("/memory/canvas/history")
async def api_memory_canvas_history(session_id: str = Query(...), limit: int = Query(3, ge=1, le=20)):
    from edagent_vivado.memory.canvas import list_canvas_history

    rows = list_canvas_history(session_id, limit=limit)
    return {
        "canvases": [
            {
                "id": r["id"],
                "task_id": r["task_id"],
                "session_id": r["session_id"],
                "version": r.get("version") or 1,
                "node_count": r.get("node_count") or 0,
                "state": r.get("state") or "archived",
                "created_at": r.get("created_at"),
                "updated_at": r.get("updated_at"),
                "mermaid": r.get("mermaid") or "graph TD\n",
            }
            for r in rows
        ]
    }


@router.get("/memory/refs/{node_id}")
async def api_memory_ref(node_id: str):
    from edagent_vivado.memory.refs import read_ref
    from edagent_vivado.repository.store import canvas_get, canvas_node_ref_get_by_node_id

    ref_row = canvas_node_ref_get_by_node_id(node_id)
    if not ref_row:
        raise HTTPException(404, "ref not found")
    canvas = canvas_get(ref_row["canvas_id"]) or {}
    session_id = str(canvas.get("session_id") or "")
    content = read_ref(node_id, session_id=session_id) or ""
    return {
        "content": content,
        "ref_type": ref_row.get("ref_type") or "",
        "ref_id": ref_row.get("ref_id") or "",
        "label": ref_row.get("label") or "",
    }


@router.get("/memory/atoms")
async def api_memory_atoms(
    project_id: str = Query(...),
    atom_type: str = Query(""),
    limit: int = Query(50, ge=1, le=200),
):
    from edagent_vivado.memory.atoms import list_atoms_for_project

    rows = list_atoms_for_project(project_id, atom_type=atom_type, limit=limit)
    return {
        "atoms": [
            {
                "id": r["id"],
                "scope": r.get("scope") or "project",
                "project_id": r.get("project_id") or "",
                "atom_type": r.get("atom_type") or "",
                "subject": r.get("subject") or "",
                "predicate": r.get("predicate") or "",
                "object": r.get("object") or "",
                "confidence": r.get("confidence"),
                "source_session_id": r.get("source_session_id") or "",
                "created_at": r.get("created_at"),
            }
            for r in rows
        ],
        "count": len(rows),
    }


@router.get("/memory/persona")
async def api_memory_persona(project_id: str = Query(...)):
    from edagent_vivado.memory.personas import get_project_persona

    return get_project_persona(project_id)


@router.get("/memory/scenarios")
async def api_memory_scenarios(project_id: str = Query(...), limit: int = Query(20, ge=1, le=100)):
    from edagent_vivado.memory.scenarios import list_scenarios_for_project

    rows = list_scenarios_for_project(project_id, limit=limit)
    return {
        "scenarios": [
            {
                "id": r["id"],
                "title": r.get("title") or "",
                "trigger_pattern": r.get("trigger_pattern") or "",
                "occurrence_count": r.get("occurrence_count") or 0,
                "atom_ids": r.get("atom_ids") or [],
                "updated_at": r.get("updated_at"),
                "markdown": r.get("markdown") or "",
            }
            for r in rows
        ],
        "count": len(rows),
    }


@router.post("/memory/rebuild")
async def api_memory_rebuild(
    project_id: str = Query(...),
    level: str = Query("all"),
):
    from edagent_vivado.memory.personas import build_project_persona
    from edagent_vivado.memory.scenarios import aggregate_scenarios

    result: dict = {"project_id": project_id, "level": level}
    if level in ("scenario", "scenarios", "l2", "all"):
        result["scenarios"] = len(aggregate_scenarios(project_id, min_interval_seconds=0))
    if level in ("persona", "l3", "all"):
        row = build_project_persona(project_id, force=True)
        result["persona_version"] = (row or {}).get("version")
        result["persona_built"] = row is not None
    return result
