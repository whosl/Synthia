"""Capability helpers."""

from __future__ import annotations

from edagent_vivado.connectors.base.registry import find_capability, list_connectors
from edagent_vivado.connectors.base.types import ToolCapability


def list_all_capabilities(connector_id: str | None = None) -> list[ToolCapability]:
    if connector_id:
        from edagent_vivado.connectors.base.registry import get_connector

        conn = get_connector(connector_id)
        return list(conn.list_capabilities()) if conn else []
    out: list[ToolCapability] = []
    for conn in list_connectors():
        out.extend(conn.list_capabilities())
    return out


def capability_requires_approval(connector_id: str, capability_id: str) -> bool:
    cap = find_capability(connector_id, capability_id)
    return bool(cap and cap.requires_approval)
