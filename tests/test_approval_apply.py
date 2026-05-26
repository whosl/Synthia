"""Tests for partial file approval application."""

import json
from pathlib import Path

from edagent_vivado.harness.approval_apply import apply_approved_files, format_approval_tool_output
from edagent_vivado.harness.approval_outcomes import OUTCOME_APPROVED, OUTCOME_PARTIALLY_APPROVED
from edagent_vivado.harness.interaction import FileItem


def test_partial_approval_applies_subset(tmp_path):
    a = tmp_path / "a.v"
    b = tmp_path / "b.v"
    files = [
        FileItem(path=str(a), content="module a;", action="create"),
        FileItem(path=str(b), content="module b;", action="create"),
    ]
    applied, skipped = apply_approved_files(files, [str(a)])
    assert applied == [str(a)]
    assert skipped == [str(b)]
    assert a.read_text() == "module a;"
    assert not b.exists()


def test_approve_all_indices_applies_duplicate_paths(tmp_path: Path):
    f = tmp_path / "top.v"
    f.write_text("module top;\n  wire a;\nendmodule\n")
    files = [
        FileItem(
            path=str(f),
            content="--- OLD ---\n  wire a;\n--- NEW ---\n  wire a, b;\n",
            action="modify",
        ),
        FileItem(
            path=str(f),
            content="--- OLD ---\n  wire a, b;\n--- NEW ---\n  wire a, b, c;\n",
            action="modify",
        ),
    ]
    applied, skipped = apply_approved_files(files, approved_indices=[0, 1])
    assert applied == [str(f), str(f)]
    assert skipped == []
    assert "wire a, b, c;" in f.read_text()


def test_format_partial_output():
    out = format_approval_tool_output(["/a.v"], ["/b.v"])
    data = json.loads(out)
    assert data["edagent_outcome"] == OUTCOME_PARTIALLY_APPROVED
    assert "/a.v" in data["applied_files"]


def test_format_full_output():
    out = format_approval_tool_output(["/a.v"], [])
    data = json.loads(out)
    assert data["edagent_outcome"] == OUTCOME_APPROVED
