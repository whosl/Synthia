"""Diff runner — compare two Vivado runs side-by-side."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from edagent_vivado.parsers.timing_parser import parse_timing_summary
from edagent_vivado.parsers.utilization_parser import parse_utilization


class RunDiff:
    """Compare two synthesis/implementation runs and generate a diff report."""

    def __init__(self, run_a_dir: Path, run_b_dir: Path) -> None:
        self._a = run_a_dir
        self._b = run_b_dir

    def compare(self) -> dict[str, Any]:
        """Run all comparisons and return a structured diff."""
        return {
            "run_a": str(self._a),
            "run_b": str(self._b),
            "timing_diff": self._compare_timing(),
            "utilization_diff": self._compare_utilization(),
            "drc_diff": self._compare_drc(),
        }

    def _compare_timing(self) -> dict[str, Any]:
        """Compare timing summaries between two runs."""
        result: dict[str, Any] = {"comparable": False}

        timing_a = self._read_timing(self._a)
        timing_b = self._read_timing(self._b)

        if timing_a and timing_b:
            result["comparable"] = True
            for metric in ("wns", "tns", "whs", "ths"):
                va = getattr(timing_a, metric, None)
                vb = getattr(timing_b, metric, None)
                if va is not None and vb is not None:
                    delta = vb - va
                    result[metric] = {"a": va, "b": vb, "delta": delta}
                    result[f"{metric}_improved"] = (
                        delta > 0
                        if metric == "wns"
                        else delta < 0
                        if metric in ("tns",)
                        else delta > 0
                    )

        elif timing_a:
            result["timing_a"] = {"wns": timing_a.wns, "tns": timing_a.tns}
            result["timing_b"] = "not available"
        elif timing_b:
            result["timing_a"] = "not available"
            result["timing_b"] = {"wns": timing_b.wns, "tns": timing_b.tns}

        return result

    def _compare_utilization(self) -> dict[str, Any]:
        result: dict[str, Any] = {"comparable": False}

        util_a = self._read_utilization(self._a)
        util_b = self._read_utilization(self._b)

        if util_a and util_b:
            result["comparable"] = True
            for metric in ("lut", "ff", "bram", "dsp"):
                va = getattr(util_a, metric, None)
                vb = getattr(util_b, metric, None)
                if va is not None and vb is not None:
                    delta = vb - va
                    result[metric] = {"a": va, "b": vb, "delta": delta}
        elif util_a:
            result["util_a"] = {"lut": util_a.lut, "ff": util_a.ff}
        elif util_b:
            result["util_b"] = {"lut": util_b.lut, "ff": util_b.ff}

        return result

    def _compare_drc(self) -> dict[str, Any]:
        drc_a = self._read_drc(self._a)
        drc_b = self._read_drc(self._b)
        return {
            "run_a_drc_clean": drc_a,
            "run_b_drc_clean": drc_b,
            "regression": drc_a is True and drc_b is False,
        }

    def _read_timing(self, run_dir: Path):
        for name in (
            "reports/post_impl_timing_summary.rpt",
            "reports/post_synth_timing_summary.rpt",
        ):
            p = run_dir / name
            if p.exists():
                return parse_timing_summary(p.read_text(errors="replace"))
        return None

    def _read_utilization(self, run_dir: Path):
        for name in (
            "reports/post_impl_utilization.rpt",
            "reports/post_synth_utilization.rpt",
        ):
            p = run_dir / name
            if p.exists():
                return parse_utilization(p.read_text(errors="replace"))
        return None

    def _read_drc(self, run_dir: Path) -> bool | None:
        for name in (
            "reports/post_impl_drc.rpt",
            "reports/post_synth_drc.rpt",
        ):
            p = run_dir / name
            if p.exists():
                text = p.read_text(errors="replace").lower()
                return "no violation" in text and "violation" not in text.replace("no violation", "")
        return None


def diff_runs(run_a_dir: str | Path, run_b_dir: str | Path, output_json: str | Path | None = None) -> dict[str, Any]:
    """Compare two runs and optionally write JSON output.

    Args:
        run_a_dir: Path to first run workspace.
        run_b_dir: Path to second run workspace.
        output_json: Optional path to write JSON diff.

    Returns:
        Structured diff dict.
    """
    differ = RunDiff(Path(run_a_dir), Path(run_b_dir))
    result = differ.compare()

    if output_json:
        p = Path(output_json)
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "w") as f:
            json.dump(result, f, indent=2, default=str)

    return result
