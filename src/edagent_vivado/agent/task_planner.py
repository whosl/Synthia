"""Map IntentResult into concrete tasks/runs — Phase 6."""

from __future__ import annotations

import json
import logging
from typing import Any

from edagent_vivado.agent.intent import IntentResult
from edagent_vivado.repository.store import task_create, task_update
from edagent_vivado.runs.orchestrator import create_run

logger = logging.getLogger(__name__)


def plan_from_intent(
    intent: IntentResult,
    *,
    session_id: str,
    project_id: str = "",
    task_id: str = "",
    user_message_id: str = "",
) -> dict[str, Any]:
    """Plan a response from a classified intent.

    Returns a dict with ``action`` one of:
    ``create_run``, ``ask_missing_info``, ``chat_reply``, ``diagnose``,
    ``show_report``.
    """
    response: dict[str, Any] = {
        "action": "chat_reply",
        "intent": intent.to_dict(),
    }

    if intent.needs_clarification():
        response["action"] = "ask_missing_info"
        response["missing_args"] = [
            {
                "key": m.key,
                "prompt": m.prompt,
                "type": m.type,
                "enum_values": m.enum_values,
                "default": m.default,
            }
            for m in intent.missing_args
        ]
        return response

    if intent.task_type == "vivado_run":
        if task_id:
            tid = task_id
        else:
            task = task_create(session_id, user_message_id)
            tid = task["id"]

        flow_name = _flow_for_intent(intent.intent_id)
        inputs = dict(intent.required_args)
        if project_id and "project_id" not in inputs:
            inputs["project_id"] = project_id

        run_id = create_run(
            flow_name=flow_name,
            session_id=session_id,
            task_id=tid,
            inputs=inputs,
        )
        try:
            meta = {
                "intent": intent.to_dict(),
                "flow_name": flow_name,
                "orchestrator_run_id": run_id,
            }
            task_update(tid, metadata_json=json.dumps(meta, ensure_ascii=False))
        except Exception:
            logger.exception("task metadata update failed for %s", tid)

        response["action"] = "create_run"
        response["task_id"] = tid
        response["run_id"] = run_id
        response["flow_name"] = flow_name
        return response

    if intent.task_type == "diagnose":
        if task_id:
            tid = task_id
        else:
            task = task_create(session_id, user_message_id)
            tid = task["id"]
        try:
            task_update(
                tid,
                metadata_json=json.dumps(
                    {"intent": intent.to_dict(), "inputs": intent.required_args},
                    ensure_ascii=False,
                ),
            )
        except Exception:
            pass
        response["action"] = "diagnose"
        response["task_id"] = tid
        return response

    if intent.task_type == "report_query":
        response["action"] = "show_report"
        response["run_id"] = intent.required_args.get("run_id", "")
        return response

    return response


def _flow_for_intent(intent_id: str) -> str:
    mapping = {
        "run_synthesis": "vivado_synth_only",
        "run_implementation": "vivado_synth_impl",
        "run_synth_impl": "vivado_synth_impl",
        "run_full_flow": "vivado_full_flow",
        "generate_bitstream": "vivado_full_flow",
    }
    return mapping.get(intent_id, "vivado_synth_only")
