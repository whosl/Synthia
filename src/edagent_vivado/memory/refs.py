"""Node ref files under .edagent/projects/{project_id}/refs/{node_id}.md."""

from __future__ import annotations

import os
from pathlib import Path

from edagent_vivado.repository.project_scope import project_id_for_session
from edagent_vivado.repository.db import get_db


def _runtime_root() -> Path:
    return Path(os.environ.get("EDAGENT_RUNTIME_DIR", ".edagent"))


def ref_path(project_id: str, node_id: str) -> Path:
    return _runtime_root() / "projects" / project_id / "refs" / f"{node_id}.md"


def _resolve_project_id(project_id: str | None, session_id: str) -> str:
    if project_id:
        return project_id
    pid = project_id_for_session(get_db(), session_id)
    return pid or "_default"


def write_ref(
    node_id: str,
    content: str,
    *,
    session_id: str = "",
    project_id: str | None = None,
    tool_name: str = "",
    state: str = "",
) -> Path:
    pid = _resolve_project_id(project_id, session_id)
    path = ref_path(pid, node_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    header_lines = ["# Tool call ref", ""]
    if tool_name:
        header_lines.append(f"- **Tool:** {tool_name}")
    if state:
        header_lines.append(f"- **State:** {state}")
    if tool_name or state:
        header_lines.append("")
    body = "\n".join(header_lines) + content
    path.write_text(body, encoding="utf-8")
    return path


def read_ref(
    node_id: str,
    *,
    session_id: str = "",
    project_id: str | None = None,
) -> str | None:
    pid = _resolve_project_id(project_id, session_id)
    path = ref_path(pid, node_id)
    if not path.is_file():
        return None
    return path.read_text(encoding="utf-8")
