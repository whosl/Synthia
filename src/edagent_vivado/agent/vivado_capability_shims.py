"""Vivado LangChain tools — stable names, connector execution path (Phase 6E)."""

from __future__ import annotations

from langchain_core.tools import tool

from edagent_vivado.agent.run_capability import run_connector_capability
@tool
def run_vivado_synth_tool(manifest_path: str, approval_request: str = "") -> str:
    """Run Vivado synthesis via VivadoConnector ``run_synthesis`` capability."""
    return run_connector_capability(
        "vivado",
        "run_synthesis",
        manifest_path=manifest_path,
        gate_tool_name="run_vivado_synth_tool",
    )


@tool
def run_vivado_impl_tool(manifest_path: str, approval_request: str = "") -> str:
    """Run Vivado implementation via ``run_implementation`` (no synth-first by default)."""
    return run_connector_capability(
        "vivado",
        "run_implementation",
        manifest_path=manifest_path,
        inputs={"run_synth_first": False},
        gate_tool_name="run_vivado_impl_tool",
    )


@tool
def run_vivado_flow_tool(manifest_path: str, approval_request: str = "") -> str:
    """Run synthesis then implementation via connector capabilities."""
    return run_connector_capability(
        "vivado",
        "run_implementation",
        manifest_path=manifest_path,
        inputs={"run_synth_first": True},
        gate_tool_name="run_vivado_flow_tool",
    )


# Tcl/script still use adapter directly (no connector capability id yet).
from edagent_vivado.tools.vivado_tools import run_vivado_script_tool, run_vivado_tcl_tool  # noqa: E402

VIVADO_CAPABILITY_SHIM_TOOLS = [
    run_vivado_synth_tool,
    run_vivado_impl_tool,
    run_vivado_flow_tool,
    run_vivado_tcl_tool,
    run_vivado_script_tool,
]
