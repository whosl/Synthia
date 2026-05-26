"""Tests for file patch approval policy and safe apply."""

from pathlib import Path

from langchain_core.messages import ToolMessage

from edagent_vivado.harness.approval_apply import apply_approved_files
from edagent_vivado.harness.file_patch_policy import (
    is_file_tool_queued_for_approval,
    normalize_tool_output,
)
from edagent_vivado.harness.interaction import FileItem


def test_normalize_tool_output_from_tool_message():
    msg = ToolMessage(
        content="FILE PROPOSED (not yet created)\nPath: rtl/a.v",
        tool_call_id="x",
        name="create_file_tool",
    )
    assert normalize_tool_output(msg) == "FILE PROPOSED (not yet created)\nPath: rtl/a.v"
    assert normalize_tool_output(str(msg)) == "FILE PROPOSED (not yet created)\nPath: rtl/a.v"


def test_queue_only_on_proposed_output():
    assert is_file_tool_queued_for_approval("create_file_tool", "FILE PROPOSED (not yet created")
    assert not is_file_tool_queued_for_approval(
        "create_file_tool", "ERROR: File already exists: foo.v"
    )
    assert is_file_tool_queued_for_approval("propose_patch_tool", "PATCH PROPOSED (not yet applied")
    assert not is_file_tool_queued_for_approval(
        "propose_patch_tool", "ERROR: The specified old_text was not found"
    )


def test_queue_on_tool_message_repr():
    msg = ToolMessage(
        content="FILE PROPOSED (not yet created — user approval required)\nPath: rtl/a.v",
        tool_call_id="x",
        name="create_file_tool",
    )
    assert is_file_tool_queued_for_approval("create_file_tool", msg)
    assert is_file_tool_queued_for_approval("create_file_tool", str(msg))


def test_modify_applies_old_to_new_not_whole_file(tmp_path: Path):
    f = tmp_path / "design.v"
    f.write_text("module top;\n  wire a;\nendmodule\n")
    content = "--- OLD ---\n  wire a;\n--- NEW ---\n  wire a, b;\n"
    files = [FileItem(path=str(f), content=content, action="modify")]
    applied, skipped = apply_approved_files(files, [str(f)], project_root=tmp_path)
    assert applied == [str(f)]
    assert skipped == []
    text = f.read_text()
    assert "wire a, b;" in text
    assert "module top;" in text


def test_apply_refuses_outside_root(tmp_path: Path):
    from types import SimpleNamespace

    from edagent_vivado.harness.file_patch_policy import apply_approved_file_item

    fi = SimpleNamespace(path="../../etc/passwd", action="create", content="x")
    ok, msg = apply_approved_file_item(fi, project_root=tmp_path)
    assert not ok
    assert "outside" in msg


def test_apply_refuses_absolute_outside(tmp_path: Path):
    from types import SimpleNamespace

    from edagent_vivado.harness.file_patch_policy import apply_approved_file_item

    fi = SimpleNamespace(path="/etc/passwd", action="create", content="x")
    ok, msg = apply_approved_file_item(fi, project_root=tmp_path)
    assert not ok


def test_apply_refuses_unknown_action(tmp_path: Path):
    from types import SimpleNamespace

    from edagent_vivado.harness.file_patch_policy import apply_approved_file_item

    fi = SimpleNamespace(path="ok.txt", action="overwrite", content="x")
    ok, msg = apply_approved_file_item(fi, project_root=tmp_path)
    assert not ok
    assert "unknown action" in msg


def test_create_refuses_existing_file(tmp_path: Path):
    f = tmp_path / "exists.v"
    f.write_text("legacy")
    files = [FileItem(path=str(f), content="new", action="create")]
    applied, skipped = apply_approved_files(files, [str(f)], project_root=tmp_path)
    assert applied == []
    assert skipped == [str(f)]
    assert f.read_text() == "legacy"
