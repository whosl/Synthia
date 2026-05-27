"""Generate unified diffs for PatchChange — Phase 7."""

from __future__ import annotations

import difflib
from pathlib import Path

from edagent_vivado.patches.proposal import PatchChange


def generate_diff(
    before_text: str,
    after_text: str,
    *,
    filename: str = "file",
    n_context: int = 3,
) -> str:
    before_lines = before_text.splitlines(keepends=False) if before_text else []
    after_lines = after_text.splitlines(keepends=False) if after_text else []
    diff = difflib.unified_diff(
        before_lines,
        after_lines,
        fromfile=f"a/{filename}",
        tofile=f"b/{filename}",
        lineterm="",
        n=n_context,
    )
    return "\n".join(diff)


def populate_diff_for_change(change: PatchChange) -> None:
    if change.action == "delete":
        change.diff_text = "\n".join(f"- {line}" for line in (change.before_text or "").splitlines())
    elif change.action == "create":
        change.diff_text = "\n".join(f"+ {line}" for line in (change.after_text or "").splitlines())
    else:
        change.diff_text = generate_diff(
            change.before_text or "",
            change.after_text or "",
            filename=Path(change.path).name,
        )
