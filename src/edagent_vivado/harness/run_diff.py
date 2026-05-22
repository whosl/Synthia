"""Run diffing — compare two synthesis/implementation runs."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from edagent_vivado.parsers.timing_parser import TimingSummary, load_timing
from edagent_vivado.parsers.utilization_parser import UtilizationSummary, load_utilization


@dataclass
class DiffEntry:
    metric: str
    run_a_value: str
    run_b_value: str
    delta: str
    improved: Optional[bool] = None  # True = A→B improved, None = neutral


@dataclass
class RunDiff:
    """Comparison of two synthesis/implementation runs."""

    run_a_label: str
    run_b_label: str
    entries: list[DiffEntry] = field(default_factory=list)

    def add(self, metric: str, a_val, b_val, lower_is_better: bool = True) -> None:
        """Add a diff entry, auto-computing whether it's an improvement."""
        a_str = f"{a_val:.3f}" if isinstance(a_val, float) else str(a_val)
        b_str = f"{b_val:.3f}" if isinstance(b_val, float) else str(b_val)

        if isinstance(a_val, (int, float)) and isinstance(b_val, (int, float)):
            delta_val = b_val - a_val
            delta_str = f"{delta_val:+.3f}" if isinstance(delta_val, float) else f"{delta_val:+d}"
            if lower_is_better:
                improved = delta_val < 0
            else:
                improved = delta_val > 0
        else:
            delta_str = "N/A"
            improved = None

        self.entries.append(DiffEntry(
            metric=metric,
            run_a_value=a_str,
            run_b_value=b_str,
            delta=delta_str,
            improved=improved,
        ))

    def summary(self) -> str:
        """Return a Markdown table string."""
        lines = [
            f"| Metric | {self.run_a_label} | {self.run_b_label} | Delta |",
            f"|--------|{'--' * len(self.run_a_label)}-|{'--' * len(self.run_b_label)}-|-------|",
        ]
        for e in self.entries:
            icon = " :arrow_down:" if e.improved is True else (" :arrow_up:" if e.improved is False else "")
            lines.append(f"| {e.metric} | {e.run_a_value} | {e.run_b_value} | {e.delta}{icon} |")
        return "\n".join(lines)


def diff_runs(
    run_a_workspace: Path,
    run_b_workspace: Path,
    run_a_label: str = "Run A",
    run_b_label: str = "Run B",
    step: str = "synth",
) -> RunDiff:
    """Compare two workspace runs by parsing their timing and utilization reports.

    Args:
        run_a_workspace: Path to the first workspace/reports directory.
        run_b_workspace: Path to the second workspace/reports directory.
        run_a_label: Label for the first run.
        run_b_label: Label for the second run.
        step: 'synth' or 'impl'.

    Returns:
        RunDiff with per-metric comparison.
    """
    prefix = f"post_{step}"
    diff = RunDiff(run_a_label=run_a_label, run_b_label=run_b_label)

    # Timing
    a_timing = load_timing(run_a_workspace / "reports" / f"{prefix}_timing_summary.rpt")
    b_timing = load_timing(run_b_workspace / "reports" / f"{prefix}_timing_summary.rpt")

    for field_name, label in [("wns", "WNS"), ("tns", "TNS"), ("whs", "WHS"), ("ths", "THS")]:
        a_val = getattr(a_timing, field_name) if a_timing else None
        b_val = getattr(b_timing, field_name) if b_timing else None
        if a_val is not None and b_val is not None:
            diff.add(label, a_val, b_val, lower_is_better=False)

    # Utilization
    a_util = load_utilization(run_a_workspace / "reports" / f"{prefix}_utilization.rpt")
    b_util = load_utilization(run_b_workspace / "reports" / f"{prefix}_utilization.rpt")

    for field_name, label in [("lut", "LUT"), ("ff", "FF"), ("bram", "BRAM"), ("dsp", "DSP")]:
        a_val = getattr(a_util, field_name) if a_util else None
        b_val = getattr(b_util, field_name) if b_util else None
        if a_val is not None and b_val is not None:
            diff.add(label, a_val, b_val, lower_is_better=True)

    return diff


def diff_runs_from_artifacts(
    run_a_dir: Path,
    run_b_dir: Path,
    run_a_label: str = "Run A",
    run_b_label: str = "Run B",
) -> RunDiff:
    """Compare two runs using their artifact JSON files."""
    diff = RunDiff(run_a_label=run_a_label, run_b_label=run_b_label)

    for artifact_name in ("synth_qor", "impl_qor"):
        a_path = run_a_dir / "artifacts" / f"{artifact_name}.json"
        b_path = run_b_dir / "artifacts" / f"{artifact_name}.json"
        if a_path.exists() and b_path.exists():
            a_data = json.loads(a_path.read_text())
            b_data = json.loads(b_path.read_text())

            if a_data.get("timing") and b_data.get("timing"):
                for k in ("wns", "tns", "whs", "ths"):
                    a_v = a_data["timing"].get(k)
                    b_v = b_data["timing"].get(k)
                    if a_v is not None and b_v is not None:
                        diff.add(k.upper(), a_v, b_v, lower_is_better=False)

            if a_data.get("utilization") and b_data.get("utilization"):
                for k in ("lut", "ff", "bram", "dsp"):
                    a_v = a_data["utilization"].get(k)
                    b_v = b_data["utilization"].get(k)
                    if a_v is not None and b_v is not None:
                        diff.add(k.upper(), a_v, b_v, lower_is_better=True)

    return diff
