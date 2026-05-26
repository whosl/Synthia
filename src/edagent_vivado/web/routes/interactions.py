"""API routes: interactions."""

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

router = APIRouter(tags=["interactions"])

# ── Interaction API (Human-in-the-loop) ────────────────────

@router.get("/sessions/{session_id}/interactions")
async def api_interactions(session_id: str):
    from edagent_vivado.harness.interaction import get_pending_for_session, rehydrate_session_interactions
    rehydrate_session_interactions(session_id)
    pending = get_pending_for_session(session_id)
    return {"interactions": [i.to_dict() for i in pending]}

@router.get("/interactions/{interaction_id}")
async def api_interaction_detail(interaction_id: str):
    from edagent_vivado.harness.interaction import get_interaction
    interaction = get_interaction(interaction_id)  # rehydrates from events if needed
    if not interaction:
        raise HTTPException(404, "Interaction not found")
    return interaction.to_dict()

@router.post("/interactions/{interaction_id}/respond")
async def api_interaction_respond(interaction_id: str, request: Request):
    from edagent_vivado.harness.interaction import get_interaction, respond_interaction, sync_interaction_resolution_from_store
    body = await request.json()
    interaction = get_interaction(interaction_id)
    if not interaction:
        raise HTTPException(404, "Interaction not found")
    result = respond_interaction(interaction_id, body, session_id=interaction.session_id)
    if not result:
        raise HTTPException(500, "Failed to process response")
    sync_interaction_resolution_from_store(interaction_id)
    try:
        from edagent_vivado.harness.approval_bridge import sync_approval_on_interaction_resolved

        sync_approval_on_interaction_resolved(result)
    except Exception:
        pass
    # Emit event
    event_type = "interaction.approved" if result.status.value == "approved" else (
        "interaction.rejected" if result.status.value == "rejected" else "interaction.responded"
    )
    event_create(interaction.session_id, event_type, {
        **result.to_dict(),
        "interaction_id": interaction_id,
        "response": body,
    }, task_id=interaction.task_id)
    import asyncio
    from edagent_vivado.harness.task_resume import maybe_schedule_orphan_recovery

    asyncio.create_task(maybe_schedule_orphan_recovery(interaction.task_id))
    return {"ok": True, "interaction": result.to_dict()}
