"""Phase 3A: path mapper, registry, CLI."""

from pathlib import Path

from edagent_vivado.harness.path_mapper import PathMapper
from edagent_vivado.harness.vivado_agent_registry import is_vivado_execution_tool, vivado_tool_spec


def test_path_mapper_roundtrip():
    m = PathMapper("/work/proj", "/remote/edagent/proj")
    local = Path("/work/proj/rtl/top.v")
    remote = m.to_remote(local)
    assert remote == "/remote/edagent/proj/rtl/top.v"
    assert m.to_local(remote) == local


def test_flow_tool_in_registry():
    assert is_vivado_execution_tool("run_vivado_flow_tool")
    spec = vivado_tool_spec("run_vivado_flow_tool")
    assert spec is not None
    assert spec.operation == "flow"
