"""Connector registry — SPEC §9B.3."""

from __future__ import annotations

from edagent_vivado.connectors.base.types import ToolCapability, ToolConnector

_REGISTRY: dict[str, ToolConnector] = {}


def register_connector(connector: ToolConnector) -> None:
    cid = connector.connector_id
    if cid in _REGISTRY:
        raise ValueError(f"duplicate connector id: {cid}")
    _REGISTRY[cid] = connector


def unregister_connector(connector_id: str) -> None:
    _REGISTRY.pop(connector_id, None)


def get_connector(connector_id: str) -> ToolConnector | None:
    return _REGISTRY.get(connector_id)


def list_connectors() -> list[ToolConnector]:
    return list(_REGISTRY.values())


def find_capability(connector_id: str, capability_id: str) -> ToolCapability | None:
    conn = get_connector(connector_id)
    if not conn:
        return None
    for cap in conn.list_capabilities():
        if cap.capability_id == capability_id:
            return cap
    return None


def clear_registry() -> None:
    """Test helper — reset all registered connectors."""
    _REGISTRY.clear()
    try:
        import edagent_vivado.connectors as conn_pkg

        conn_pkg._registered = False  # type: ignore[attr-defined]
    except Exception:
        pass
