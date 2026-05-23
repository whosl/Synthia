"""Per-agent-run context for tools (task id, session id)."""

from __future__ import annotations

import contextvars

_agent_task_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("agent_task_id", default=None)
_agent_session_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("agent_session_id", default=None)
_agent_run_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("agent_run_id", default=None)


def set_agent_run_context(session_id: str, task_id: str, run_id: str = "") -> None:
    _agent_session_id.set(session_id)
    _agent_task_id.set(task_id)
    _agent_run_id.set(run_id or None)


def get_agent_run_context() -> dict[str, str]:
    return {
        "session_id": _agent_session_id.get() or "",
        "task_id": _agent_task_id.get() or "",
        "run_id": _agent_run_id.get() or "",
    }


def get_agent_task_id() -> str | None:
    return _agent_task_id.get()


def get_agent_session_id() -> str | None:
    return _agent_session_id.get()
