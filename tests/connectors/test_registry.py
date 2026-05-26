"""Connector registry tests."""

import pytest

from edagent_vivado.connectors.base.registry import (
    clear_registry,
    find_capability,
    register_connector,
)


def test_duplicate_register_raises():
    clear_registry()
    from edagent_vivado.connectors.verilator.connector import VerilatorConnector

    register_connector(VerilatorConnector())
    with pytest.raises(ValueError, match="duplicate"):
        register_connector(VerilatorConnector())
    clear_registry()


def test_find_capability_after_vivado_register():
    clear_registry()
    from edagent_vivado.connectors.vivado.connector import register

    register()
    cap = find_capability("vivado", "run_synthesis")
    assert cap is not None
    assert cap.requires_approval is True
    clear_registry()
