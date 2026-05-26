"""Shared SSE state, event publishing, and cross-route helpers (Phase 1)."""

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
    data = f"id: {session_id}:{wire.get('seq',0)}\nevent: {wire['event_type']}\ndata: {payload}\n\n"
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
