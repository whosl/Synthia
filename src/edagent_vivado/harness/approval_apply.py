"""Apply approved file changes from human-in-the-loop interactions."""

from __future__ import annotations

import logging

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
    "should_continue_after_approval",
    "continuation_prompt",
]


def apply_approved_files(files: list[FileItem], approved_paths: list[str]) -> tuple[list[str], list[str]]:
    """Write approved files to disk. Returns (applied_paths, skipped_paths)."""
    approved_set = set(approved_paths)
    applied: list[str] = []
    skipped: list[str] = []
    for fi in files:
        if fi.path not in approved_set:
            skipped.append(fi.path)
            continue
        ok, detail = apply_approved_file_item(fi)
        if ok:
            applied.append(fi.path)
        else:
            logger.warning("Skipped approved file %s: %s", fi.path, detail)
            skipped.append(fi.path)
    return applied, skipped


def format_approval_tool_output(applied: list[str], skipped: list[str]) -> str:
    """Structured JSON returned to the agent after file approval."""
    total = len(applied) + len(skipped)
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
