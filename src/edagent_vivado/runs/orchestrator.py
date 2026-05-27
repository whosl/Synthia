"""Run orchestration — create Run, drive RunSteps, emit events."""

from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any

from edagent_vivado.connectors.base.types import ToolRunRequest, ToolRunResult
from edagent_vivado.runs.flow_definitions import FlowStep, flow_steps_for_stages, get_flow
from edagent_vivado.runs.state_machine import InvalidTransition, assert_transition, is_terminal

logger = logging.getLogger(__name__)


@dataclass
class StartRunResult:
    run_id: str
    state: str
    final_step_states: list[dict[str, Any]]


def _load_run_inputs(run: dict) -> dict[str, Any]:
    meta_raw = run.get("metadata_json") or "{}"
    try:
        meta = json.loads(meta_raw) if isinstance(meta_raw, str) else meta_raw
        if isinstance(meta, dict) and isinstance(meta.get("inputs"), dict):
            return dict(meta["inputs"])
    except json.JSONDecodeError:
        pass
    summary = run.get("input_summary") or ""
    try:
        parsed = json.loads(summary)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return {"manifest_path": summary} if summary else {}


def create_run(
    *,
    flow_name: str,
    session_id: str = "",
    task_id: str = "",
    inputs: dict[str, Any] | None = None,
) -> str:
    """Create a Run record; return run_id."""
    from edagent_vivado.repository.store import run_create, run_update
    from edagent_vivado.web.api_shared import event_create

    inputs = dict(inputs or {})
    flow = get_flow(flow_name)
    run = run_create(
        flow_name,
        name=flow_name.replace("_", " "),
        session_id=session_id,
        task_id=task_id,
    )
    run_id = run["id"]
    run_update(
        run_id,
        state="created",
        input_summary=json.dumps(inputs, ensure_ascii=False)[:2000],
        metadata_json=json.dumps({"flow_name": flow_name, "inputs": inputs}, ensure_ascii=False),
    )
    if session_id:
        event_create(
            session_id,
            "run.created",
            {"run_id": run_id, "flow_name": flow_name, "step_count": len(flow)},
            task_id=task_id,
            run_id=run_id,
        )
    return run_id


def start_run(
    run_id: str,
    *,
    flow_name: str,
    inputs: dict[str, Any],
    session_id: str = "",
    task_id: str = "",
    stages: list[str] | None = None,
) -> StartRunResult:
    """Synchronously execute each step of a flow via execute_with_steps."""
    from edagent_vivado.connectors.run_execution import execute_with_steps
    from edagent_vivado.harness.execution_approval import is_vivado_execution_approved
    from edagent_vivado.repository.store import run_get, run_update
    from edagent_vivado.web.api_shared import event_create

    run = run_get(run_id)
    if not run:
        raise ValueError(f"run not found: {run_id}")

    session_id = session_id or str(run.get("session_id") or "")
    task_id = task_id or str(run.get("task_id") or "")
    flow = flow_steps_for_stages(flow_name, stages)
    merged_inputs = {**_load_run_inputs(run), **inputs}

    def _transition(state: str, **fields: Any) -> None:
        prev = (run_get(run_id) or {}).get("state") or "created"
        # strict by default; raises InvalidTransition on illegal moves.
        assert_transition(prev, state)
        run_update(run_id, state=state, **fields)

    _transition("queued")
    if session_id:
        event_create(session_id, "run.queued", {"run_id": run_id}, task_id=task_id, run_id=run_id)

    _transition("running", started_at=int(time.time() * 1000))
    if session_id:
        event_create(session_id, "run.started", {"run_id": run_id}, task_id=task_id, run_id=run_id)

    step_states: list[dict[str, Any]] = []
    overall_state = "succeeded"
    error_msg = ""
    optional_failed = 0

    for step in flow:
        if step.requires_approval and not is_vivado_execution_approved():
            _transition("waiting_for_approval")
            if session_id:
                event_create(
                    session_id,
                    "run.waiting_for_approval",
                    {
                        "run_id": run_id,
                        "step_key": step.key,
                        "capability_id": step.capability_id,
                    },
                    task_id=task_id,
                    run_id=run_id,
                )
            return StartRunResult(
                run_id=run_id,
                state="waiting_for_approval",
                final_step_states=step_states,
            )

        cap_inputs = {
            **merged_inputs,
            "session_id": session_id,
            "task_id": task_id,
            "run_id": run_id,
        }
        if step.capability_id == "run_implementation":
            synth_ok = any(s.get("key") == "synth" and s.get("state") == "succeeded" for s in step_states)
            cap_inputs["run_synth_first"] = not synth_ok

        req = ToolRunRequest(
            request_id=str(uuid.uuid4()),
            run_id=run_id,
            step_id="",
            connector_id="vivado",
            capability_id=step.capability_id,
            inputs=cap_inputs,
            manifest_path=str(merged_inputs.get("manifest_path") or "") or None,
            auto_approved=False,
        )

        try:
            result = execute_with_steps(req, event_sink=event_create)
        except Exception as exc:
            logger.exception("step %s crashed", step.key)
            result = None
            overall_state = "failed"
            error_msg = f"step {step.key} crashed: {exc}"
            step_states.append({"key": step.key, "state": "failed", "error": str(exc)})
            if step.required:
                break
            optional_failed += 1
            continue

        ok = bool(result and result.success)
        if result and result.edagent_outcome == "needs_approval":
            _transition("waiting_for_approval")
            if session_id:
                event_create(
                    session_id,
                    "run.waiting_for_approval",
                    {"run_id": run_id, "step_key": step.key},
                    task_id=task_id,
                    run_id=run_id,
                )
            return StartRunResult(
                run_id=run_id,
                state="waiting_for_approval",
                final_step_states=step_states,
            )
        if result and result.edagent_outcome == "policy_denied":
            overall_state = "policy_denied"
            error_msg = result.error or "policy denied"
            step_states.append({"key": step.key, "state": "failed", "error": error_msg})
            break

        step_states.append({
            "key": step.key,
            "state": "succeeded" if ok else "failed",
            "error": (result.error if result else "") or "",
            "artifacts": len(result.artifacts) if result else 0,
        })

        if not ok:
            if step.required:
                overall_state = "failed"
                error_msg = (result.error if result else "") or "step failed"
                break
            optional_failed += 1

    if overall_state == "succeeded" and optional_failed:
        overall_state = "succeeded_with_warnings"

    finished = int(time.time() * 1000)
    prev_state = (run_get(run_id) or {}).get("state") or "running"
    # Final transition through strict state machine.
    assert_transition(prev_state, overall_state)
    run_update(
        run_id,
        state=overall_state,
        finished_at=finished,
        elapsed_ms=finished - int((run_get(run_id) or {}).get("started_at") or finished),
        output_summary=f"{len(step_states)} steps, state={overall_state}",
        error=error_msg or None,
    )

    try:
        from edagent_vivado.runs.summary import write_summary_md

        write_summary_md(run_id)
    except Exception:
        logger.exception("write_summary_md failed for run %s", run_id)

    if session_id:
        evt = "run.succeeded" if overall_state in ("succeeded", "succeeded_with_warnings") else "run.failed"
        event_create(
            session_id,
            evt,
            {
                "run_id": run_id,
                "final_state": overall_state,
                "step_count": len(step_states),
            },
            task_id=task_id,
            run_id=run_id,
        )

    return StartRunResult(run_id=run_id, state=overall_state, final_step_states=step_states)


