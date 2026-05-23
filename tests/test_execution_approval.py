"""Vivado execution approval flag is independent from patch approval."""

from edagent_vivado.harness.execution_approval import (
    is_vivado_execution_approved,
    set_vivado_execution_approval,
)
from edagent_vivado.tools.patch_tools import is_patch_approved, set_patch_approval


def test_flags_are_independent():
    set_patch_approval(False)
    set_vivado_execution_approval(False)
    assert not is_patch_approved()
    assert not is_vivado_execution_approved()

    set_patch_approval(True)
    assert is_patch_approved()
    assert not is_vivado_execution_approved()

    set_vivado_execution_approval(True)
    assert is_patch_approved()
    assert is_vivado_execution_approved()

    set_patch_approval(False)
    set_vivado_execution_approval(False)
