"""Vivado execution tool for the agent."""

from __future__ import annotations

import json
from pathlib import Path

from langchain_core.tools import tool

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.vivado_runner import VivadoRunner
from edagent_vivado.harness.workspace import Workspace


@tool
def run_vivado_synth_tool(manifest_path: str) -> str:
    """Run Vivado synthesis using the project manifest. Returns a JSON summary.

    Creates a timestamped workspace, generates synthesis Tcl, and runs Vivado
    (or mock Vivado if the tool is not installed).

    Args:
        manifest_path: Path to the eda.yaml manifest file.
    """
    try:
        manifest = Manifest.load(manifest_path)
        ws = Workspace(base_dir=Path(manifest_path).parent, task_name="agent_synth")
        ws.copy_sources(manifest)
        ws.write_manifest(manifest)

        runner = VivadoRunner(workspace=ws, manifest=manifest)
        result = runner.run_synth()
        summary_path = ws.write_json(result, "synth_result")
        result["workspace"] = str(ws.root)
        result["summary_path"] = str(summary_path)
        return json.dumps(result, indent=2, default=str)
    except Exception as e:
        return f"ERROR: Synthesis failed: {e}"
