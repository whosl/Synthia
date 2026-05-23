"""Vivado execution tools — adapter + HITL gates + structured outcomes (Phase 3)."""

from __future__ import annotations

import json
from pathlib import Path

from langchain_core.tools import tool

from edagent_vivado.harness.approval_outcomes import (
    SCOPE_VIVADO_IMPL,
    SCOPE_VIVADO_SCRIPT,
    SCOPE_VIVADO_SYNTH,
    SCOPE_VIVADO_FLOW,
    SCOPE_VIVADO_TCL,
    format_execution_failed,
    format_user_rejection,
    tag_execution_result,
    tag_vivado_adapter_result,
)
from edagent_vivado.harness.run_context import get_agent_run_context, get_agent_task_id
from edagent_vivado.harness.vivado_adapter import VivadoRuntimeAdapter
from edagent_vivado.harness.vivado_agent_registry import vivado_tool_spec
from edagent_vivado.harness.vivado_run_gate import wait_vivado_gate_allowed


def _patch_tcl_to_relative(tcl_path: Path, ws_root: Path) -> None:
    content = tcl_path.read_text(encoding="utf-8", errors="replace")
    ws_root_fwd = str(ws_root).replace("\\", "/")
    content = content.replace(ws_root_fwd, ".")
    tcl_path.write_text(content, encoding="utf-8")


def _ctx_ids() -> tuple[str, str, str]:
    ctx = get_agent_run_context()
    task_id = ctx.get("task_id", "") or (get_agent_task_id() or "")
    return ctx.get("session_id", ""), task_id, ctx.get("run_id", "")


def _gate_or_reject(tool_name: str) -> str | None:
    """Return rejection JSON if user denied approval; None if allowed."""
    spec = vivado_tool_spec(tool_name)
    if not spec:
        return None
    task_id = get_agent_task_id()
    from edagent_vivado.harness.vivado_run_gate import is_vivado_gate_rejected

    if task_id and is_vivado_gate_rejected(task_id, spec.operation):
        return format_user_rejection(spec.scope, tool_name=tool_name)
    if not wait_vivado_gate_allowed(task_id, spec.operation):
        return format_user_rejection(spec.scope, tool_name=tool_name)
    return None


@tool
def run_vivado_synth_tool(manifest_path: str, approval_request: str = "") -> str:
    """Run Vivado synthesis using the project manifest. Returns a JSON summary.

    Args:
        manifest_path: Path to eda.yaml project manifest.
        approval_request: Required JSON string for the approval UI (see system prompt schema).
    """
    try:
        rejected = _gate_or_reject("run_vivado_synth_tool")
        if rejected:
            return rejected

        session_id, task_id, run_id = _ctx_ids()
        adapter = VivadoRuntimeAdapter()
        result = adapter.run_synthesis(
            manifest_path,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
        )

        ws_path = Path(result.get("workspace") or "")
        summary_path = ws_path / "artifacts" / "synth_result.json"
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, default=str)
        result["summary_path"] = str(summary_path)

        return tag_execution_result(result, SCOPE_VIVADO_SYNTH)
    except Exception as e:
        return format_execution_failed(SCOPE_VIVADO_SYNTH, str(e))


@tool
def run_vivado_impl_tool(manifest_path: str, approval_request: str = "") -> str:
    """Run Vivado implementation (synth checkpoint + place/route) from eda.yaml manifest.

    Args:
        manifest_path: Path to eda.yaml project manifest.
        approval_request: Required JSON string for the approval UI.
    """
    try:
        rejected = _gate_or_reject("run_vivado_impl_tool")
        if rejected:
            return rejected

        session_id, task_id, run_id = _ctx_ids()
        adapter = VivadoRuntimeAdapter()
        result = adapter.run_implementation(
            manifest_path,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
        )

        ws_path = Path(result.get("workspace") or "")
        summary_path = ws_path / "artifacts" / "impl_result.json"
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, default=str)
        result["summary_path"] = str(summary_path)

        return tag_execution_result(result, SCOPE_VIVADO_IMPL)
    except Exception as e:
        return format_execution_failed(SCOPE_VIVADO_IMPL, str(e))


@tool
def run_vivado_tcl_tool(command: str, target_id: str = "", approval_request: str = "") -> str:
    """Execute a single Vivado Tcl command (policy-checked, user-approved).

    Args:
        command: Tcl command to run.
        target_id: Optional Vivado target id.
        approval_request: Required JSON string for the approval UI (include reason + tcl_command).
    """
    try:
        rejected = _gate_or_reject("run_vivado_tcl_tool")
        if rejected:
            return rejected

        session_id, task_id, run_id = _ctx_ids()
        adapter = VivadoRuntimeAdapter()
        if target_id:
            from edagent_vivado.harness.vivado_adapter import get_target

            adapter = VivadoRuntimeAdapter(get_target(target_id))

        policy = adapter.check_policy(command, auto_approved=True)
        if not policy.allowed:
            return format_execution_failed(
                SCOPE_VIVADO_TCL,
                f"Policy denied: {policy.reason}",
                extra={"policy": policy.matched_rules},
            )

        result = adapter.run_tcl(
            command,
            auto_approved=True,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
        )
        return tag_vivado_adapter_result(result, SCOPE_VIVADO_TCL)
    except Exception as e:
        return format_execution_failed(SCOPE_VIVADO_TCL, str(e))


@tool
def run_vivado_script_tool(script: str, target_id: str = "", approval_request: str = "") -> str:
    """Execute a Vivado Tcl script in batch mode (policy-checked, user-approved).

    Args:
        script: Tcl script body or path.
        target_id: Optional Vivado target id.
        approval_request: Required JSON string for the approval UI.
    """
    try:
        rejected = _gate_or_reject("run_vivado_script_tool")
        if rejected:
            return rejected

        session_id, task_id, run_id = _ctx_ids()
        adapter = VivadoRuntimeAdapter()
        if target_id:
            from edagent_vivado.harness.vivado_adapter import get_target

            adapter = VivadoRuntimeAdapter(get_target(target_id))

        policy = adapter.check_script_policy(script, auto_approved=True)
        if not policy.allowed:
            return format_execution_failed(
                SCOPE_VIVADO_SCRIPT,
                f"Policy denied: {policy.reason}",
                extra={"policy": policy.matched_rules},
            )

        result = adapter.run_script(
            script,
            auto_approved=True,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
        )
        return tag_vivado_adapter_result(result, SCOPE_VIVADO_SCRIPT)
    except Exception as e:
        return format_execution_failed(SCOPE_VIVADO_SCRIPT, str(e))


@tool
def run_vivado_flow_tool(manifest_path: str, approval_request: str = "") -> str:
    """Run full Vivado flow: synthesis then implementation from eda.yaml.

    Args:
        manifest_path: Path to eda.yaml project manifest.
        approval_request: Required JSON string for the approval UI.
    """
    try:
        rejected = _gate_or_reject("run_vivado_flow_tool")
        if rejected:
            return rejected

        session_id, task_id, run_id = _ctx_ids()
        adapter = VivadoRuntimeAdapter()
        result = adapter.run_implementation(
            manifest_path,
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            run_synth_first=True,
        )

        ws_path = Path(result.get("workspace") or "")
        summary_path = ws_path / "artifacts" / "flow_result.json"
        summary_path.parent.mkdir(parents=True, exist_ok=True)
        with open(summary_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, default=str)
        result["summary_path"] = str(summary_path)

        return tag_execution_result(result, SCOPE_VIVADO_FLOW)
    except Exception as e:
        return format_execution_failed(SCOPE_VIVADO_FLOW, str(e))
