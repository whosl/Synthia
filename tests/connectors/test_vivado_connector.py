"""Phase 6B — Vivado connector registration and capabilities."""

from __future__ import annotations

import pytest

from edagent_vivado.connectors.base.registry import clear_registry, get_connector
from edagent_vivado.connectors.base.types import ToolRunRequest
from edagent_vivado.connectors.vivado.connector import VivadoConnector, register


@pytest.fixture(autouse=True)
def _fresh_registry():
    clear_registry()
    yield
    clear_registry()


def test_register_lists_vivado_capabilities():
    register()
    conn = get_connector("vivado")
    assert conn is not None
    caps = conn.list_capabilities()
    assert len(caps) == 18
    ids = {c.capability_id for c in caps}
    assert "run_synthesis" in ids
    assert "report_drc" in ids


def test_detect_environment_mock_or_local():
    register()
    conn = get_connector("vivado")
    assert isinstance(conn, VivadoConnector)
    env = conn.detect_environment()
    assert env.connector_id == "vivado"
    assert env.tool_name == "vivado"
    assert env.target_type in ("local", "remote_ssh", "mock")


def test_validate_project_missing_manifest():
    register()
    conn = get_connector("vivado")
    assert conn is not None
    req = ToolRunRequest(
        request_id="r1",
        run_id="run1",
        step_id="s1",
        connector_id="vivado",
        capability_id="validate_project",
        inputs={"manifest_path": "/nonexistent/eda.yaml"},
        manifest_path="/nonexistent/eda.yaml",
    )
    prepared = conn.prepare_run(req)
    result = conn.execute(prepared)
    assert not result.success
    assert result.edagent_outcome == "execution_failed"
