"""Run step lifecycle around connector capability execution."""

from __future__ import annotations

import time
from typing import Any, Callable

from edagent_vivado.connectors.base.registry import get_connector
from edagent_vivado.connectors.base.types import PreparedRun, ToolRunRequest, ToolRunResult
from edagent_vivado.repository.store import run_step_create, run_step_update

EventSink = Callable[..., Any] | None


def execute_with_steps(
    request: ToolRunRequest,
    *,
    event_sink: EventSink = None,
) -> ToolRunResult:
    conn = get_connector(request.connector_id)
    if not conn:
        return ToolRunResult(
            request_id=request.request_id,
            success=False,
            exit_code=1,
            error=f"connector not found: {request.connector_id}",
            edagent_outcome="execution_failed",
        )

    cap = None
    for c in conn.list_capabilities():
        if c.capability_id == request.capability_id:
            cap = c
            break
    stage = cap.stage if cap else "run"
    name = cap.display_name if cap else request.capability_id

    step = run_step_create(
        request.run_id,
        session_id=str(request.inputs.get("session_id") or ""),
        task_id=str(request.inputs.get("task_id") or ""),
        connector_id=request.connector_id,
        capability_id=request.capability_id,
        stage=stage,
        name=name,
    )
    step_id = step["id"]
    inputs = dict(request.inputs)
    if request.run_id:
        try:
            from edagent_vivado.harness.run_workspace import ensure_run_workspace

            ws = ensure_run_workspace(request.run_id)
            inputs["workspace_root"] = str(ws.root)
        except Exception:
            pass
    if cap and not cap.requires_approval:
        effective_auto = True
    elif cap and cap.requires_approval:
        from edagent_vivado.harness.execution_approval import is_vivado_execution_approved

        effective_auto = is_vivado_execution_approved()
    else:
        effective_auto = request.auto_approved

    request = ToolRunRequest(
        request_id=request.request_id,
        run_id=request.run_id,
        step_id=step_id,
        connector_id=request.connector_id,
        capability_id=request.capability_id,
        inputs=inputs,
        manifest_path=request.manifest_path,
        target_id=request.target_id,
        auto_approved=effective_auto,
    )

    session_id = str(request.inputs.get("session_id") or "")
    task_id = str(request.inputs.get("task_id") or "")
    if event_sink and session_id:
        event_sink(
            session_id,
            "run.step.started",
            {
                "step_id": step_id,
                "run_id": request.run_id,
                "connector_id": request.connector_id,
                "capability_id": request.capability_id,
                "stage": stage,
            },
            task_id=task_id or None,
            run_id=request.run_id,
        )
        event_sink(
            session_id,
            "connector.capability.invoked",
            {
                "step_id": step_id,
                "connector_id": request.connector_id,
                "capability_id": request.capability_id,
            },
            task_id=task_id or None,
            run_id=request.run_id,
        )

    run_step_update(step_id, state="running")
    started = int(time.time())
    prepared = conn.prepare_run(request)
    try:
        from edagent_vivado.connectors.base.execution import command_request_from_prepared
        from edagent_vivado.repository.store import tool_run_request_create

        cmd = command_request_from_prepared(prepared)
        tool_run_request_create(
            request.run_id,
            request.connector_id,
            request.capability_id,
            step_id=step_id,
            command_id=cmd.command_id,
            executable=cmd.executable,
            args=cmd.args,
            cwd=cmd.cwd,
            env_profile=cmd.env_profile,
            allowed_paths=cmd.allowed_paths,
            timeout_sec=cmd.timeout_sec,
            state="running",
        )
    except Exception:
        pass
    result = conn.execute(prepared)
    finished = int(time.time())
    elapsed_ms = (finished - started) * 1000

    state = "completed" if result.success else "failed"
    run_step_update(
        step_id,
        state=state,
        finished_at=finished,
        elapsed_ms=elapsed_ms,
        error=result.error or None,
    )

    if event_sink and session_id:
        evt = "run.step.completed" if result.success else "run.step.failed"
        event_sink(
            session_id,
            evt,
            {
                "step_id": step_id,
                "run_id": request.run_id,
                "success": result.success,
                "elapsed_ms": elapsed_ms,
            },
            task_id=task_id or None,
            run_id=request.run_id,
        )

    return result
