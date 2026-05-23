"""Vivado execution tool for the agent — routes through VivadoRuntimeAdapter."""

from __future__ import annotations

import json
from pathlib import Path

from langchain_core.tools import tool

from edagent_vivado.harness.approval_outcomes import (
    SCOPE_VIVADO_SYNTH,
    format_execution_failed,
    format_user_rejection,
    tag_execution_result,
)
from edagent_vivado.harness.run_context import get_agent_task_id
from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter
from edagent_vivado.harness.vivado_run_gate import wait_vivado_run_allowed
from edagent_vivado.harness.workspace import Workspace


def _patch_tcl_to_relative(tcl_path: Path, ws_root: Path) -> None:
    """Replace absolute workspace root paths with relative paths in TCL scripts."""
    content = tcl_path.read_text(encoding="utf-8", errors="replace")
    ws_root_fwd = str(ws_root).replace("\\", "/")
    content = content.replace(ws_root_fwd, ".")
    tcl_path.write_text(content, encoding="utf-8")


@tool
def run_vivado_synth_tool(manifest_path: str) -> str:
    """Run Vivado synthesis using the project manifest. Returns a JSON summary.

    Creates a timestamped workspace, generates synthesis Tcl, and runs Vivado
    (or mock Vivado if the tool is not installed).

    Args:
        manifest_path: Path to the eda.yaml manifest file.
    """
    try:
        task_id = get_agent_task_id()
        if not wait_vivado_run_allowed(task_id):
            return format_user_rejection(SCOPE_VIVADO_SYNTH, tool_name="run_vivado_synth_tool")

        adapter = VivadoRuntimeAdapter()
        result = adapter.run_synthesis(manifest_path)

        ws_path = Path(result.get("workspace") or "")
        summary_path = ws_path / "artifacts" / "synth_result.json"
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, default=str)
        result["summary_path"] = str(summary_path)

        return tag_execution_result(result, SCOPE_VIVADO_SYNTH)
    except Exception as e:
        return format_execution_failed(SCOPE_VIVADO_SYNTH, str(e))
