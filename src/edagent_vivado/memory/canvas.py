"""Task canvas — Mermaid graph updated on each tool call completion."""

from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from edagent_vivado.memory.refs import write_ref
from edagent_vivado.repository.project_scope import project_id_for_session
from edagent_vivado.repository.db import get_db
from edagent_vivado.repository.store import (
    artifact_create,
    artifact_get,
    canvas_create,
    canvas_get_active_for_task,
    canvas_list_for_session,
    canvas_node_ref_create,
    canvas_node_ref_list,
    canvas_update,
)


def _runtime_root() -> Path:
    return Path(os.environ.get("EDAGENT_RUNTIME_DIR", ".edagent"))


def _project_id(session_id: str) -> str:
    pid = project_id_for_session(get_db(), session_id)
    return pid or "_default"


def _canvas_artifact_rel(project_id: str, task_id: str, version: int) -> str:
    return f"projects/{project_id}/memory/canvases/task_{task_id}_v{version}.mmd"


def _node_id_from_toolcall(toolcall_id: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9]", "", toolcall_id or "")
    if len(clean) >= 8:
        return clean[:8].lower()
    return (clean or "00000000").ljust(8, "0")[:8]


def _status_icon(state: str) -> str:
    if state in ("completed", "done", "success"):
        return "✓"
    if state in ("error", "rejected", "failed"):
        return "✗"
    return "?"


def _escape_mermaid_label(text: str) -> str:
    return text.replace('"', "'").replace("\n", " ").strip()


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _read_artifact_text(artifact_id: str) -> str:
    art = artifact_get(artifact_id)
    if not art:
        return "graph TD\n"
    path = Path(art["path"])
    if not path.is_absolute():
        path = _runtime_root() / path
    if path.is_file():
        return path.read_text(encoding="utf-8")
    return "graph TD\n"


def _write_mermaid_artifact(
    *,
    project_id: str,
    task_id: str,
    session_id: str,
    version: int,
    mermaid_text: str,
    existing_artifact_id: str | None = None,
) -> dict:
    rel = _canvas_artifact_rel(project_id, task_id, version)
    abs_path = _runtime_root() / rel
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_text(mermaid_text, encoding="utf-8")
    sha = hashlib.sha256(mermaid_text.encode("utf-8")).hexdigest()
    size = len(mermaid_text.encode("utf-8"))
    if existing_artifact_id:
        from edagent_vivado.repository.store import artifact_get as _get

        row = _get(existing_artifact_id)
        if row:
            get_db().execute(
                "UPDATE artifacts SET path=?, size_bytes=?, sha256=?, summary=? WHERE id=?",
                (rel, size, sha, f"task canvas v{version}", existing_artifact_id),
            )
            get_db().commit()
            return dict(get_db().execute("SELECT * FROM artifacts WHERE id=?", (existing_artifact_id,)).fetchone())
    return artifact_create(
        "task_canvas",
        rel,
        session_id=session_id,
        task_id=task_id,
        mime_type="text/vnd.mermaid",
        size_bytes=size,
        sha256=sha,
        summary=f"task canvas v{version}",
    )


def _append_node(mermaid: str, node_id: str, label: str, prev_node_id: str | None) -> str:
    lines = [ln.rstrip() for ln in mermaid.strip().splitlines() if ln.strip()]
    if not lines:
        lines = ["graph TD"]
    elif lines[0].strip() != "graph TD":
        lines.insert(0, "graph TD")
    node_line = f'  n_{node_id}["{_escape_mermaid_label(label)}"]'
    if any(f"n_{node_id}" in ln for ln in lines):
        return "\n".join(lines) + "\n"
    lines.append(node_line)
    if prev_node_id:
        edge = f"  n_{prev_node_id} --> n_{node_id}"
        if edge not in lines:
            lines.append(edge)
    return "\n".join(lines) + "\n"


