"""Recover agent tasks orphaned after approval (lost in-memory waiters / server restart)."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

_RESUME_SCHEDULED: set[str] = set()


def build_follow_up_from_approval_event(session_id: str, task_id: str) -> str | None:
    """Reconstruct post-approval tool output from the latest interaction.approved event."""
    from edagent_vivado.harness.approval_apply import (
        apply_approved_files,
        format_approval_tool_output,
        resolve_project_root,
    )
    from edagent_vivado.harness.approval_outcomes import SCOPE_FILE_CHANGES, format_user_rejection
    from edagent_vivado.harness.interaction import FileItem
    from edagent_vivado.repository.store import event_list

    events = event_list(session_id, after_seq=0, limit=5000)
    approved_payload: dict[str, Any] | None = None
    for row in reversed(events):
        if row.get("task_id") != task_id:
            continue
        if row.get("event_type") != "interaction.approved":
            continue
        raw = row.get("payload_json") or "{}"
        try:
            payload = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            approved_payload = payload
            break

    if not approved_payload:
        return None

    resp = approved_payload.get("response") if isinstance(approved_payload.get("response"), dict) else {}
    if not resp.get("approved", True):
        return format_user_rejection(SCOPE_FILE_CHANGES)

    files = [
        FileItem(
            path=str(f.get("path") or ""),
            content=str(f.get("content") or ""),
            description=str(f.get("description") or ""),
            action=str(f.get("action") or "create"),
        )
        for f in (approved_payload.get("files") or [])
    ]
    if not files:
        return format_user_rejection(SCOPE_FILE_CHANGES, detail="Approval had no file payloads.")

    root = resolve_project_root(session_id=session_id)
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


async def _post_start_task(session_id: str, question: str, metadata: dict[str, Any]) -> dict:
    from edagent_vivado.web.api_v1 import StartTaskReq, api_task_start

    result = await api_task_start(session_id, StartTaskReq(question=question, metadata=metadata))
    if hasattr(result, "body"):
        raise RuntimeError(f"failed to start continuation task: {getattr(result, 'status_code', '?')}")
    return result


def is_task_orphaned_after_approval(session_id: str, task_id: str) -> bool:
    """True when task is still running but last progress event is interaction.approved."""
    from edagent_vivado.repository.store import task_get, event_list

    task = task_get(task_id)
    if not task or task.get("state") not in ("running", "stopping"):
        return False

    events = [e for e in event_list(session_id, after_seq=0, limit=5000) if e.get("task_id") == task_id]
    if not events:
        return False

    tail = events[-1]
    if tail.get("event_type") != "interaction.approved":
        return False

    # If agent already continued or task finished, not orphaned.
    for row in reversed(events):
        et = row.get("event_type") or ""
        if et in ("agent.continuation", "task.done", "task.error", "task.stopped", "run.completed"):
            return False
        if et == "interaction.approved":
            break
    return True


def finalize_orphaned_task(task_id: str, session_id: str) -> dict | None:
    """Mark a stuck task/run complete so a continuation task can start."""
    from edagent_vivado.memory.canvas import archive_active_canvas_for_task
    from edagent_vivado.repository.store import (
        event_create,
        run_list,
        run_update,
        session_update,
        task_get,
        task_update,
    )

    task = task_get(task_id)
    if not task:
        return None

    now = int(time.time())
    runs = [r for r in run_list(session_id=session_id, limit=20) if r.get("task_id") == task_id]
    active_run = next((r for r in runs if r.get("state") == "started"), runs[0] if runs else None)
    if active_run:
        run_update(
            active_run["id"],
            state="done",
            finished_at=now,
            elapsed_ms=int((now - int(active_run.get("started_at") or now)) * 1000),
        )

    task_update(task_id, state="done", finished_at=now, error="")
    archive_active_canvas_for_task(task_id)
    session_update(session_id, status="idle")
    event_create(
        session_id,
        "task.recovered",
        {"task_id": task_id, "reason": "orphaned_after_approval"},
        task_id=task_id,
        run_id=active_run["id"] if active_run else "",
    )
    return task_get(task_id)


async def recover_orphaned_approval_task(task_id: str) -> bool:
    """Finalize stuck task and spawn a continuation task with approval outcome."""
    from edagent_vivado.harness.approval_outcomes import continuation_prompt
    from edagent_vivado.repository.store import task_get

    task = task_get(task_id)
    if not task:
        return False
    session_id = str(task.get("session_id") or "")
    if not session_id or not is_task_orphaned_after_approval(session_id, task_id):
        return False

    follow_up = build_follow_up_from_approval_event(session_id, task_id)
    if not follow_up:
        return False

    finalize_orphaned_task(task_id, session_id)

    question = continuation_prompt(follow_up)
    await _post_start_task(
        session_id,
        question,
        {"recovery_from_task_id": task_id, "recovery_reason": "orphaned_after_approval"},
    )
    logger.info("Recovered orphaned task %s in session %s", task_id, session_id)
    return True


async def maybe_schedule_orphan_recovery(task_id: str, *, delay_sec: float = 2.5) -> None:
    """After user responds, recover if the in-process waiter did not continue."""
    if not task_id or task_id in _RESUME_SCHEDULED:
        return
    _RESUME_SCHEDULED.add(task_id)

    async def _run() -> None:
        try:
            await asyncio.sleep(delay_sec)
            await recover_orphaned_approval_task(task_id)
        finally:
            _RESUME_SCHEDULED.discard(task_id)

    asyncio.create_task(_run())


async def recover_all_orphaned_tasks() -> list[str]:
    """Startup scan — resume tasks stuck after approval."""
    from edagent_vivado.repository.db import get_db

    rows = get_db().execute(
        "SELECT id, session_id FROM tasks WHERE state='running' ORDER BY started_at ASC"
    ).fetchall()
    recovered: list[str] = []
    for row in rows:
        task_id = str(row["id"])
        session_id = str(row["session_id"])
        if is_task_orphaned_after_approval(session_id, task_id):
            if await recover_orphaned_approval_task(task_id):
                recovered.append(task_id)
    return recovered
