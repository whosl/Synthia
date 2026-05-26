"""Enqueue Vivado/Tcl executions into unified approvals + Timeline interactions."""

from __future__ import annotations

import json
from typing import Any, Callable

from edagent_vivado.harness.approval_payload import payload_to_reason_json
from edagent_vivado.harness.interaction import InteractionType, create_interaction
from edagent_vivado.repository.store import approval_create, event_create

EventSink = Callable[..., Any] | None


def enqueue_vivado_approval(
    *,
    approval_type: str,
    payload: dict[str, Any],
    session_id: str,
    task_id: str = "",
    run_id: str = "",
    title: str = "Vivado execution",
    connector_id: str = "vivado",
    risk_level: str = "high",
    event_sink: EventSink = None,
) -> dict[str, Any]:
    """Create interaction + approvals row; emit interaction.requested."""
    interaction = create_interaction(
        InteractionType.APPROVAL,
        session_id,
        task_id,
        title=title,
        message="",
        reason=payload_to_reason_json(payload),
        files=[],
    )
    sink = event_sink or event_create
    if session_id:
        sink(
            session_id,
            "interaction.requested",
            interaction.to_dict(),
            task_id=task_id or None,
            run_id=run_id or None,
        )
    row = approval_create(
        approval_type,
        {**payload, **interaction.to_dict()},
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
        connector_id=connector_id,
        risk_level=risk_level,
        interaction_id=interaction.id,
    )
    return {
        "approval_id": row.get("id"),
        "interaction_id": interaction.id,
        "approval": row,
    }


def enqueue_tcl_approval(
    command: str,
    *,
    session_id: str,
    task_id: str = "",
    run_id: str = "",
    target_id: str = "",
    policy_reason: str = "",
    event_sink: EventSink = None,
) -> dict[str, Any]:
    payload = {
        "reason": policy_reason or "Tcl command requires approval",
        "action": "Run Vivado Tcl",
        "tcl_command": command,
    }
    if target_id:
        payload["target_id"] = target_id
    return enqueue_vivado_approval(
        approval_type="tcl_execution",
        payload=payload,
        session_id=session_id,
        task_id=task_id,
        run_id=run_id,
        title="Approve Vivado Tcl",
        risk_level="high",
        event_sink=event_sink,
    )
