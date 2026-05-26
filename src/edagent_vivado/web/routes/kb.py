"""API routes: kb."""

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

router = APIRouter(tags=["kb"])

@router.get("/kb/cases")
async def api_kb_cases():
    import json

    from edagent_vivado.kb.error_case_loader import load_cases, load_effective_cases
    from edagent_vivado.repository.store import kb_case_list

    rows: list[dict] = []
    for i, c in enumerate(load_cases()):
        rows.append({
            "id": f"builtin-{i}",
            "pattern": c.pattern,
            "category": c.category,
            "likely_causes": c.likely_causes,
            "suggested_actions": c.suggested_actions,
            "source": "builtin",
        })
    builtin_patterns = {c.pattern for c in load_cases()}
    for row in kb_case_list(limit=500):
        try:
            likely = json.loads(row.get("likely_causes_json") or "[]")
        except json.JSONDecodeError:
            likely = []
        try:
            actions = json.loads(row.get("suggested_actions_json") or "[]")
        except json.JSONDecodeError:
            actions = []
        pat = row.get("pattern") or ""
        if pat in builtin_patterns:
            continue
        rows.append({
            "id": row["id"],
            "pattern": pat,
            "category": row.get("category") or "unknown",
            "likely_causes": likely,
            "suggested_actions": actions,
            "source": "db",
        })
    effective_count = len(load_effective_cases())
    return {"cases": rows, "effective_count": effective_count}

def _kb_candidate_row(row: dict) -> dict:
    likely = row.get("likely_causes_json")
    actions = row.get("suggested_actions_json")
    if isinstance(likely, str):
        try:
            likely = json.loads(likely)
        except json.JSONDecodeError:
            likely = []
    if isinstance(actions, str):
        try:
            actions = json.loads(actions)
        except json.JSONDecodeError:
            actions = []
    return {
        "id": row["id"],
        "source_problem_id": row.get("source_problem_id"),
        "source_run_id": row.get("source_run_id"),
        "source_session_id": row.get("source_session_id"),
        "pattern": row.get("pattern"),
        "category": row.get("category") or "unclassified",
        "title": (row.get("pattern") or "")[:120],
        "likely_causes": likely or [],
        "suggested_actions": actions or [],
        "confidence": row.get("confidence") or 0.5,
        "status": row.get("status") or "pending",
        "created_by": row.get("created_by") or "harness",
        "created_at": row.get("created_at"),
        "merged_into_case_id": row.get("merged_into_case_id"),
    }

@router.get("/kb/candidates")
async def api_kb_candidates(status: str = "pending", limit: int = 50):
    rows = kb_candidate_list(status=status, limit=limit)
    return {"candidates": [_kb_candidate_row(r) for r in rows]}

@router.get("/kb/candidates/{candidate_id}")
async def api_kb_candidate_get(candidate_id: str):
    row = kb_candidate_get(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {"candidate": _kb_candidate_row(row)}

@router.post("/kb/candidates/{candidate_id}/approve")
async def api_kb_candidate_approve(candidate_id: str):
    row = kb_candidate_approve(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {
        "ok": True,
        "candidate": _kb_candidate_row(row),
        "merged_into_case_id": row.get("merged_into_case_id"),
    }

@router.post("/kb/candidates/{candidate_id}/reject")
async def api_kb_candidate_reject(candidate_id: str):
    row = kb_candidate_reject(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {"ok": True, "candidate": _kb_candidate_row(row)}

@router.post("/kb/candidates/{candidate_id}/merge")
async def api_kb_candidate_merge(candidate_id: str):
    row = kb_candidate_merge(candidate_id)
    if not row:
        raise HTTPException(404, "candidate not found")
    return {"ok": True, "candidate": _kb_candidate_row(row), "merged_into_case_id": row.get("merged_into_case_id")}
