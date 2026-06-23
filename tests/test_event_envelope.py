from edagent_vivado.events.envelope import enrich_wire_event, to_canonical_type
from edagent_vivado.events.catalog import PROTOCOL_VERSION, ALL_WIRE_EVENT_TYPES


def test_to_canonical_custom():
    assert to_canonical_type("custom.metrics") == "CUSTOM"
    assert to_canonical_type("tool.started") == "TOOL_CALL_START"
    assert to_canonical_type("run.error") == "RUN_ERROR"


def test_enrich_wire_event():
    raw = {"id": "e1", "event_type": "message.assistant.delta", "seq": 3, "payload_json": "{}"}
    out = enrich_wire_event(raw)
    assert out["protocol_version"] == PROTOCOL_VERSION
    assert out["canonical_type"] == "TEXT_MESSAGE_CONTENT"
    assert out["event_type"] == "message.assistant.delta"


def test_catalog_includes_context_package():
    assert "context.package.created" in ALL_WIRE_EVENT_TYPES
