"""Finalize UI/DB state when the user stops a running task."""

from __future__ import annotations

import time
from typing import Any, Callable

from edagent_vivado.repository.store import (
    session_update,
    task_get,
    task_update,
    toolcall_update,
)
from edagent_vivado.repository.db import get_db

EventCreate = Callable[..., Any]


def cancel_running_toolcalls_for_task(
    task_id: str,
    session_id: str,
    event_create: EventCreate,
) -> int:
    """Mark in-flight tool calls as stopped and emit tool.completed for the timeline."""
    rows = get_db().execute(
        "SELECT * FROM tool_calls WHERE task_id=? AND state='started' ORDER BY started_at ASC",
        (task_id,),
    ).fetchall()
    n = 0
    finished_at = int(time.time())
    output = "Task stopped by user"
    for row in rows:
        tcid = row["id"]
        started_at = int(row["started_at"] or finished_at)
        elapsed_ms = max(0, (finished_at - started_at) * 1000)
        toolcall_update(
            tcid,
            state="stopped",
            finished_at=finished_at,
            elapsed_ms=elapsed_ms,
            output_summary=output,
        )
        event_create(
            session_id,
            "tool.completed",
            {
                "tool_name": row["tool_name"],
                "toolcall_id": tcid,
                "result": output,
                "state": "stopped",
                "started_at": started_at,
                "elapsed_ms": elapsed_ms,
            },
            task_id=task_id,
            run_id=row["run_id"] or None,
        )
        n += 1
    return n


def finalize_task_stop(
    task_id: str,
    session_id: str,
    event_create: EventCreate,
    *,
    emit_stopped_event: bool = True,
) -> dict[str, Any]:
    """After cancel_task_execution: close open tools and move task stopping → stopped."""
    tools = cancel_running_toolcalls_for_task(task_id, session_id, event_create)
    row = task_get(task_id) or {}
    if row.get("stop_requested") or row.get("state") == "stopping":
        task_update(task_id, state="stopped", finished_at=int(time.time()))
        session_update(session_id, status="idle")
        if emit_stopped_event:
            event_create(
                session_id,
                "task.stopped",
                {"task_id": task_id, "tools_finalized": tools},
                task_id=task_id,
            )
    return {"tools_finalized": tools, "state": "stopped"}
