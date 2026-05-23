"""Tests for file patch approval policy and safe apply."""

from pathlib import Path

from edagent_vivado.harness.approval_apply import apply_approved_files
from edagent_vivado.harness.file_patch_policy import (
    is_file_tool_queued_for_approval,
)
from edagent_vivado.harness.interaction import FileItem


def test_queue_only_on_proposed_output():
    assert is_file_tool_queued_for_approval("create_file_tool", "FILE PROPOSED (not yet created")
    assert not is_file_tool_queued_for_approval(
        "create_file_tool", "ERROR: File already exists: foo.v"
    )
    assert is_file_tool_queued_for_approval("propose_patch_tool", "PATCH PROPOSED (not yet applied")
    assert not is_file_tool_queued_for_approval(
        "propose_patch_tool", "ERROR: The specified old_text was not found"
    )


def test_modify_applies_old_to_new_not_whole_file(tmp_path: Path):
    f = tmp_path / "design.v"
    f.write_text("module top;\n  wire a;\nendmodule\n")
    content = "--- OLD ---\n  wire a;\n--- NEW ---\n  wire a, b;\n"
    files = [FileItem(path=str(f), content=content, action="modify")]
    applied, skipped = apply_approved_files(files, [str(f)])
    assert applied == [str(f)]
    assert skipped == []
    text = f.read_text()
    assert "wire a, b;" in text
    assert "module top;" in text


def test_create_refuses_existing_file(tmp_path: Path):
    f = tmp_path / "exists.v"
    f.write_text("legacy")
    files = [FileItem(path=str(f), content="new", action="create")]
    applied, skipped = apply_approved_files(files, [str(f)])
    assert applied == []
    assert skipped == [str(f)]
    assert f.read_text() == "legacy"
