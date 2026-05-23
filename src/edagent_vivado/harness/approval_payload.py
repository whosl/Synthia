"""Structured approval request payload (JSON) for Vivado/file HITL UI."""

from __future__ import annotations

import json
from typing import Any

from edagent_vivado.harness.vivado_agent_registry import VivadoAgentToolSpec

# Field order for UI (flat rows)
APPROVAL_FIELD_ORDER = (
    "reason",
    "action",
    "manifest_path",
    "tcl_command",
    "script",
    "target_id",
)


def _parse_llm_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    if text.startswith("{"):
        try:
            parsed = json.loads(text)
            return parsed if isinstance(parsed, dict) else {"reason": text}
        except json.JSONDecodeError:
            return {"reason": text}
    return {"reason": text}


def build_vivado_approval_payload(
    tool_name: str,
    tool_input: dict[str, Any],
    spec: VivadoAgentToolSpec,
) -> dict[str, Any]:
    """Merge LLM JSON (approval_reason / approval_request) with tool args."""
    raw = str(
        tool_input.get("approval_request")
        or tool_input.get("approval_reason")
        or ""
    ).strip()
    payload = _parse_llm_json(raw)
    payload.setdefault("action", spec.title)
    if tool_input.get("manifest_path"):
        payload.setdefault("manifest_path", str(tool_input["manifest_path"]))
    if tool_input.get("command"):
        payload.setdefault("tcl_command", str(tool_input["command"]))
    if tool_input.get("script"):
        payload.setdefault("script", str(tool_input["script"]))
    if tool_input.get("target_id"):
        payload.setdefault("target_id", str(tool_input["target_id"]))
    if not payload.get("reason"):
        payload["reason"] = spec.message_prefix
    for drop in ("details", "message", "说明", "description"):
        payload.pop(drop, None)
    return {k: v for k, v in payload.items() if v not in (None, "", [])}


def build_file_approval_payload(
    title: str,
    message: str,
    files: list[dict[str, Any]],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "reason": message or title,
        "action": title,
    }
    if files:
        payload["files"] = [
            {
                "path": f.get("path", ""),
                "action": f.get("action", "modify"),
                "description": f.get("description", ""),
            }
            for f in files
        ]
    return payload


def payload_to_reason_json(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False)
