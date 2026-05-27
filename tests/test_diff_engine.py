"""Phase 7 — unified diff generation."""

from __future__ import annotations

from edagent_vivado.patches.diff_engine import generate_diff, populate_diff_for_change
from edagent_vivado.patches.proposal import PatchChange


def test_generate_unified_diff():
    diff = generate_diff("a\nb\n", "a\nc\n", filename="top.v")
    assert "--- a/top.v" in diff
    assert "+++ b/top.v" in diff
    assert "-b" in diff or "-b\n" in diff.replace("\r", "")


def test_populate_modify_diff():
    ch = PatchChange(
        path="rtl/top.v",
        action="modify",
        file_category="rtl",
        before_text="wire a;",
        after_text="wire b;",
    )
    populate_diff_for_change(ch)
    assert ch.diff_text
    assert "wire" in ch.diff_text
