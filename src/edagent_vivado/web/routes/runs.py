"""API routes: runs."""

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

router = APIRouter(tags=["runs"])

@router.get("/runs/{run_id}/steps")
async def api_run_steps(run_id: str):
    r = run_get(run_id)
    if not r:
        raise HTTPException(404, "run not found")
    return {"run_id": run_id, "steps": run_step_list(run_id)}


@router.get("/runs/{run_id}/workspace")
async def api_run_workspace(run_id: str):
    from edagent_vivado.harness.run_workspace import RUN_WORKSPACE_SUBDIRS, workspace_root_for_run

    r = run_get(run_id)
    if not r:
        raise HTTPException(404, "run not found")
    root = workspace_root_for_run(run_id)
    if not root:
        from edagent_vivado.harness.run_workspace import ensure_run_workspace

        ws = ensure_run_workspace(run_id)
        root = ws.root
    subdirs = {name: str(root / name) for name in RUN_WORKSPACE_SUBDIRS}
    return {"run_id": run_id, "workspace_root": str(root), "subdirs": subdirs}


@router.get("/runs/{run_id}/tool-requests")
async def api_run_tool_requests(run_id: str):
    from edagent_vivado.repository.store import tool_run_request_list

    r = run_get(run_id)
    if not r:
        raise HTTPException(404, "run not found")
    return {"run_id": run_id, "requests": tool_run_request_list(run_id=run_id)}


@router.get("/runs")
async def api_runs_list(
    project_id: str = "",
    session_id: str = "",
    connector_id: str = "",
    status: str = "",
    limit: int = 50,
):
    rows = run_list(session_id=session_id, limit=limit)
    if status:
        rows = [r for r in rows if r.get("state") == status]
    return {"runs": rows, "count": len(rows)}


@router.post("/runs/{run_id}/stop")
async def api_run_stop(run_id: str):
    from edagent_vivado.runs.orchestrator import cancel_run

    if not cancel_run(run_id, reason="user requested via API"):
        raise HTTPException(400, "cannot cancel — run not active or already finished")
    return {"run_id": run_id, "state": "cancelled"}


@router.post("/runs/{run_id}/resume")
async def api_run_resume(run_id: str):
    from edagent_vivado.runs.orchestrator import resume_run

    try:
        result = resume_run(run_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"run_id": result.run_id, "state": result.state, "steps": result.final_step_states}


@router.post("/runs/{run_id}/rerun")
async def api_run_rerun(run_id: str, auto_start: bool = True):
    r = run_get(run_id)
    if not r:
        raise HTTPException(404, "run not found")

    from edagent_vivado.runs.flow_definitions import FLOW_REGISTRY
    from edagent_vivado.runs.orchestrator import create_run, start_run

    flow_name = str(r.get("run_type") or "")
    if flow_name in FLOW_REGISTRY:
        import json

        inputs: dict = {}
        try:
            meta = json.loads(r.get("metadata_json") or "{}")
            inputs = dict(meta.get("inputs") or {})
        except json.JSONDecodeError:
            pass
        session_id = str(r.get("session_id") or "")
        task_id = str(r.get("task_id") or "")
        new_id = create_run(
            flow_name=flow_name,
            session_id=session_id,
            task_id=task_id,
            inputs=inputs,
        )
        if not auto_start:
            return {"run_id": new_id, "state": "created", "parent_run_id": run_id}
        result = start_run(
            new_id,
            flow_name=flow_name,
            inputs=inputs,
            session_id=session_id,
            task_id=task_id,
            stages=inputs.get("stages") if isinstance(inputs.get("stages"), list) else None,
        )
        return {
            "run_id": new_id,
            "parent_run_id": run_id,
            "state": result.state,
            "steps": result.final_step_states,
        }

    session_id = r.get("session_id") or ""
    task_id = r.get("task_id") or ""
    question = ""
    if task_id:
        t = task_get(task_id)
        if t and t.get("message_id"):
            msgs = message_list(session_id, limit=50)
            for m in reversed(msgs):
                if m.get("id") == t.get("message_id"):
                    question = m.get("content") or ""
                    break
    if not question:
        for m in reversed(message_list(session_id, limit=30)):
            if m.get("role") == "user" and (m.get("content") or "").strip():
                question = m.get("content") or ""
                break
    if not session_id:
        raise HTTPException(400, "run has no session_id")

    active = task_active_for_session(session_id)
    if active:
        return {
            "run_id": run_id,
            "session_id": session_id,
            "status": "blocked",
            "active_task_id": active["id"],
            "suggested_question": question,
            "hint": "Stop the active task before rerunning.",
        }

    if not auto_start or not (question or "").strip():
        return {
            "run_id": run_id,
            "session_id": session_id,
            "status": "ready",
            "suggested_question": question,
            "hint": f"POST /api/v1/sessions/{session_id}/tasks with the same question",
        }

    from edagent_vivado.web.routes.tasks import api_task_start
    from edagent_vivado.web.schemas.tasks import StartTaskReq

    started = await api_task_start(
        session_id,
        StartTaskReq(
            question=question,
            metadata={"parent_run_id": run_id, "rerun": True},
        ),
    )
    if isinstance(started, JSONResponse) and started.status_code == 409:
        body = started.body
        return {
            "run_id": run_id,
            "session_id": session_id,
            "status": "blocked",
            "suggested_question": question,
            "detail": body.decode() if isinstance(body, bytes) else str(body),
        }
    return {
        "run_id": run_id,
        "session_id": session_id,
        "status": "started",
        "parent_run_id": run_id,
        "task": started if isinstance(started, dict) else {},
        "suggested_question": question,
    }


@router.get("/tasks/{task_id}/plan")
async def api_task_plan(task_id: str):
    t = task_get(task_id)
    if not t:
        raise HTTPException(404, "task not found")
    try:
        meta = json.loads(t.get("metadata_json") or "{}")
    except json.JSONDecodeError:
        meta = {}
    return {"task_id": task_id, "plan": meta.get("plan") or []}

