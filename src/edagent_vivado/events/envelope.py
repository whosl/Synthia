"""Enrich persisted + SSE events with protocol metadata."""

from __future__ import annotations

import json
from typing import Any

from edagent_vivado.events.catalog import CANONICAL_BY_WIRE_TYPE, PROTOCOL_VERSION


def to_canonical_type(wire_type: str) -> str:
    if wire_type.startswith("custom."):
        return "CUSTOM"
    return CANONICAL_BY_WIRE_TYPE.get(wire_type, "RAW")


def enrich_wire_event(evt: dict[str, Any]) -> dict[str, Any]:
    """Attach envelope fields for clients (SSE + REST). Does not change DB columns."""
    out = dict(evt)
    wire = str(out.get("event_type") or "")
    out["protocol_version"] = PROTOCOL_VERSION
    out["canonical_type"] = to_canonical_type(wire)
    payload = out.get("payload")
    if payload is None and out.get("payload_json"):
        try:
            payload = json.loads(out["payload_json"])
        except (json.JSONDecodeError, TypeError):
            payload = {}
    if isinstance(payload, dict):
        out["payload"] = payload
    return out
