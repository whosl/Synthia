"""Memory hooks — tool-call completion → canvas + output artifacts."""

from __future__ import annotations

import hashlib
import logging

from edagent_vivado.repository.db import get_db
from edagent_vivado.repository.store import artifact_create

logger = logging.getLogger(__name__)

_TERMINAL_TOOL_STATES = frozenset({"completed", "error", "rejected", "stopped", "failed"})


def _attach_output_artifact(row: dict) -> None:
    if row.get("output_artifact_id"):
        return
    output = str(row.get("output_summary") or "").strip()
    if not output:
        return
    rel = f"tool_outputs/{row['id']}.txt"
    body = output.encode("utf-8")
    art = artifact_create(
        "tool_output",
        rel,
        session_id=str(row.get("session_id") or ""),
        task_id=str(row.get("task_id") or ""),
        run_id=str(row.get("run_id") or ""),
        mime_type="text/plain",
        size_bytes=len(body),
        sha256=hashlib.sha256(body).hexdigest(),
        summary=output[:240],
        metadata={"toolcall_id": row.get("id"), "tool_name": row.get("tool_name")},
    )
    get_db().execute(
        "UPDATE tool_calls SET output_artifact_id=? WHERE id=?",
        (art["id"], row["id"]),
    )
    get_db().commit()
    row["output_artifact_id"] = art["id"]


def on_toolcall_updated(row: dict | None, *, previous_state: str | None = None) -> None:
    """Universal hook after tool_calls row update (canvas + artifact)."""
    if not row:
        return
    state = str(row.get("state") or "")
    if state not in _TERMINAL_TOOL_STATES:
        return
    if previous_state == state:
        return

    task_id = str(row.get("task_id") or "")
    session_id = str(row.get("session_id") or "")
    if not task_id or not session_id:
        return

    try:
        _attach_output_artifact(row)
    except Exception:  # pragma: no cover
        logger.debug("tool output artifact attach failed", exc_info=True)

    try:
        from edagent_vivado.memory.canvas import update_task_canvas

        update_task_canvas(
            task_id,
            session_id,
            event="tool_call_completed",
            payload={
                "toolcall_id": row.get("id"),
                "tool_name": row.get("tool_name"),
                "state": state,
                "output": row.get("output_summary") or "",
            },
        )
    except Exception:  # pragma: no cover
        logger.debug("canvas hook failed for toolcall %s", row.get("id"), exc_info=True)
