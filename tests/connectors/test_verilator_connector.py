"""Phase 6F — Verilator connector."""

from edagent_vivado.connectors.base.registry import clear_registry, get_connector, list_connectors
from edagent_vivado.connectors.verilator.connector import register


def test_verilator_registers():
    clear_registry()
    register()
    conns = list_connectors()
    ids = {c.connector_id for c in conns}
    assert "verilator" in ids
    conn = get_connector("verilator")
    assert conn is not None
    assert len(conn.list_capabilities()) == 3
    env = conn.detect_environment()
    assert env.connector_id == "verilator"
