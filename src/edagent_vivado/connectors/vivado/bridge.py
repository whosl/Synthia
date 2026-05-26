"""Bridge LangChain Vivado tools to VivadoConnector capabilities."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from edagent_vivado.connectors import ensure_connectors
from edagent_vivado.connectors.base.registry import get_connector
from edagent_vivado.connectors.base.types import ToolRunRequest
from edagent_vivado.connectors.run_execution import execute_with_steps
from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter, VivadoResult

_TOOL_CAPABILITY: dict[str, str] = {
    "run_vivado_synth_tool": "run_synthesis",
    "run_vivado_impl_tool": "run_implementation",
    "run_vivado_flow_tool": "run_implementation",
}


def _workspace_from_artifacts(artifacts: list) -> str:
    for art in artifacts:
        p = Path(art.path)
        if p.is_file() and p.parent.name == "reports":
            return str(p.parent.parent)
    return ""


def run_manifest_via_connector(
    tool_name: str,
    manifest_path: str,
    *,
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
    run_synth_first: bool | None = None,
    event_sink: Any = None,
) -> dict[str, Any] | None:
    """Execute manifest flow via connector; None => caller should use legacy adapter."""
    cap_id = _TOOL_CAPABILITY.get(tool_name)
    if not cap_id:
        return None
    ensure_connectors()
    conn = get_connector("vivado")
    if conn is None:
        return None

    if run_synth_first is None:
        run_synth_first = tool_name != "run_vivado_impl_tool"

    req = ToolRunRequest(
        request_id=str(uuid.uuid4()),
        run_id=run_id,
        step_id="",
        connector_id="vivado",
        capability_id=cap_id,
        inputs={
            "manifest_path": manifest_path,
            "session_id": session_id,
            "task_id": task_id,
            "run_id": run_id,
            "run_synth_first": run_synth_first,
        },
        manifest_path=manifest_path,
        auto_approved=True,
    )
    tool_result = execute_with_steps(req, event_sink=event_sink)
    if tool_result.edagent_outcome in ("policy_denied", "needs_approval"):
        return {
            "success": False,
            "error": tool_result.error or tool_result.edagent_outcome,
            "edagent_outcome": tool_result.edagent_outcome,
        }

    workspace = _workspace_from_artifacts(tool_result.artifacts)
    out: dict[str, Any] = {
        "success": tool_result.success,
        "return_code": tool_result.exit_code,
        "workspace": workspace,
        "error": tool_result.error,
        "target_id": tool_result.target_id,
    }
    return out


def run_tcl_via_adapter(
    command: str,
    *,
    target_id: str = "",
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
) -> VivadoResult:
    adapter = VivadoRuntimeAdapter()
    if target_id:
        from edagent_vivado.harness.vivado_adapter import get_target

        adapter = VivadoRuntimeAdapter(get_target(target_id))
    return adapter.run_tcl(
        command,
        auto_approved=True,
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
    )


def run_script_via_adapter(
    script: str,
    *,
    target_id: str = "",
    session_id: str = "",
    task_id: str = "",
    run_id: str = "",
) -> VivadoResult:
    adapter = VivadoRuntimeAdapter()
    if target_id:
        from edagent_vivado.harness.vivado_adapter import get_target

        adapter = VivadoRuntimeAdapter(get_target(target_id))
    return adapter.run_script(
        script,
        auto_approved=True,
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
    )
