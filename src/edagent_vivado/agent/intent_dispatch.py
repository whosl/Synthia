"""Phase 6 — intent-driven task dispatch from chat (short-circuit agent when appropriate)."""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Any

from edagent_vivado.agent.intent import classify_intent
from edagent_vivado.agent.task_planner import plan_from_intent
from edagent_vivado.projects.snapshot import snapshot_manifest_path
from edagent_vivado.web.schemas.tasks import StartTaskReq

logger = logging.getLogger(__name__)


def intent_dispatch_enabled() -> bool:
    flag = os.environ.get("SYNTHIA_INTENT_DISPATCH", "1").strip().lower()
    return flag not in ("0", "false", "no", "off")


def try_intent_dispatch(
    session_id: str,
    sess: dict,
    task: dict,
    user_message: dict,
    req: StartTaskReq,
    *,
    event_create,
) -> dict[str, Any] | None:
    """Classify intent and optionally start an orchestrator run without the LLM agent.

    Returns an HTTP response body dict when dispatch handled the request, else None
    (caller should continue with the normal agent.graph path).
    """
    if not intent_dispatch_enabled():
        return None

    manifest_path = req.manifest_path or snapshot_manifest_path(sess) or ""
    context = {
        "session_id": session_id,
        "project_id": str(sess.get("project_id") or ""),
        "manifest_path": manifest_path,
    }
    if req.metadata:
        context.update({k: v for k, v in req.metadata.items() if v is not None})

    intent = classify_intent(req.question, context=context)
    plan = plan_from_intent(
        intent,
        session_id=session_id,
        project_id=str(sess.get("project_id") or ""),
        task_id=task["id"],
        user_message_id=str(user_message.get("id") or ""),
    )

    event_create(
        session_id,
        "intent.classified",
        plan,
        task_id=plan.get("task_id", task["id"]),
        run_id=plan.get("run_id", ""),
    )

    action = plan.get("action")

    if action == "ask_missing_info":
        event_create(
            session_id,
            "missing_info_required",
            {
                "ui_kind": "missing_info",
                "block_id": f"missing-{task['id']}",
                "title": "缺少参数",
                "data": {
                    "missing_args": plan.get("missing_args", []),
                    "intent": plan.get("intent"),
                    "task_id": task["id"],
                },
            },
            task_id=task["id"],
        )
        from edagent_vivado.repository.store import task_update

        task_update(
            task["id"],
            state="running",
            metadata_json=json.dumps(
                {"intent": intent.to_dict(), "awaiting_input": True},
                ensure_ascii=False,
            ),
        )
        return {
            "task_id": task["id"],
            "session_id": session_id,
            "state": "running",
            "action": "ask_missing_info",
            "intent": intent.to_dict(),
            "missing_args": plan.get("missing_args", []),
            "stream_url": f"/api/v1/sessions/{session_id}/stream",
        }

    if action == "create_run":
        run_id = str(plan["run_id"])
        flow_name = str(plan["flow_name"])
        task_id = str(plan["task_id"])
        inputs = dict(intent.required_args)

        event_create(
            session_id,
            "custom.run",
            {
                "ui_kind": "run",
                "block_id": f"run-{run_id}",
                "title": flow_name.replace("_", " "),
                "data": {
                    "run_id": run_id,
                    "flow_name": flow_name,
                    "state": "queued",
                    "task_id": task_id,
                },
            },
            task_id=task_id,
            run_id=run_id,
        )

        _start_orchestrator_run_background(
            run_id=run_id,
            flow_name=flow_name,
            inputs=inputs,
            session_id=session_id,
            task_id=task_id,
            event_create=event_create,
        )

        return {
            "task_id": task_id,
            "run_id": run_id,
            "session_id": session_id,
            "state": "running",
            "action": "create_run",
            "intent": intent.to_dict(),
            "flow_name": flow_name,
            "stream_url": f"/api/v1/sessions/{session_id}/stream",
        }

    if action == "show_report":
        from edagent_vivado.repository.store import parsed_report_list

        run_id = str(plan.get("run_id") or (req.metadata or {}).get("run_id") or "")
        reports = parsed_report_list(run_id=run_id) if run_id else []
        return {
            "task_id": task["id"],
            "session_id": session_id,
            "action": "show_report",
            "reports": reports,
            "intent": intent.to_dict(),
            "stream_url": f"/api/v1/sessions/{session_id}/stream",
        }

    # diagnose + chat_reply → fall through to agent
    return None


def _start_orchestrator_run_background(
    *,
    run_id: str,
    flow_name: str,
    inputs: dict[str, Any],
    session_id: str,
    task_id: str,
    event_create,
) -> None:
    """Run orchestrator in a background thread; finalize task when done."""

    def _worker() -> None:
        from edagent_vivado.repository.store import run_update, session_update, task_update
        from edagent_vivado.runs.orchestrator import start_run_serial

        try:
            result = start_run_serial(
                run_id,
                flow_name=flow_name,
                inputs=inputs,
                session_id=session_id,
                task_id=task_id,
                stages=inputs.get("stages") if isinstance(inputs.get("stages"), list) else None,
                background=False,
            )
            final_state = result.state if result else "failed"
            task_update(task_id, state="done", finished_at=int(time.time() * 1000))
            session_update(session_id, status="idle")
            run_update(run_id, state=final_state)
            event_create(session_id, "task.done", {"task_id": task_id}, task_id=task_id)
        except Exception as exc:
            logger.exception("orchestrator run failed for %s", run_id)
            task_update(
                task_id,
                state="error",
                error=str(exc),
                finished_at=int(time.time() * 1000),
            )
            session_update(session_id, status="error")
            event_create(
                session_id,
                "task.error",
                {"task_id": task_id, "error": str(exc)},
                task_id=task_id,
            )

    threading.Thread(
        target=_worker,
        daemon=True,
        name=f"intent-run-{run_id[:8]}",
    ).start()
