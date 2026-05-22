"""Tests for mock failure injection in VivadoRunner."""

import tempfile
from pathlib import Path

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.vivado_runner import VivadoRunner, MOCK_FAILURE_SCENARIOS
from edagent_vivado.harness.workspace import Workspace

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


def _make_runner(mock_fail=None):
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    ws = Workspace(base_dir=EXAMPLE_DIR, task_name="test_mock")
    runner = VivadoRunner(workspace=ws, manifest=manifest, force_mock=True, mock_fail=mock_fail)
    return runner, ws


def test_mock_failure_scenarios_exist():
    assert len(MOCK_FAILURE_SCENARIOS) >= 5
    assert "synth_8_439" in MOCK_FAILURE_SCENARIOS
    assert "timing_violation" in MOCK_FAILURE_SCENARIOS


def test_mock_synth_success():
    runner, _ = _make_runner(mock_fail=None)
    result = runner.run_synth()
    assert result["success"] is True
    assert result["mock"] is True
    assert result["return_code"] == 0


def test_mock_synth_8_439_failure():
    runner, _ = _make_runner(mock_fail="synth_8_439")
    result = runner.run_synth()
    assert result["success"] is False
    assert result["mock"] is True
    assert result["return_code"] == 1


def test_mock_timing_violation():
    runner, _ = _make_runner(mock_fail="timing_violation")
    result = runner.run_synth()
    assert result["success"] is True
    timing_report = (
        runner._workspace.report_path("post_synth_timing_summary.rpt").read_text()
    )
    assert "-2.350" in timing_report or "WNS" in timing_report


def test_mock_impl_place_failure():
    runner, _ = _make_runner(mock_fail="place_30_574")
    result = runner.run_impl()
    assert result["success"] is False


def test_mock_drc_violation():
    runner, _ = _make_runner(mock_fail="drc_violation")
    result = runner.run_impl()
    assert result["success"] is True
    drc_report = (
        runner._workspace.report_path("post_impl_drc.rpt").read_text()
    )
    assert "violation" in drc_report.lower()


def test_mock_route_failure():
    runner, _ = _make_runner(mock_fail="route_35")
    result = runner.run_impl()
    assert result["success"] is False
    assert result["return_code"] == 2
