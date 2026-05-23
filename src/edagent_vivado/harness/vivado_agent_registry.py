"""Registry of agent Vivado tools — scopes, approval copy, gate operations."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from edagent_vivado.harness.approval_outcomes import (
    SCOPE_VIVADO_FLOW,
    SCOPE_VIVADO_IMPL,
    SCOPE_VIVADO_SCRIPT,
    SCOPE_VIVADO_SYNTH,
    SCOPE_VIVADO_TCL,
)


@dataclass(frozen=True)
class VivadoAgentToolSpec:
    tool_name: str
    scope: str
    operation: str
    title: str
    message_prefix: str

    def approval_message(self, tool_input: dict[str, Any]) -> str:
        if self.tool_name == "run_vivado_synth_tool":
            manifest = tool_input.get("manifest_path", "")
            return f"{self.message_prefix}\nManifest: {manifest}"
        if self.tool_name == "run_vivado_impl_tool":
            manifest = tool_input.get("manifest_path", "")
            return f"{self.message_prefix}\nManifest: {manifest}"
        if self.tool_name == "run_vivado_tcl_tool":
            cmd = str(tool_input.get("command", ""))[:500]
            return f"{self.message_prefix}\nCommand:\n{cmd}"
        if self.tool_name == "run_vivado_script_tool":
            script = str(tool_input.get("script", ""))[:500]
            return f"{self.message_prefix}\nScript:\n{script}"
        if self.tool_name == "run_vivado_flow_tool":
            manifest = tool_input.get("manifest_path", "")
            return f"{self.message_prefix}\nManifest: {manifest}"
        return self.message_prefix


VIVADO_AGENT_TOOLS: dict[str, VivadoAgentToolSpec] = {
    "run_vivado_synth_tool": VivadoAgentToolSpec(
        tool_name="run_vivado_synth_tool",
        scope=SCOPE_VIVADO_SYNTH,
        operation="synth",
        title="Run Vivado Synthesis",
        message_prefix="Allow running Vivado synthesis?",
    ),
    "run_vivado_impl_tool": VivadoAgentToolSpec(
        tool_name="run_vivado_impl_tool",
        scope=SCOPE_VIVADO_IMPL,
        operation="impl",
        title="Run Vivado Implementation",
        message_prefix="Allow running Vivado implementation (place & route)?",
    ),
    "run_vivado_tcl_tool": VivadoAgentToolSpec(
        tool_name="run_vivado_tcl_tool",
        scope=SCOPE_VIVADO_TCL,
        operation="tcl",
        title="Run Vivado Tcl Command",
        message_prefix="Allow executing this Vivado Tcl command on the target?",
    ),
    "run_vivado_script_tool": VivadoAgentToolSpec(
        tool_name="run_vivado_script_tool",
        scope=SCOPE_VIVADO_SCRIPT,
        operation="script",
        title="Run Vivado Tcl Script",
        message_prefix="Allow executing this Vivado Tcl script on the target?",
    ),
    "run_vivado_flow_tool": VivadoAgentToolSpec(
        tool_name="run_vivado_flow_tool",
        scope=SCOPE_VIVADO_FLOW,
        operation="flow",
        title="Run Vivado Full Flow",
        message_prefix="Allow running Vivado synthesis + implementation?",
    ),
}


def is_vivado_execution_tool(tool_name: str) -> bool:
    return tool_name in VIVADO_AGENT_TOOLS


def vivado_tool_spec(tool_name: str) -> VivadoAgentToolSpec | None:
    return VIVADO_AGENT_TOOLS.get(tool_name)
