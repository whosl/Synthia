"""Non-blocking memory pipeline scheduling."""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)


def _run_memory_pipeline(session_id: str, project_id: str | None, *, role: str) -> None:
    from edagent_vivado.memory.pipeline import on_message

    on_message(session_id, project_id, role=role)


def schedule_memory_pipeline(
    session_id: str,
    project_id: str | None = None,
    *,
    role: str = "user",
) -> None:
    """Run L1/L2/L3 pipeline off the request hot path when inside asyncio."""
    if not session_id:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        _run_memory_pipeline(session_id, project_id, role=role)
        return

    async def _task() -> None:
        try:
            await asyncio.to_thread(_run_memory_pipeline, session_id, project_id, role=role)
        except Exception:  # pragma: no cover
            logger.exception("memory pipeline failed for session %s", session_id)

    loop.create_task(_task())