def start_run_serial(
    run_id: str,
    *,
    flow_name: str,
    inputs: dict[str, Any],
    session_id: str = "",
    task_id: str = "",
    stages: list[str] | None = None,
    background: bool = False,
    timeout: float | None = None,
) -> StartRunResult | None:
    """Run *start_run* under the per-session scheduler lock (Phase 5.5).

    background=True spawns a daemon worker and returns None immediately.
    Foreground callers may pass ``timeout`` (seconds) to fail fast with
    :class:`SessionBusy` instead of blocking forever.

    When ``SYNTHIA_USE_WORKER_QUEUE=1`` and Redis (or memory queue) is available,
    enqueues the run for a worker instead of executing in-process (Phase 11).
    """
    from edagent_vivado.scheduler.scheduler import submit_run, worker_queue_enabled

    if worker_queue_enabled():
        submit_run(
            run_id,
            flow_name,
            inputs,
            session_id=session_id,
            task_id=task_id,
        )
        return None

    from edagent_vivado.runs.scheduler import run_in_session, start_run_async

    def _do() -> StartRunResult:
        return start_run(
            run_id,
            flow_name=flow_name,
            inputs=inputs,
            session_id=session_id,
            task_id=task_id,
            stages=stages,
        )

    if background:
        start_run_async(session_id, _do)
        return None
    return run_in_session(session_id, _do, timeout=timeout)


def cancel_run(run_id: str, *, reason: str = "user requested") -> bool:
    from edagent_vivado.repository.store import run_get, run_update
    from edagent_vivado.web.api_shared import event_create

    run = run_get(run_id)
    if not run:
        return False
    state = str(run.get("state") or "")
    if is_terminal(state):
        return False
    try:
        assert_transition(state, "cancelled")
    except InvalidTransition:
        logger.warning("cannot cancel run in state %s", state)
        return False
    run_update(
        run_id,
        state="cancelled",
        finished_at=int(time.time() * 1000),
        error=f"cancelled: {reason}",
    )
    sid = str(run.get("session_id") or "")
    if sid:
        event_create(
            sid,
            "run.cancelled",
            {"run_id": run_id, "reason": reason},
            run_id=run_id,
        )
    return True


def resume_run(run_id: str) -> StartRunResult:
    from edagent_vivado.repository.store import run_get

    run = run_get(run_id)
    if not run:
        raise ValueError(f"run not found: {run_id}")
    if run.get("state") != "waiting_for_approval":
        raise ValueError(f"run not waiting: state={run.get('state')}")
    meta = json.loads(run.get("metadata_json") or "{}")
    flow_name = str(meta.get("flow_name") or run.get("run_type") or "vivado_synth_only")
    inputs = _load_run_inputs(run)
    from edagent_vivado.repository.store import run_update

    run_update(run_id, state="running")
    return start_run(
        run_id,
        flow_name=flow_name,
        inputs=inputs,
        session_id=str(run.get("session_id") or ""),
        task_id=str(run.get("task_id") or ""),
        stages=inputs.get("stages") if isinstance(inputs.get("stages"), list) else None,
    )
