"""Observed Vivado execution for REST/UI paths (Phase 3 prerequisite)."""

from __future__ import annotations

import json
import time
from typing import Any, Callable

from edagent_vivado.harness.approval_outcomes import tool_ui_state_from_output
from edagent_vivado.harness.problem_collector import collect_from_tool_output, record_problems
from edagent_vivado.harness.kb_candidate_policy import maybe_create_kb_candidate
from edagent_vivado.repository.store import toolcall_create, toolcall_update

EventCreate = Callable[..., Any]


def observe_vivado_command(
    *,
    session_id: str,
    task_id: str,
    run_id: str,
    tool_name: str,
    input_payload: dict[str, Any],
    output: str,
    event_create: EventCreate | None = None,
) -> dict[str, Any]:
    """Persist toolcall + events + problems for a Vivado command (REST or internal)."""
    args_str = json.dumps(input_payload, ensure_ascii=False, default=str)[:1500]
    tc = toolcall_create(
        run_id=run_id or "",
        tool_name=tool_name,
        session_id=session_id,
        task_id=task_id,
        input_summary=args_str,
    )
    tcid = tc["id"]
    ui_state = tool_ui_state_from_output(output)

    if event_create and session_id:
        event_create(
            session_id,
            "tool.started",
            {"tool_name": tool_name, "toolcall_id": tcid, "args": args_str},
            task_id=task_id or None,
            run_id=run_id or None,
        )

    toolcall_update(
        tcid,
        state="completed" if ui_state != "error" else "error",
        finished_at=int(time.time()),
        output_summary=output[:500],
    )

    if event_create and session_id:
        event_create(
            session_id,
            "tool.completed",
            {
                "tool_name": tool_name,
                "toolcall_id": tcid,
                "result": output[:500],
                "state": ui_state,
            },
            task_id=task_id or None,
            run_id=run_id or None,
        )

    if session_id and output and ui_state in ("completed", "error", "rejected"):
        probs = collect_from_tool_output(tool_name, output)
        if probs:
            saved = record_problems(
                session_id,
                probs,
                task_id=task_id,
                run_id=run_id,
                event_sink=(
                    lambda et, pl: event_create(session_id, et, pl, task_id=task_id, run_id=run_id)
                    if event_create
                    else None
                ),
            )
            for p in saved:
                if event_create and p.get("severity") in ("error", "critical"):
                    cand = maybe_create_kb_candidate(p)
                    if cand:
                        event_create(
                            session_id,
                            "kb.candidate.created",
                            {
                                "candidate_id": cand["id"],
                                "problem_id": p.get("id"),
                                "pattern": cand.get("pattern"),
                            },
                            task_id=task_id,
                            run_id=run_id,
                        )

    return {"toolcall_id": tcid, "state": ui_state}
