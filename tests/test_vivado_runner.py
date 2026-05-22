"""Tests for VivadoRunner mock failure injection and new features."""

import tempfile
from pathlib import Path

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.vivado_runner import VivadoRunner, MOCK_FAILURE_SCENARIOS
from edagent_vivado.harness.workspace import Workspace

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


def _make_runner(mock_fail=None):
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    ws = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="test_synth")
    ws.copy_sources(manifest)
    ws.write_manifest(manifest)
    return VivadoRunner(workspace=ws, manifest=manifest, force_mock=True, mock_fail=mock_fail), ws


def test_mock_scenarios_exist():
    assert len(MOCK_FAILURE_SCENARIOS) >= 5
    for name in ["synth_8_439", "timing_violation", "place_30_574", "drc_violation", "route_35"]:
        assert name in MOCK_FAILURE_SCENARIOS


def test_mock_synth_success():
    runner, ws = _make_runner(mock_fail=None)
    result = runner.run_synth()
    assert result["success"]


def test_mock_synth_fail_scenario():
    runner, ws = _make_runner(mock_fail="synth_8_439")
    result = runner.run_synth()
    assert not result["success"]
    assert result["mock_fail"] == "synth_8_439"


def test_mock_timing_violation():
    runner, ws = _make_runner(mock_fail="timing_violation")
    result = runner.run_synth()
    assert result["success"]  # succeeds, but timing bad
    log_content = Path(result["log"]).read_text()
    assert "Timing 38-282" in log_content


def test_mock_place_fail():
    runner, ws = _make_runner(mock_fail="place_30_574")
    result = runner.run_impl()
    assert not result["success"]


def test_mock_simulation():
    import yaml
    tb_dir = Path(tempfile.mkdtemp())
    tb_file = tb_dir / "tb_top.v"
    tb_file.write_text("module tb_top; endmodule")
    yaml_path = tb_dir / "eda.yaml"
    yaml.dump({
        "project": {"name": "sim_test", "part": "xc7a50t", "top": "top"},
        "sources": {"rtl": [], "tb": ["tb_top.v"]},
        "constraints": {"xdc": []},
    }, open(yaml_path, "w"))
    manifest = Manifest.load(yaml_path)
    ws = Workspace(base_dir=Path(tempfile.mkdtemp()), task_name="test_sim")
    runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True)
    result = runner.run_simulation()
    assert result["success"]
    assert result["mock"]
