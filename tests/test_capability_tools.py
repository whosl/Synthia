"""Capability factory LangChain tools."""

import importlib
import json

import pytest

from edagent_vivado.agent.capability_tools import (
    CAPABILITY_AGENT_TOOLS,
    list_connector_capabilities_tool,
)
from edagent_vivado.connectors import ensure_connectors


@pytest.fixture(autouse=True)
def connectors_ready():
    from edagent_vivado.connectors.base.registry import clear_registry

    clear_registry()
    ensure_connectors()
    yield
    clear_registry()


def test_capability_tools_registered():
    names = {t.name for t in CAPABILITY_AGENT_TOOLS}
    assert "list_connector_capabilities_tool" in names
    assert "invoke_connector_capability_tool" in names


def test_list_vivado_capabilities(connectors_ready):
    out = list_connector_capabilities_tool.invoke({"connector_id": "vivado"})
    data = json.loads(out)
    assert data["connector_id"] == "vivado"
    assert len(data["capabilities"]) >= 5
