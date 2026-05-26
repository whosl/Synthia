"""Run step lifecycle around connector capability execution."""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

from edagent_vivado.connectors.base.registry import get_connector
from edagent_vivado.connectors.base.types import PreparedRun, ToolRunRequest, ToolRunResult
from edagent_vivado.repository.store import run_step_create, run_step_update

logger = logging.getLogger(__name__)

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
    result: ToolRunResult | None = None

    try:
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
            logger.exception("tool_run_request_create failed (non-fatal)")

        result = conn.execute(prepared)
    except Exception as exc:
        logger.exception("connector.execute crashed: %s", exc)
        result = ToolRunResult(
            request_id=request.request_id,
            success=False,
            exit_code=1,
            error=f"execute crashed: {exc}",
            edagent_outcome="execution_failed",
        )
    finally:
        finished = int(time.time())
        elapsed_ms = (finished - started) * 1000
        success = bool(result and result.success)
        run_step_update(
            step_id,
            state="completed" if success else "failed",
            finished_at=finished,
            elapsed_ms=elapsed_ms,
            error=(result.error if result else "unknown error") or None,
        )
        if event_sink and session_id:
            evt = "run.step.completed" if success else "run.step.failed"
            event_sink(
                session_id,
                evt,
                {
                    "step_id": step_id,
                    "run_id": request.run_id,
                    "success": success,
                    "elapsed_ms": elapsed_ms,
                    "error": (result.error if result and not success else "") or "",
                },
                task_id=task_id or None,
                run_id=request.run_id,
            )
        if result and result.artifacts:
            try:
                from edagent_vivado.harness.register_artifact import persist_result_artifacts

                persist_result_artifacts(request, result.artifacts)
            except Exception:
                logger.exception("persist_result_artifacts failed (non-fatal)")

    return result or ToolRunResult(
        request_id=request.request_id,
        success=False,
        exit_code=1,
        error="no result",
        edagent_outcome="execution_failed",
    )
