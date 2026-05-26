"""Phase 6A — ToolManifest from eda.yaml."""

from __future__ import annotations

from pathlib import Path

from edagent_vivado.connectors.base.manifest import manifest_from_eda_yaml, validate_manifest_file

EXAMPLE_MANIFEST = Path(__file__).resolve().parents[2] / "examples" / "uart_demo" / "eda.yaml"


def test_manifest_from_uart_demo():
    if not EXAMPLE_MANIFEST.is_file():
        return
    m = manifest_from_eda_yaml(EXAMPLE_MANIFEST)
    assert m.tool["connector"] == "vivado"
    assert m.design.get("top")
    assert m.design.get("part")
    assert "synth" in m.flow.get("stages", [])


def test_validate_missing_file():
    result = validate_manifest_file("/nonexistent/eda.yaml")
    assert result.ok is False
