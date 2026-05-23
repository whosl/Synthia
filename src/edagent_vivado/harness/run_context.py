"""Per-agent-run context for tools (task id, session id)."""

from __future__ import annotations

import contextvars

_agent_task_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("agent_task_id", default=None)
_agent_session_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("agent_session_id", default=None)


def set_agent_run_context(session_id: str, task_id: str) -> None:
    _agent_session_id.set(session_id)
    _agent_task_id.set(task_id)


def get_agent_task_id() -> str | None:
    return _agent_task_id.get()


def get_agent_session_id() -> str | None:
    return _agent_session_id.get()
