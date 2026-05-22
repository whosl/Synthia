"""Tests for run diffing."""

import tempfile
from pathlib import Path

from edagent_vivado.harness.run_diff import RunDiff, diff_runs


def test_run_diff_basic():
    diff = RunDiff(run_a_label="Run A", run_b_label="Run B")
    diff.add("WNS", 0.123, 0.089, lower_is_better=False)
    diff.add("LUT", 1234, 1100, lower_is_better=True)

    assert len(diff.entries) == 2
    assert diff.entries[0].metric == "WNS"
    assert diff.entries[1].metric == "LUT"

    # WNS: 0.123 -> 0.089, lower_is_better=False, so 0.089 < 0.123 means NOT improved
    assert diff.entries[0].improved is False

    # LUT: 1234 -> 1100, lower_is_better=True, 1100 < 1234 means IMPROVED
    assert diff.entries[1].improved is True


def test_run_diff_summary():
    diff = RunDiff(run_a_label="A", run_b_label="B")
    diff.add("WNS", 0.1, 0.2, lower_is_better=False)
    s = diff.summary()
    assert "WNS" in s
    assert "0.1" in s
    assert "0.2" in s
    assert "+0.1" in s


def test_diff_runs_from_workspaces():
    """Integration: create two mock workspaces and diff them."""
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)

        # Run A
        a_dir = base / "run_a"
        (a_dir / "reports").mkdir(parents=True)
        (a_dir / "reports" / "post_synth_timing_summary.rpt").write_text("WNS=0.200\nTNS=0.000\nWHS=0.100\nTHS=0.000\n")
        (a_dir / "reports" / "post_synth_utilization.rpt").write_text("Slice LUTs: 1500\nSlice Registers: 800\nBRAM: 2\nDSP: 0\n")

        # Run B (better)
        b_dir = base / "run_b"
        (b_dir / "reports").mkdir(parents=True)
        (b_dir / "reports" / "post_synth_timing_summary.rpt").write_text("WNS=0.300\nTNS=0.000\nWHS=0.120\nTHS=0.000\n")
        (b_dir / "reports" / "post_synth_utilization.rpt").write_text("Slice LUTs: 1200\nSlice Registers: 700\nBRAM: 2\nDSP: 0\n")

        diff = diff_runs(a_dir, b_dir, "Run A", "Run B", step="synth")
        assert len(diff.entries) >= 4

        # WNS improved (0.2 -> 0.3)
        wns_entry = [e for e in diff.entries if e.metric == "WNS"][0]
        assert wns_entry.improved is True

        # LUT improved (1500 -> 1200)
        lut_entry = [e for e in diff.entries if e.metric == "LUT"][0]
        assert lut_entry.improved is True
