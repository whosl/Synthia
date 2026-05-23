"""Vivado execution tool for the agent."""

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
from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.run_context import get_agent_task_id
from edagent_vivado.harness.vivado_run_gate import wait_vivado_run_allowed
from edagent_vivado.harness.vivado_runner import VivadoRunner
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

        manifest = Manifest.load(manifest_path)
        ws = Workspace(base_dir=Path(manifest_path).parent, task_name="agent_synth")
        ws.copy_sources(manifest)
        ws.write_manifest(manifest)

        runner = VivadoRunner(workspace=ws, manifest=manifest)

        # --- Pre-generate synth TCL and patch paths BEFORE runner sends it to remote ---
        from edagent_vivado.harness.tcl_templates import generate_synth_tcl
        tcl_content = generate_synth_tcl(manifest, ws.root)
        tcl_path = ws.script_path("synth.tcl")
        tcl_path.write_text(tcl_content, encoding="utf-8")
        # Patch: replace absolute workspace root with relative paths for remote compatibility
        _patch_tcl_to_relative(tcl_path, ws.root)

        if runner.is_mock:
            result = runner.run_synth()
        elif runner._remote_cfg:
            # For remote runs, patch source paths to use workspace src/ directory
            tc = tcl_path.read_text(errors="replace")
            for rp in manifest.rtl_paths():
                tc = tc.replace(str(rp), f"src/{rp.name}").replace(str(rp).replace("\\", "/"), f"src/{rp.name}")
            for xp in manifest.xdc_paths():
                tc = tc.replace(str(xp), f"src/{xp.name}").replace(str(xp).replace("\\", "/"), f"src/{xp.name}")
            tcl_path.write_text(tc)
            result = runner._remote_run("synth", tcl_path)
            # SSH connection failure — do not silently mock; surface the error
            if result.get("return_code") == 255 and not result.get("success"):
                import logging
                err = result.get("error") or "SSH connection to remote Vivado host failed (exit 255)"
                logging.error("Remote synthesis failed: %s", err)
                result["error"] = err
                result["mock"] = False
                result["remote"] = True
        else:
            result = runner.run_synth()
            for tf in ws.root.glob("scripts/*.tcl"):
                _patch_tcl_to_relative(tf, ws.root)

        summary_path = ws.write_json(result, "synth_result")
        result["workspace"] = str(ws.root)
        result["summary_path"] = str(summary_path)
        return tag_execution_result(result, SCOPE_VIVADO_SYNTH)
    except Exception as e:
        return format_execution_failed(SCOPE_VIVADO_SYNTH, str(e))
