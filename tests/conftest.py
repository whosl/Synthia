"""Shared pytest fixtures."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _reset_vivado_execution_approval():
    """Prevent phase-4 integration tests from leaking auto-approve into HITL tests."""
    yield
    from edagent_vivado.harness.execution_approval import set_vivado_execution_approval

    set_vivado_execution_approval(False)
