"""Tests for batch runner and diff runner."""

import tempfile
from pathlib import Path

from edagent_vivado.harness.batch_runner import BatchRunner
from edagent_vivado.harness.diff_runner import diff_runs
from edagent_vivado.harness.manifest import Manifest

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


def test_batch_runner_single():
    runner = BatchRunner(max_workers=1, force_mock=True)
    result = runner.run_all([(str(EXAMPLE_DIR / "eda.yaml"), "synth")])
    assert result.total == 1
    assert result.succeeded == 1


def test_batch_runner_multiple():
    manifest_path = str(EXAMPLE_DIR / "eda.yaml")
    runner = BatchRunner(max_workers=2, force_mock=True)
    result = runner.run_all([
        (manifest_path, "synth"),
        (manifest_path, "synth"),
    ])
    assert result.total == 2
    assert result.succeeded == 2


def test_batch_runner_saves_report():
    manifest_path = str(EXAMPLE_DIR / "eda.yaml")
    runner = BatchRunner(max_workers=1, force_mock=True)
    result = runner.run_all([(manifest_path, "synth")])
    with tempfile.TemporaryDirectory() as tmp:
        report = BatchRunner.save_report(result, Path(tmp) / "report.json")
        assert report.exists()


def test_diff_runs():
    with tempfile.TemporaryDirectory() as tmp:
        run_a = Path(tmp) / "run_a"
        run_b = Path(tmp) / "run_b"
        run_a.mkdir(parents=True)
        run_b.mkdir(parents=True)

        (run_a / "reports").mkdir()
        (run_b / "reports").mkdir()

        (run_a / "reports" / "post_synth_timing_summary.rpt").write_text(
            "WNS=0.123\nTNS=0.000\nWHS=0.045\nTHS=0.000"
        )
        (run_b / "reports" / "post_synth_timing_summary.rpt").write_text(
            "WNS=0.089\nTNS=0.000\nWHS=0.032\nTHS=0.000"
        )

        diff = diff_runs(run_a, run_b)
        assert diff["timing_diff"]["comparable"] is True
        assert diff["timing_diff"]["wns"]["a"] == 0.123
        assert diff["timing_diff"]["wns"]["b"] == 0.089


def test_diff_runs_json_output():
    with tempfile.TemporaryDirectory() as tmp:
        run_a = Path(tmp) / "run_a"
        run_b = Path(tmp) / "run_b"
        run_a.mkdir()
        run_b.mkdir()
        (run_a / "reports").mkdir()
        (run_b / "reports").mkdir()
        (run_a / "reports" / "post_synth_timing_summary.rpt").write_text("WNS=0.1\n")
        (run_b / "reports" / "post_synth_timing_summary.rpt").write_text("WNS=0.2\n")

        output = Path(tmp) / "diff.json"
        diff_runs(run_a, run_b, output_json=output)
        assert output.exists()
