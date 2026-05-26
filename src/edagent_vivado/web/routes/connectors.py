"""API routes: connectors."""

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

router = APIRouter(tags=["connectors"])

# ── Connectors API (Phase 6A) ────────────────────────────────

@router.get("/connectors")
async def api_connectors_list():
    from edagent_vivado.connectors import ensure_connectors
    from edagent_vivado.connectors.base.registry import list_connectors as registry_list

    ensure_connectors()
    db_rows = {r["connector_id"]: r for r in connector_list()}
    items = []
    for conn in registry_list():
        db_row = db_rows.get(conn.connector_id, {})
        items.append({
            "connector_id": conn.connector_id,
            "tool_name": conn.tool_name,
            "supported_versions": list(conn.supported_versions),
            "status": db_row.get("status") or "registered",
            "version": db_row.get("version"),
            "capabilities_count": len(conn.list_capabilities()),
        })
    for row in db_rows.values():
        if row["connector_id"] not in {i["connector_id"] for i in items}:
            items.append({
                "connector_id": row["connector_id"],
                "tool_name": row["tool_name"],
                "supported_versions": json.loads(row.get("supported_versions_json") or "[]"),
                "status": row.get("status"),
                "version": row.get("version"),
                "capabilities_count": len(capability_list(row["connector_id"])),
            })
    return {"connectors": items}


@router.get("/connectors/{connector_id}")
async def api_connector_get(connector_id: str):
    from edagent_vivado.connectors.base.registry import get_connector

    row = connector_get(connector_id)
    conn = get_connector(connector_id)
    if not row and not conn:
        raise HTTPException(404, "connector not found")
    env = conn.detect_environment() if conn else None
    return {
        "connector": row or {"connector_id": connector_id},
        "environment": {
            "reachable": env.reachable,
            "version": env.version,
            "target_type": env.target_type,
            "target_id": env.target_id,
        } if env else None,
    }


@router.get("/connectors/{connector_id}/capabilities")
async def api_connector_capabilities(connector_id: str):
    from edagent_vivado.connectors.base.registry import get_connector

    conn = get_connector(connector_id)
    caps = []
    if conn:
        for c in conn.list_capabilities():
            caps.append({
                "capability_id": c.capability_id,
                "display_name": c.display_name,
                "stage": c.stage,
                "risk_level": c.risk_level,
                "requires_approval": c.requires_approval,
                "outputs": c.outputs,
            })
    else:
        for row in capability_list(connector_id):
            caps.append({
                "capability_id": row["capability_id"],
                "display_name": row.get("display_name"),
                "stage": row.get("stage"),
                "risk_level": row.get("risk_level"),
                "requires_approval": bool(row.get("requires_approval")),
                "outputs": json.loads(row.get("outputs_json") or "[]"),
            })
    if not caps and not connector_get(connector_id):
        raise HTTPException(404, "connector not found")
    return {"connector_id": connector_id, "capabilities": caps}


@router.post("/connectors/{connector_id}/health-check")
async def api_connector_health_check(connector_id: str, session_id: str = ""):
    from edagent_vivado.connectors import ensure_connectors
    from edagent_vivado.connectors.base.registry import get_connector
    from edagent_vivado.repository.store import connector_upsert

    ensure_connectors()
    conn = get_connector(connector_id)
    if not conn:
        raise HTTPException(404, "connector not found")
    env = conn.detect_environment()
    health = {
        "reachable": env.reachable,
        "version": env.version,
        "target_type": env.target_type,
        "target_id": env.target_id,
    }
    try:
        connector_upsert(
            connector_id,
            conn.tool_name,
            version=env.version,
            status="ready" if env.reachable else "degraded",
            last_health=health,
        )
    except Exception:
        pass
    if session_id:
        event_create(
            session_id,
            "connector.health.checked",
            {"connector_id": connector_id, **health},
        )
    return {
        "connector_id": connector_id,
        "reachable": env.reachable,
        "version": env.version,
        "target_type": env.target_type,
        "environment": health,
    }
