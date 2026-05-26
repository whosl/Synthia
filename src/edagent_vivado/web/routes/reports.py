"""API routes: reports."""

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

router = APIRouter(tags=["reports"])

@router.get("/reports/trends")
async def api_reports_trends(
    report_type: str = "timing_summary",
    session_id: str = "",
    metric: str = "wns",
    limit: int = 20,
):
    points = parsed_report_trends(
        report_type,
        session_id=session_id,
        metric=metric,
        limit=limit,
    )
    return {
        "report_type": report_type,
        "metric": metric,
        "session_id": session_id or None,
        "points": points,
    }


@router.get("/runs/{run_id}/reports")
async def api_run_reports(run_id: str, report_type: str = ""):
    r = run_get(run_id)
    if not r:
        raise HTTPException(404, "run not found")
    rows = parsed_report_list(run_id=run_id, report_type=report_type or "")
    return {"run_id": run_id, "reports": rows}


@router.get("/runs/{run_id}/reports/{report_id}")
async def api_run_report_detail(run_id: str, report_id: str):
    from edagent_vivado.repository.store import parsed_report_get

    r = run_get(run_id)
    if not r:
        raise HTTPException(404, "run not found")
    row = parsed_report_get(report_id)
    if not row or row.get("run_id") != run_id:
        raise HTTPException(404, "report not found")
    return {"run_id": run_id, "report": row}


@router.get("/projects/{project_id}/trend")
async def api_project_trend(project_id: str, limit: int = Query(10, ge=1, le=50)):
    from edagent_vivado.runs.trend import project_trend

    if not project_get(project_id):
        raise HTTPException(404, "project not found")
    return project_trend(project_id, limit=limit)


@router.get("/runs/{run_id}/summary.md")
async def api_run_summary_md(run_id: str):
    from fastapi.responses import PlainTextResponse

    from edagent_vivado.runs.summary import render_run_summary

    if not run_get(run_id):
        raise HTTPException(404, "run not found")
    return PlainTextResponse(
        render_run_summary(run_id),
        media_type="text/markdown; charset=utf-8",
    )


@router.get("/runs/{run_id}/artifacts/zip")
async def api_run_artifacts_zip(run_id: str):
    import io
    import zipfile

    from fastapi.responses import StreamingResponse

    if not run_get(run_id):
        raise HTTPException(404, "run not found")
    artifacts = artifact_list(run_id=run_id, limit=500)
    if not artifacts:
        raise HTTPException(404, "no artifacts for this run")

    buf = io.BytesIO()
    seen: dict[str, int] = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for art in artifacts:
            raw_path = art.get("path")
            if not raw_path:
                continue
            p = Path(str(raw_path))
            if not p.is_file():
                continue
            arcname = p.name
            count = seen.get(arcname, 0)
            if count:
                stem, ext = p.stem, p.suffix
                arcname = f"{stem}_{count}{ext}"
            seen[arcname] = count + 1
            try:
                zf.write(p, arcname=arcname)
            except OSError:
                continue
    buf.seek(0)
    headers = {
        "Content-Disposition": f'attachment; filename="run_{run_id}_artifacts.zip"',
        "Cache-Control": "no-store",
    }
    return StreamingResponse(buf, media_type="application/zip", headers=headers)

