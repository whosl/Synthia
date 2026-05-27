"""API routes: monitor."""

from __future__ import annotations

import asyncio
import json
import os as _os
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
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
from edagent_vivado.auth.audit import log_audit
from edagent_vivado.auth.permissions import check_permission
from edagent_vivado.tools.patch_tools import is_patch_approved, set_patch_approval
from edagent_vivado.web.dependencies import get_identity
from edagent_vivado.web.schemas.monitor import MonitorCleanupBody
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

router = APIRouter(tags=["monitor"])

@router.get("/monitor/runs")
async def api_monitor_runs(session_id: str = "", limit: int = 50):
    return {"runs": run_list(session_id=session_id, limit=limit)}

@router.get("/monitor/runs/{run_id}")
async def api_monitor_run(run_id: str):
    r = run_get(run_id)
    if not r: raise HTTPException(404)
    return {"run": r, "toolcalls": toolcall_list(run_id=run_id), "usage": usage_list(run_id=run_id)}

@router.get("/monitor/runs/{run_id}/toolcalls")
async def api_monitor_toolcalls(run_id: str):
    return {"toolcalls": toolcall_list(run_id=run_id)}

@router.get("/monitor/runs/{run_id}/usage")
async def api_monitor_usage(run_id: str):
    return {"usage": usage_list(run_id=run_id)}

@router.get("/monitor/runs/{run_id}/events")
async def api_monitor_events(run_id: str, limit: int = 500):
    return {"events": event_list_for_run(run_id, limit=limit)}

@router.get("/monitor/runs/{run_id}/artifacts")
async def api_monitor_artifacts(run_id: str, limit: int = 100):
    return {"artifacts": artifact_list(run_id=run_id, limit=limit)}


@router.get("/artifacts/{artifact_id}/download")
async def api_artifact_download(artifact_id: str, request: Request, identity=Depends(get_identity)):
    from edagent_vivado.repository.store import artifact_get
    from fastapi.responses import FileResponse

    art = artifact_get(artifact_id)
    if not art:
        raise HTTPException(404, "artifact not found")
    proj_id = str(art.get("project_id") or "")
    role = identity.role_for_project(proj_id)
    name = str(art.get("path") or "").lower()
    is_bitstream = name.endswith((".bit", ".ltx", ".bin"))
    perm = "artifact.download.bitstream" if is_bitstream else "artifact.read"
    if not check_permission(role, perm):
        log_audit(
            actor_user_id=identity.user.id,
            action="artifact.download.denied",
            resource_type="artifact",
            resource_id=artifact_id,
            project_id=proj_id,
            details={"perm": perm, "role": role, "path": name},
            success=False,
        )
        raise HTTPException(403, f"forbidden: requires {perm}")
    path = Path(str(art.get("path") or ""))
    if not path.is_file():
        raise HTTPException(404, "artifact file missing on disk")
    log_audit(
        actor_user_id=identity.user.id,
        action="artifact.download",
        resource_type="artifact",
        resource_id=artifact_id,
        project_id=proj_id,
        details={"path": name, "is_bitstream": is_bitstream},
    )
    headers: dict[str, str] = {}
    if art.get("sha256"):
        headers["X-Artifact-SHA256"] = str(art["sha256"])
    return FileResponse(
        path,
        media_type=art.get("mime_type") or "application/octet-stream",
        filename=path.name,
        headers=headers,
    )

@router.get("/monitor/runs/{run_id}/problems")
async def api_monitor_problems(run_id: str, limit: int = 100):
    return {"problems": problem_list(run_id=run_id, limit=limit)}

@router.get("/monitor/runs/{run_id}/context")
async def api_monitor_context(run_id: str):
    packages = context_packages_for_run(run_id)
    audits = retrieval_audits_for_run(run_id)
    enriched = []
    for pkg in packages:
        enriched.append({"package": pkg, "items": context_package_items(pkg["id"])})
    enriched_audits = []
    for audit in audits:
        enriched_audits.append({"audit": audit, "items": retrieval_audit_items(audit["id"])})
    return {"contexts": enriched, "retrieval_audits": enriched_audits}

@router.get("/monitor/sessions/{session_id}/runs")
async def api_monitor_session_runs(session_id: str, limit: int = 50):
    return {"runs": run_list(session_id=session_id, limit=limit)}

@router.get("/monitor/sessions/{session_id}/usage")
async def api_monitor_session_usage(session_id: str):
    return usage_totals_for_session(session_id)

@router.get("/monitor/overview")
async def api_monitor_overview(days: int = Query(14, ge=1, le=90)):
    return monitor_overview(days=days)

@router.post("/monitor/cleanup")
async def api_monitor_cleanup(body: MonitorCleanupBody):
    return monitor_retention_cleanup(
        retention_days=body.retention_days,
        dry_run=body.dry_run,
    )

@router.get("/sessions/{session_id}/memory")
async def api_session_memory(session_id: str, limit: int = 20):
    return {"latest": memory_latest(session_id), "snapshots": memory_list(session_id, limit=limit)}

@router.get("/sessions/{session_id}/context")
async def api_session_context(session_id: str, task_id: str = ""):
    """Latest context packages and retrieval audits for Terminal debug / Monitor."""
    tid = task_id.strip()
    if not tid:
        active = task_active_for_session(session_id)
        if active:
            tid = active.get("id") or ""
    packages = context_packages_for_session(session_id, task_id=tid, limit=3)
    audits = retrieval_audits_for_session(session_id, task_id=tid, limit=3)
    enriched = [{"package": p, "items": context_package_items(p["id"])} for p in packages]
    enriched_audits = [{"audit": a, "items": retrieval_audit_items(a["id"])} for a in audits]
    return {"contexts": enriched, "retrieval_audits": enriched_audits, "task_id": tid or None}

@router.get("/context-packages/{context_package_id}")
async def api_context_package(context_package_id: str):
    pkg = context_package_get(context_package_id)
    if not pkg: raise HTTPException(404)
    return {"package": pkg, "items": context_package_items(context_package_id)}

@router.get("/retrieval-audits/{audit_id}")
async def api_retrieval_audit(audit_id: str):
    audit = retrieval_audit_get(audit_id)
    if not audit: raise HTTPException(404)
    return {"audit": audit, "items": retrieval_audit_items(audit_id)}
