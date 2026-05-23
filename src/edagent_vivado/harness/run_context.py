"""Per-agent-run context for tools (task id, session id)."""

from __future__ import annotations

import contextvars
import threading

_agent_task_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("agent_task_id", default=None)
_agent_session_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("agent_session_id", default=None)
_agent_run_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("agent_run_id", default=None)
# LangGraph may invoke sync tools on a worker thread without contextvar propagation.
_tool_thread = threading.local()
_session_task_fallback: dict[str, str] = {}


def set_agent_run_context(session_id: str, task_id: str, run_id: str = "") -> None:
    _agent_session_id.set(session_id)
    _agent_task_id.set(task_id)
    _agent_run_id.set(run_id or None)
    _session_task_fallback[session_id] = task_id


def set_tool_thread_context(session_id: str, task_id: str, run_id: str = "") -> None:
    """Called from on_tool_start so sync tools see the active task on worker threads."""
    _tool_thread.session_id = session_id
    _tool_thread.task_id = task_id
    _tool_thread.run_id = run_id or ""


def clear_tool_thread_context() -> None:
    for attr in ("session_id", "task_id", "run_id"):
        if hasattr(_tool_thread, attr):
            delattr(_tool_thread, attr)


def get_agent_run_context() -> dict[str, str]:
    return {
        "session_id": _agent_session_id.get() or "",
        "task_id": _agent_task_id.get() or "",
        "run_id": _agent_run_id.get() or "",
    }


def get_agent_task_id() -> str | None:
    tid = _agent_task_id.get()
    if tid:
        return tid
    tid = getattr(_tool_thread, "task_id", None)
    if tid:
        return str(tid)
    sid = _agent_session_id.get() or getattr(_tool_thread, "session_id", None)
    if sid:
        return _session_task_fallback.get(str(sid))
    return None


def get_agent_session_id() -> str | None:
    return _agent_session_id.get()
