"""API routes: streams."""

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

router = APIRouter(tags=["streams"])

# ── Event / Stream API ───────────────────────────────────────

@router.get("/events/protocol")
async def api_events_protocol():
    """Wire protocol catalog for SSE subscribers and timeline handlers."""
    return {
        "protocol_version": PROTOCOL_VERSION,
        "wire_event_types": list(ALL_WIRE_EVENT_TYPES),
    }


@router.get("/sessions/{session_id}/events")
async def api_events(session_id: str, after_seq: int = 0, limit: int = 500, recent: bool = False):
    from edagent_vivado.repository.store import event_list_recent
    if recent:
        rows = event_list_recent(session_id, limit=limit)
    else:
        rows = event_list(session_id, after_seq=after_seq, limit=limit)
    return {"events": [enrich_wire_event(e) for e in rows]}

@router.get("/sessions/{session_id}/stream")
async def api_stream(session_id: str, after_seq: int = 0):
    # Replay missed events first
    missed = event_list(session_id, after_seq=after_seq, limit=200)
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    _stream_queues.setdefault(session_id, []).append(queue)

    async def _stream():
        try:
            # Send missed events
            for evt in missed:
                wire = enrich_wire_event(evt)
                p = json.dumps(wire, ensure_ascii=False, default=str)
                yield f"id: {session_id}:{wire['seq']}\nevent: {wire['event_type']}\ndata: {p}\n\n"
            # Stream live events
            while True:
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=30.0)
                    yield data
                except asyncio.TimeoutError:
                    yield f": heartbeat\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            _stream_queues.get(session_id, []).remove(queue) if queue in _stream_queues.get(session_id, []) else None

    return StreamingResponse(_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})
