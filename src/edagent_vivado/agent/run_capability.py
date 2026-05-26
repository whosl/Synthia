"""Shared connector capability execution for agent tools."""

from __future__ import annotations

import json
import uuid
from typing import Any

from edagent_vivado.connectors import ensure_connectors
from edagent_vivado.connectors.base.registry import find_capability, get_connector
from edagent_vivado.connectors.base.types import ToolRunRequest
from edagent_vivado.connectors.run_execution import execute_with_steps
from edagent_vivado.harness.approval_outcomes import format_execution_failed, tag_execution_result
from edagent_vivado.harness.run_context import get_agent_task_id
from edagent_vivado.connectors.base.types import ToolCapability
from edagent_vivado.tools.vivado_tools import _ctx_ids, _gate_or_reject


def _resolve_auto_approved(cap: ToolCapability) -> bool:
    if not cap.requires_approval:
        return True
    from edagent_vivado.harness.execution_approval import is_vivado_execution_approved

    return is_vivado_execution_approved()


def _event_sink():
    from edagent_vivado.repository.store import event_create

    return event_create


def run_connector_capability(
    connector_id: str,
    capability_id: str,
    *,
    manifest_path: str = "",
    inputs: dict[str, Any] | None = None,
    gate_tool_name: str | None = None,
) -> str:
    """Execute a capability via ``execute_with_steps``; returns tagged JSON string."""
    scope = f"connector.{connector_id}.{capability_id}"
    try:
        if gate_tool_name:
            rejected = _gate_or_reject(gate_tool_name)
            if rejected:
                return rejected

        ensure_connectors()
        conn = get_connector(connector_id)
        if not conn:
            return format_execution_failed(scope, f"connector not found: {connector_id}")
        cap = find_capability(connector_id, capability_id)
        if not cap:
            return format_execution_failed(scope, f"unknown capability: {capability_id}")

        session_id, task_id, run_id = _ctx_ids()
        merged: dict[str, Any] = {
            "session_id": session_id,
            "task_id": task_id or (get_agent_task_id() or ""),
            "run_id": run_id,
            **(inputs or {}),
        }
        if manifest_path:
            merged["manifest_path"] = manifest_path

        req = ToolRunRequest(
            request_id=str(uuid.uuid4()),
            run_id=run_id,
            step_id="",
            connector_id=connector_id,
            capability_id=capability_id,
            inputs=merged,
            manifest_path=manifest_path or None,
            auto_approved=_resolve_auto_approved(cap),
        )
        result = execute_with_steps(req, event_sink=_event_sink())
        payload = {
            "success": result.success,
            "exit_code": result.exit_code,
            "error": result.error,
            "edagent_outcome": result.edagent_outcome,
            "connector_id": connector_id,
            "capability_id": capability_id,
            "artifacts": [
                {"path": a.path, "kind": getattr(a, "artifact_type", "")}
                for a in result.artifacts
            ],
        }
        return tag_execution_result(payload, scope)
    except Exception as exc:
        return format_execution_failed(scope, str(exc))
