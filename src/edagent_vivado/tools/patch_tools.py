"""Patch tools — allow the agent to propose and apply file edits."""

from __future__ import annotations

import difflib
import logging
from pathlib import Path

from langchain_core.tools import tool

logger = logging.getLogger(__name__)

# ── approval state ────────────────────────────────────────────
# Global flag: when False, patches are only proposed, not applied.
_patch_approval_granted = False


def set_patch_approval(granted: bool) -> None:
    """Enable or disable automatic patch application."""
    global _patch_approval_granted
    _patch_approval_granted = granted


def is_patch_approved() -> bool:
    return _patch_approval_granted


def resolve_old_text_in_file(original: str, old_text: str) -> tuple[str | None, str | None]:
    """Resolve old_text against file content. Returns (resolved_old, error_message)."""
    if old_text in original:
        return old_text, None
    old_lines = old_text.strip().splitlines()
    content_lines = original.splitlines()
    for i in range(len(content_lines) - len(old_lines) + 1):
        if content_lines[i] == old_lines[0]:
            return "\n".join(content_lines[i : i + len(old_lines)]), None
    return None, "old_text not found in file"


def apply_text_patch(file_path: str | Path, old_text: str, new_text: str) -> tuple[bool, str]:
    """Apply old_text -> new_text replacement. Returns (success, message)."""
    p = Path(file_path)
    if not p.exists():
        return False, f"file not found: {p}"
    original = p.read_text(errors="replace")
    resolved, err = resolve_old_text_in_file(original, old_text)
    if err:
        return False, err
    assert resolved is not None
    try:
        p.write_text(original.replace(resolved, new_text))
        return True, "patch applied"
    except OSError as exc:
        return False, f"write failed: {exc}"


def parse_modify_payload(content: str) -> tuple[str, str] | None:
    """Parse batched modify content from --- OLD --- / --- NEW --- markers."""
    if "--- OLD ---" not in content or "--- NEW ---" not in content:
        return None
    body = content.split("--- OLD ---", 1)[1]
    if "--- NEW ---" not in body:
        return None
    old_part, new_part = body.split("--- NEW ---", 1)
    return old_part.lstrip("\n"), new_part.lstrip("\n")


@tool
def propose_patch_tool(file_path: str, old_text: str, new_text: str, description: str = "") -> str:
    """Propose a code change (patch) to a file. By default, only shows the diff with user approval.

    The change will only be applied if the user has granted explicit approval.
    Always use this tool before attempting to apply changes.

    Args:
        file_path: Path to the file to change (relative to workspace or absolute).
        old_text: The text to replace (must match exactly, including whitespace).
        new_text: The replacement text.
        description: A brief explanation of WHY this change is needed.
    """
    p = Path(file_path)
    exists = p.exists()
    original = p.read_text(errors="replace") if exists else ""

    resolved, err = resolve_old_text_in_file(original, old_text)
    if err:
        return (
            f"ERROR: The specified old_text was not found in {file_path}.\n"
            f"First few lines of file:\n{chr(10).join(original.splitlines()[:20])}\n"
            f"Please re-read the file and try again with exact text."
        )
    old_text = resolved

    diff = "\n".join(
        difflib.unified_diff(
            original.splitlines(),
            (original.replace(old_text, new_text)).splitlines(),
            fromfile=f"a/{Path(file_path).name}",
            tofile=f"b/{Path(file_path).name}",
            lineterm="",
        )
    )

    if _patch_approval_granted:
        ok, msg = apply_text_patch(p, old_text, new_text)
        if not ok:
            return f"ERROR applying patch: {msg}"
        logger.info("Patch applied to %s: %s", file_path, description)
        return f"PATCH APPLIED to {file_path}\nDescription: {description}\n\nDiff:\n{diff}"
    else:
        return (
            f"PATCH PROPOSED (not yet applied — user approval required)\n"
            f"File: {file_path}\n"
            f"Description: {description}\n\n"
            f"Diff:\n{diff}\n\n"
            f"To apply this patch, the user must run with --approve-patches or call edagent approve."
        )


@tool
def create_file_tool(file_path: str, content: str, description: str = "") -> str:
    """Create a new file with the given content. Requires user approval by default.

    Args:
        file_path: Path for the new file.
        content: File content.
        description: Why this file is needed.
    """
    p = Path(file_path)
    if p.exists():
        return f"ERROR: File already exists: {file_path}. Use propose_patch_tool to modify it."

    if _patch_approval_granted:
        try:
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            logger.info("File created: %s — %s", file_path, description)
            return f"FILE CREATED: {file_path}\nDescription: {description}\nSize: {len(content)} chars"
        except Exception as e:
            return f"ERROR creating file: {e}"
    else:
        return (
            f"FILE PROPOSED (not yet created — user approval required)\n"
            f"Path: {file_path}\n"
            f"Description: {description}\n\n"
            f"Content preview:\n{content[:500]}"
        )
