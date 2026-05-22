"""QoR (Quality of Results) checker — validate synth/impl results against targets."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.parsers.timing_parser import TimingSummary
from edagent_vivado.parsers.utilization_parser import UtilizationSummary


@dataclass
class QorResult:
    """Outcome of a QoR check against manifest targets."""

    passed: bool = True
    checks: list[dict] = field(default_factory=list)

    def add_check(self, name: str, passed: bool, detail: str, skipped: bool = False) -> None:
        self.checks.append({"check": name, "passed": passed, "detail": detail, "skipped": skipped})
        if not passed and not skipped:
            self.passed = False

    def add_skip(self, name: str, detail: str) -> None:
        self.add_check(name, True, detail, skipped=True)


def check_qor(
    manifest: Manifest,
    timing: Optional[TimingSummary] = None,
    utilization: Optional[UtilizationSummary] = None,
    drc_clean: Optional[bool] = None,
    synthesis_failed: bool = False,
) -> QorResult:
    """Validate synthesis/implementation results against manifest QoR targets.

    Args:
        manifest: Project manifest with qor_targets section.
        timing: Parsed timing summary (can be None if not available).
        utilization: Parsed utilization summary (can be None).
        drc_clean: Whether DRC passed (None if not checked).
        synthesis_failed: If True, all timing/util checks are marked SKIP.
    """
    result = QorResult()
    targets = manifest.qor_targets

    if synthesis_failed:
        result.add_skip("wns", "Synthesis failed — no timing data available")
        result.add_skip("tns", "Synthesis failed — no timing data available")
        result.add_skip("whs", "Synthesis failed — no timing data available")
        result.passed = False  # overall: failed
        return result

    # WNS check
    if timing is not None and timing.wns is not None:
        passed = timing.wns >= targets.wns_min
        result.add_check("wns", passed, f"WNS={timing.wns}ns (target >= {targets.wns_min}ns)")
    elif timing is not None:
        result.add_skip("wns", "WNS not available in report")

    # TNS check
    if timing is not None and timing.tns is not None:
        if timing.tns < 0:
            result.add_check("tns", False, f"TNS={timing.tns}ns (negative — timing violations exist)")
        else:
            result.add_check("tns", True, f"TNS={timing.tns}ns")
    elif timing is not None:
        result.add_skip("tns", "TNS not available in report")

    # WHS check
    if timing is not None and timing.whs is not None:
        if timing.whs < 0:
            result.add_check("whs", False, f"WHS={timing.whs}ns (hold violation)")
        else:
            result.add_check("whs", True, f"WHS={timing.whs}ns")
    elif timing is not None:
        result.add_skip("whs", "WHS not available in report")

    # DRC check
    if targets.require_drc_clean and drc_clean is not None:
        result.add_check("drc", drc_clean, "DRC clean" if drc_clean else "DRC violations found")

    # Utilization warnings
    if utilization is not None:
        if utilization.lut is not None:
            if utilization.lut > 100_000:
                result.add_check("lut_util", False, f"LUT usage {utilization.lut} exceeds 100k")
            else:
                result.add_check("lut_util", True, f"LUT usage {utilization.lut}")
        if utilization.ff is not None:
            if utilization.ff > 200_000:
                result.add_check("ff_util", False, f"FF usage {utilization.ff} exceeds 200k")
            else:
                result.add_check("ff_util", True, f"FF usage {utilization.ff}")

    return result
