"""Human-in-the-loop approval for Vivado agent tools (Phase 3 prerequisite)."""

from __future__ import annotations

from typing import Any, Callable

from edagent_vivado.harness.vivado_agent_registry import is_vivado_execution_tool, vivado_tool_spec
from edagent_vivado.harness.vivado_run_gate import begin_vivado_gate, resolve_vivado_gate
from edagent_vivado.harness.execution_approval import is_vivado_execution_approved

EventCreate = Callable[..., Any]


async def request_vivado_tool_approval(
    tool_name: str,
    tool_input: dict[str, Any],
    *,
    session_id: str,
    task_id: str,
    run_id: str,
    event_create: EventCreate,
) -> bool:
    """Show approval UI and resolve gate. Returns True if execution may proceed."""
    if not is_vivado_execution_tool(tool_name):
        return True
    if is_vivado_execution_approved():
        return True

    spec = vivado_tool_spec(tool_name)
    if not spec:
        return True

    from edagent_vivado.harness.interaction import (
        InteractionType,
        create_interaction,
        wait_for_response,
    )

    from edagent_vivado.harness.approval_payload import (
        build_vivado_approval_payload,
        payload_to_reason_json,
    )

    begin_vivado_gate(task_id, spec.operation)
    payload = build_vivado_approval_payload(tool_name, tool_input, spec)
    interaction = create_interaction(
        InteractionType.APPROVAL,
        session_id,
        task_id,
        title=spec.title,
        message="",
        reason=payload_to_reason_json(payload),
        files=[],
    )
    event_create(
        session_id,
        "interaction.requested",
        interaction.to_dict(),
        task_id=task_id,
        run_id=run_id,
    )
    responded = await wait_for_response(interaction.id)
    approved = bool(responded and responded.status.value == "approved")
    resolve_vivado_gate(task_id, spec.operation, approved)
    return approved
