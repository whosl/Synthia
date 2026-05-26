"""Apply approved file changes from human-in-the-loop interactions."""

from __future__ import annotations

import logging
from pathlib import Path

from edagent_vivado.harness.approval_outcomes import (
    OUTCOME_APPROVED,
    OUTCOME_PARTIALLY_APPROVED,
    OUTCOME_USER_REJECTED,
    SCOPE_FILE_CHANGES,
    continuation_prompt,
    format_tool_outcome,
    format_user_rejection,
    should_continue_after_approval,
)
from edagent_vivado.harness.file_patch_policy import apply_approved_file_item
from edagent_vivado.harness.interaction import FileItem

logger = logging.getLogger(__name__)

__all__ = [
    "apply_approved_files",
    "format_approval_tool_output",
    "resolve_project_root",
    "should_continue_after_approval",
    "continuation_prompt",
]


def resolve_project_root(
    *,
    session_id: str | None = None,
    project_id: str | None = None,
) -> Path:
    """Best-effort project root for patch sandbox (defaults to cwd)."""
    from edagent_vivado.repository.db import get_db
    from edagent_vivado.repository.project_scope import project_id_for_session
    from edagent_vivado.repository.store import project_get, session_get

    pid = project_id
    if not pid and session_id:
        sess = session_get(session_id)
        if sess:
            pid = sess.get("project_id")
        if not pid:
            pid = project_id_for_session(get_db(), session_id)
    if pid:
        proj = project_get(pid)
        if proj and proj.get("root_path"):
            return Path(proj["root_path"])
    return Path(".")


def _resolve_approved_indices(
    files: list[FileItem],
    approved_paths: list[str] | None,
    approved_indices: list[int] | None,
) -> set[int]:
    if approved_indices is not None:
        return {int(i) for i in approved_indices if 0 <= int(i) < len(files)}
    approved_set = set(approved_paths or [])
    return {i for i, fi in enumerate(files) if fi.path in approved_set}


def apply_approved_files(
    files: list[FileItem],
    approved_paths: list[str] | None = None,
    *,
    approved_indices: list[int] | None = None,
    project_root: str | Path = ".",
) -> tuple[list[str], list[str]]:
    """Write approved file changes to disk. Returns (applied_paths, skipped_paths) per change row."""
    selected = _resolve_approved_indices(files, approved_paths, approved_indices)
    applied: list[str] = []
    skipped: list[str] = []
    for i, fi in enumerate(files):
        if i not in selected:
            skipped.append(fi.path)
            continue
        ok, detail = apply_approved_file_item(fi, project_root=project_root)
        if ok:
            applied.append(fi.path)
        else:
            logger.warning("Skipped approved file %s: %s", fi.path, detail)
            skipped.append(fi.path)
    return applied, skipped


def format_approval_tool_output(
    applied: list[str],
    skipped: list[str],
    *,
    total_changes: int | None = None,
) -> str:
    """Structured JSON returned to the agent after file approval."""
    total = total_changes if total_changes is not None else len(applied) + len(skipped)
    if not applied:
        return format_user_rejection(SCOPE_FILE_CHANGES, detail="User rejected all proposed file changes.")
    if not skipped:
        return format_tool_outcome(
            OUTCOME_APPROVED,
            f"User approved and applied {len(applied)} file(s).",
            scope=SCOPE_FILE_CHANGES,
            ran=False,
            success=True,
            extra={"applied_files": applied},
        )
    return format_tool_outcome(
        OUTCOME_PARTIALLY_APPROVED,
        f"User partially approved {len(applied)}/{total} file(s).",
        scope=SCOPE_FILE_CHANGES,
        ran=False,
        success=True,
        extra={"applied_files": applied, "skipped_files": skipped},
    )
