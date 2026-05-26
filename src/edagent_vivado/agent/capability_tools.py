"""LangChain tools that invoke connector capabilities (Phase 6E factory)."""

from __future__ import annotations

import json

from langchain_core.tools import tool

from edagent_vivado.agent.run_capability import run_connector_capability
from edagent_vivado.connectors import ensure_connectors
from edagent_vivado.connectors.base.registry import get_connector


@tool
def list_connector_capabilities_tool(connector_id: str = "vivado") -> str:
    """List capability ids and metadata for a registered connector (vivado, verilator, …)."""
    ensure_connectors()
    conn = get_connector(connector_id)
    if not conn:
        return json.dumps({"error": f"connector not found: {connector_id}"})
    caps = [
        {
            "capability_id": c.capability_id,
            "display_name": c.display_name,
            "stage": c.stage,
            "risk_level": c.risk_level,
            "requires_approval": c.requires_approval,
            "outputs": list(c.outputs),
        }
        for c in conn.list_capabilities()
    ]
    return json.dumps({"connector_id": connector_id, "capabilities": caps}, indent=2)


@tool
def invoke_connector_capability_tool(
    connector_id: str,
    capability_id: str,
    manifest_path: str = "",
    inputs_json: str = "{}",
) -> str:
    """Execute a connector capability by id. Prefer this over legacy Vivado tool names when planning steps.

    Args:
        connector_id: e.g. vivado
        capability_id: e.g. run_synthesis, report_drc, parse_timing
        manifest_path: eda.yaml path when the capability needs a project manifest
        inputs_json: extra inputs as JSON object (merged with manifest_path / session context)
    """
    try:
        extra = json.loads(inputs_json or "{}")
    except json.JSONDecodeError:
        extra = {}
    if not isinstance(extra, dict):
        extra = {}
    gate = None
    if connector_id == "vivado" and capability_id == "run_synthesis":
        gate = "run_vivado_synth_tool"
    elif connector_id == "vivado" and capability_id == "run_implementation":
        gate = "run_vivado_impl_tool"
    return run_connector_capability(
        connector_id,
        capability_id,
        manifest_path=manifest_path,
        inputs=extra,
        gate_tool_name=gate,
    )


CAPABILITY_AGENT_TOOLS = [
    list_connector_capabilities_tool,
    invoke_connector_capability_tool,
]
