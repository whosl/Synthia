"""Tests for CLI diagnostic and synth commands."""

import tempfile
from pathlib import Path

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.vivado_runner import VivadoRunner
from edagent_vivado.harness.workspace import Workspace
from edagent_vivado.parsers.timing_parser import load_timing
from edagent_vivado.parsers.utilization_parser import load_utilization
from edagent_vivado.parsers.vivado_log_parser import load_and_parse

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


def test_manifest_reload():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    assert manifest.name() == "uart_demo"
    assert manifest.top() == "uart_top"


def test_workspace_creation():
    with tempfile.TemporaryDirectory() as tmp:
        ws = Workspace(base_dir=tmp, task_name="test")
        assert ws.root.exists()
        assert (ws.root / "reports").exists()
        assert (ws.root / "artifacts").exists()
        assert (ws.root / "scripts").exists()
        assert (ws.root / "checkpoints").exists()
        assert (ws.root / "agent_notes").exists()


def test_workspace_copy_sources():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    with tempfile.TemporaryDirectory() as tmp:
        ws = Workspace(base_dir=tmp, task_name="test")
        ws.copy_sources(manifest)
        ws.write_manifest(manifest)
        assert (ws.root / "input_manifest.yaml").exists()
        src_dir = ws.root / "src"
        assert src_dir.exists()


def test_vivado_runner_mock_synth_with_parse():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    with tempfile.TemporaryDirectory() as tmp:
        ws = Workspace(base_dir=tmp, task_name="test")
        ws.copy_sources(manifest)
        runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True)
        result = runner.run_synth()
        assert result["success"] is True
        assert result["mock"] is True
        assert "timing" in result
        assert "utilization" in result
        assert result["timing"]["wns"] == 0.123


def test_vivado_runner_mock_synth_failure_parse():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    with tempfile.TemporaryDirectory() as tmp:
        ws = Workspace(base_dir=tmp, task_name="test")
        ws.copy_sources(manifest)
        runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True, mock_fail="synth_8_439")
        result = runner.run_synth()
        assert result["success"] is False
        assert "log_summary" in result
        assert result["log_summary"]["error_count"] == 2


def test_vivado_runner_simulation_mock():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    manifest.sources.tb = ["tb/top_tb.v"]
    with tempfile.TemporaryDirectory() as tmp:
        ws = Workspace(base_dir=tmp, task_name="test")
        runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True)
        result = runner.run_simulation("top_tb")
        assert result["success"] is True
        assert result["mock"] is True


def test_log_parser_integration():
    summary = load_and_parse(EXAMPLE_DIR / "logs" / "sample_vivado_error.log")
    assert summary.error_count == 2
    assert summary.critical_warning_count == 2
    assert len(summary.top_error_signatures) > 0
