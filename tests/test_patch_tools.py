"""Tests for patch tools (propose_patch_tool, create_file_tool)."""

import tempfile
from pathlib import Path

from edagent_vivado.tools.patch_tools import (
    propose_patch_tool,
    create_file_tool,
    set_patch_approval,
    is_patch_approved,
)


def test_propose_without_approval():
    set_patch_approval(False)
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "test.v"
        f.write_text("module test;\n  wire a;\nendmodule\n")
        result = propose_patch_tool.invoke({
            "file_path": str(f),
            "old_text": "wire a;",
            "new_text": "wire a, b;",
            "description": "add signal b",
        })
        assert "PROPOSED" in result
        assert "wire a" in f.read_text()  # unchanged


def test_propose_with_approval():
    set_patch_approval(True)
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "test.v"
        f.write_text("module test;\n  wire a;\nendmodule\n")
        result = propose_patch_tool.invoke({
            "file_path": str(f),
            "old_text": "wire a;",
            "new_text": "wire a, b;",
            "description": "add signal b",
        })
        assert "APPLIED" in result
        assert "wire a, b;" in f.read_text()
    set_patch_approval(False)


def test_propose_not_found():
    set_patch_approval(False)
    with tempfile.TemporaryDirectory() as tmp:
        f = Path(tmp) / "test.v"
        f.write_text("module test;\nendmodule\n")
        result = propose_patch_tool.invoke({
            "file_path": str(f),
            "old_text": "does not exist",
            "new_text": "nope",
        })
        assert "ERROR" in result or "not found" in result.lower()


def test_create_file_without_approval():
    set_patch_approval(False)
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "new_file.v"
        result = create_file_tool.invoke({
            "file_path": str(p),
            "content": "module newmod;\nendmodule\n",
            "description": "new module",
        })
        assert "PROPOSED" in result
        assert not p.exists()


def test_create_file_with_approval():
    set_patch_approval(True)
    with tempfile.TemporaryDirectory() as tmp:
        p = Path(tmp) / "new_file.v"
        result = create_file_tool.invoke({
            "file_path": str(p),
            "content": "module newmod;\nendmodule\n",
            "description": "new module",
        })
        assert "CREATED" in result
        assert p.exists()
        assert "newmod" in p.read_text()
    set_patch_approval(False)


def test_approval_toggle():
    set_patch_approval(True)
    assert is_patch_approved()
    set_patch_approval(False)
    assert not is_patch_approved()
