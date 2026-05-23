"""Session event envelope — wire protocol v1 (AG-UI–aligned subset)."""

from edagent_vivado.events.catalog import ALL_WIRE_EVENT_TYPES, PROTOCOL_VERSION
from edagent_vivado.events.envelope import enrich_wire_event, to_canonical_type

__all__ = [
    "ALL_WIRE_EVENT_TYPES",
    "PROTOCOL_VERSION",
    "enrich_wire_event",
    "to_canonical_type",
]
