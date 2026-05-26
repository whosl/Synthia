#!/usr/bin/env python3
"""One-shot split of web/api_v1.py into routes/ + api_shared.py (Phase 1)."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "edagent_vivado" / "web"
SOURCE = SRC / "api_v1.py"

# (start, end) 1-based inclusive line ranges from api_v1.py
CHUNKS: list[tuple[int, int, str, list[str]]] = [
    (160, 367, "projects", []),
    (369, 397, "admin", []),
    (400, 497, "sessions", []),
    (501, 1288, "tasks", []),
    (1290, 1337, "streams", []),
    (1339, 1421, "connectors", []),
    (1423, 1456, "runs", []),
    (1458, 1499, "reports", []),
    (1501, 1540, "connectors_health", []),  # merged into connectors below
    (1543, 1637, "runs", []),  # append to runs
    (1639, 1837, "approvals", []),
    (1842, 1935, "monitor", []),
    (1937, 1968, "settings", []),
    (1972, 2021, "feedback", []),
    (2025, 2060, "metrics", []),
    (2064, 2609, "evolution", []),
    (2613, 2719, "kb", []),
    (2721, 2768, "interactions", []),
    (2772, 2819, "vivado", []),
    (2821, 2886, "knowledge", []),
    (2888, 3071, "vivado", []),
    (3115, 3255, "memory", []),
]

# Merge connectors_health into connectors file content
MERGE_INTO: dict[str, str] = {"connectors_health": "connectors"}

ROUTE_HEADER = '''"""API routes: {tag}."""

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

router = APIRouter(tags=["{tag}"])

'''

API_SHARED = '''"""Shared SSE state, event publishing, and cross-route helpers (Phase 1)."""

from __future__ import annotations

import asyncio
import json
import logging

from edagent_vivado.events.envelope import enrich_wire_event
from edagent_vivado.repository.store import event_create as _store_event_create

logger = logging.getLogger(__name__)

_stream_queues: dict[str, list[asyncio.Queue]] = {}


def _publish(session_id: str, event: dict) -> None:
    """Push event to all active SSE subscribers for a session."""
    wire = enrich_wire_event(event)
    payload = json.dumps(wire, ensure_ascii=False, default=str)
    data = f"id: {session_id}:{wire.get('seq',0)}\\nevent: {wire['event_type']}\\ndata: {payload}\\n\\n"
    for q in _stream_queues.get(session_id, []):
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            pass


# Tool runs rejected at Vivado approval gate (langgraph run_id -> outcome scope)
_blocked_tool_runs: dict[str, str] = {}
_early_blocked_tool_runs: set[str] = set()
_early_completed_toolcall_ids: set[str] = set()
_vivado_reject_run_keys: set[str] = set()


def _langgraph_tool_run_key(evt: dict) -> str:
    return str(evt.get("run_id") or (evt.get("data") or {}).get("run_id") or "")


def event_create(session_id: str, event_type: str, payload: dict, **kwargs) -> dict:  # type: ignore[no-redef]
    """Persist an event and publish it to live SSE subscribers."""
    evt = enrich_wire_event(_store_event_create(session_id, event_type, payload, **kwargs))
    _publish(session_id, evt)
    return evt


async def _flush_pending_file_batch(
    session_id: str,
    task_id: str,
    run: dict,
    t: dict,
) -> str | None:
    """If file ops were queued, create one approval interaction and wait. Returns tool output or None."""
    from edagent_vivado.harness.interaction import (
        InteractionType,
        create_interaction,
        take_file_batch,
        wait_for_response,
    )

    files, title, message = take_file_batch(session_id, task_id)
    if not files:
        return None
    from edagent_vivado.harness.approval_payload import (
        build_file_approval_payload,
        payload_to_reason_json,
    )

    payload = build_file_approval_payload(
        title,
        message,
        [{"path": f.path, "description": f.description, "action": f.action} for f in files],
    )
    interaction = create_interaction(
        InteractionType.APPROVAL,
        session_id,
        task_id,
        title=title,
        message="",
        reason=payload_to_reason_json(payload),
        files=files,
    )
    event_create(
        session_id,
        "interaction.requested",
        interaction.to_dict(),
        task_id=task_id,
        run_id=run["id"],
    )
    responded = await wait_for_response(interaction.id, task_id=task_id)
    if not responded:
        from edagent_vivado.repository.store import task_get

        stopped = task_get(task_id)
        if stopped and stopped.get("stop_requested"):
            from edagent_vivado.harness.approval_outcomes import SCOPE_FILE_CHANGES, format_user_rejection

            return format_user_rejection(SCOPE_FILE_CHANGES, detail="Task stopped by user.")
        return "TIMEOUT: No user response"
    if responded.interaction_type != InteractionType.APPROVAL:
        return json.dumps(responded.response, ensure_ascii=False)
    if responded.status.value != "approved":
        from edagent_vivado.harness.approval_outcomes import SCOPE_FILE_CHANGES, format_user_rejection

        return format_user_rejection(SCOPE_FILE_CHANGES)
    from edagent_vivado.harness.approval_apply import (
        apply_approved_files,
        format_approval_tool_output,
        resolve_project_root,
    )

    root = resolve_project_root(session_id=session_id)
    resp = responded.response if isinstance(responded.response, dict) else {}
    approved_indices = resp.get("approved_indices")
    if approved_indices is not None:
        applied, skipped = apply_approved_files(
            files,
            approved_indices=[int(i) for i in approved_indices],
            project_root=root,
        )
    else:
        approved_paths = resp.get("approved_files") or [fi.path for fi in files]
        applied, skipped = apply_approved_files(files, approved_paths, project_root=root)
    return format_approval_tool_output(applied, skipped, total_changes=len(files))


def _archive_task_canvas(task_id: str | None) -> None:
    if not task_id:
        return
    try:
        from edagent_vivado.memory.canvas import archive_active_canvas_for_task

        archive_active_canvas_for_task(task_id)
    except Exception:
        logger.exception("archive task canvas failed for %s", task_id)


def _ensure_project_persona(project_id: str | None) -> None:
    if not project_id:
        return
    try:
        from edagent_vivado.memory.personas import ensure_project_persona_for_session

        ensure_project_persona_for_session(project_id)
    except Exception:
        logger.exception("ensure project persona failed for %s", project_id)


def _memory_pipeline_on_message(session_id: str, *, role: str = "user") -> None:
    try:
        from edagent_vivado.memory.async_pipeline import schedule_memory_pipeline
        from edagent_vivado.repository.store import session_get

        sess = session_get(session_id)
        schedule_memory_pipeline(session_id, (sess or {}).get("project_id"), role=role)
    except Exception:
        logger.exception("memory pipeline failed for session %s", session_id)
'''

API_V1_AGGREGATOR = '''"""Phase 1 REST API — aggregates domain routers under /api/v1."""

from __future__ import annotations

from fastapi import APIRouter

from edagent_vivado.web.routes import (
    admin,
    approvals,
    connectors,
    evolution,
    feedback,
    interactions,
    kb,
    knowledge,
    memory,
    metrics,
    monitor,
    projects,
    reports,
    runs,
    sessions,
    settings,
    streams,
    tasks,
    vivado,
)

router = APIRouter(prefix="/api/v1")

for _mod in (
    projects,
    admin,
    sessions,
    tasks,
    streams,
    connectors,
    runs,
    reports,
    approvals,
    interactions,
    monitor,
    settings,
    feedback,
    metrics,
    evolution,
    kb,
    knowledge,
    vivado,
    memory,
):
    router.include_router(_mod.router)

# Backward-compatible re-exports (task_resume, workbuddy, tests)
from edagent_vivado.web.routes.approvals import api_approvals_list  # noqa: F401
from edagent_vivado.web.routes.reports import api_run_reports  # noqa: F401
from edagent_vivado.web.routes.tasks import StartTaskReq, api_task_start  # noqa: F401
from edagent_vivado.web.api_shared import (  # noqa: F401
    _blocked_tool_runs,
    _early_blocked_tool_runs,
    _early_completed_toolcall_ids,
    _publish,
    _stream_queues,
    _vivado_reject_run_keys,
    event_create,
)
'''


def main() -> None:
    lines = SOURCE.read_text(encoding="utf-8").splitlines(keepends=True)
    (SRC / "api_shared.py").write_text(API_SHARED, encoding="utf-8")

    merged: dict[str, list[str]] = {}
    for start, end, name, _extra in CHUNKS:
        target = MERGE_INTO.get(name, name)
        body = "".join(lines[start - 1 : end])
        body = body.replace("@router.", "@router.")
        merged.setdefault(target, []).append(body)

    routes_dir = SRC / "routes"
    routes_dir.mkdir(exist_ok=True)

    for name, bodies in sorted(merged.items()):
        content = ROUTE_HEADER.format(tag=name) + "\n".join(bodies)
        # runs.py: fix rerun import of api_task_start
        if name == "runs":
            content = content.replace(
                "    started = await api_task_start(",
                "    from edagent_vivado.web.routes.tasks import StartTaskReq, api_task_start\n\n"
                "    started = await api_task_start(",
            )
            # Remove duplicate StartTaskReq if already in runs chunk
            if content.count("class StartTaskReq") == 0 and "StartTaskReq" in content:
                pass
        path = routes_dir / f"{name}.py"
        path.write_text(content, encoding="utf-8")
        print(f"wrote {path} ({len(content)} bytes)")

    (SRC / "api_v1.py").write_text(API_V1_AGGREGATOR, encoding="utf-8")
    print("wrote api_v1.py aggregator")


if __name__ == "__main__":
    main()