def update_task_canvas(
    task_id: str,
    session_id: str,
    *,
    event: str,
    payload: dict,
) -> dict | None:
    """Append a tool-call node to the active task canvas."""
    if event != "tool_call_completed":
        return None
    toolcall_id = str(payload.get("toolcall_id") or "")
    tool_name = str(payload.get("tool_name") or "tool")
    state = str(payload.get("state") or "completed")
    output = str(payload.get("output") or "")
    if not task_id or not toolcall_id:
        return None

    project_id = _project_id(session_id)
    node_id = _node_id_from_toolcall(toolcall_id)
    label = f"{tool_name} {_status_icon(state)}"

    canvas = canvas_get_active_for_task(task_id)
    if canvas:
        existing_refs = canvas_node_ref_list(canvas["id"])
        if any(r["node_id"] == node_id for r in existing_refs):
            return canvas
        prev_node_id = existing_refs[-1]["node_id"] if existing_refs else None
        mermaid = _read_artifact_text(canvas["mermaid_artifact_id"])
        version = int(canvas.get("version") or 1)
        canvas_id = canvas["id"]
        artifact_id = canvas["mermaid_artifact_id"]
    else:
        prev_node_id = None
        mermaid = "graph TD\n"
        version = 1
        placeholder = artifact_create(
            "task_canvas",
            _canvas_artifact_rel(project_id, task_id, version),
            session_id=session_id,
            task_id=task_id,
            mime_type="text/vnd.mermaid",
            summary="task canvas v1",
        )
        artifact_id = placeholder["id"]
        canvas = canvas_create(
            task_id,
            session_id,
            artifact_id,
            node_count=0,
            version=version,
            state="active",
        )
        canvas_id = canvas["id"]

    mermaid = _append_node(mermaid, node_id, label, prev_node_id)
    art = _write_mermaid_artifact(
        project_id=project_id,
        task_id=task_id,
        session_id=session_id,
        version=version,
        mermaid_text=mermaid,
        existing_artifact_id=artifact_id,
    )

    write_ref(
        node_id,
        output,
        session_id=session_id,
        project_id=project_id,
        tool_name=tool_name,
        state=state,
    )
    canvas_node_ref_create(
        canvas_id,
        node_id,
        "tool_call",
        toolcall_id,
        label=label,
    )
    node_count = len(canvas_node_ref_list(canvas_id))
    return canvas_update(
        canvas_id,
        mermaid_artifact_id=art["id"],
        node_count=node_count,
        token_count=_estimate_tokens(mermaid),
    )


def get_active_canvas(task_id: str) -> dict | None:
    """Return active canvas mermaid text and node refs."""
    canvas = canvas_get_active_for_task(task_id)
    if not canvas:
        return None
    mermaid = _read_artifact_text(canvas["mermaid_artifact_id"])
    nodes = canvas_node_ref_list(canvas["id"])
    return {
        "canvas": canvas,
        "mermaid": mermaid,
        "nodes": nodes,
    }


def list_canvas_history(session_id: str, limit: int = 3) -> list[dict]:
    """Return archived canvases with mermaid preview."""
    rows = canvas_list_for_session(session_id, limit=limit, state="archived")
    out: list[dict] = []
    for row in rows:
        mermaid = _read_artifact_text(row["mermaid_artifact_id"])
        out.append({**row, "mermaid": mermaid})
    return out


def build_canvas_for_prompt(task_id: str, max_tokens: int = 800) -> str:
    """Compact Mermaid block for AgentContext injection."""
    data = get_active_canvas(task_id)
    if not data:
        return ""
    mermaid = data["mermaid"].strip()
    if _estimate_tokens(mermaid) <= max_tokens:
        return mermaid
    lines = mermaid.splitlines()
    kept = [lines[0]] if lines else ["graph TD"]
    budget = max_tokens * 4
    used = len(kept[0])
    for ln in reversed(lines[1:]):
        if used + len(ln) + 1 > budget:
            break
        kept.insert(1, ln)
        used += len(ln) + 1
    return "\n".join(kept) + "\n"


def archive_active_canvas_for_task(task_id: str) -> dict | None:
    """Archive the active canvas when a task finishes (enables history tab)."""
    if not task_id:
        return None
    canvas = canvas_get_active_for_task(task_id)
    if not canvas or canvas.get("state") != "active":
        return canvas
    return canvas_update(canvas["id"], state="archived")
