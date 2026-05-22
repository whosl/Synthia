"""Tests for QoR checker."""

from pathlib import Path

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.qor_checker import QorResult, check_qor
from edagent_vivado.parsers.timing_parser import TimingSummary
from edagent_vivado.parsers.utilization_parser import UtilizationSummary

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


def test_qor_wns_pass():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    timing = TimingSummary(wns=0.123, tns=0.0, whs=0.045, ths=0.0)
    result = check_qor(manifest, timing=timing)
    assert result.passed  # WNS >= 0.0


def test_qor_wns_fail():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    timing = TimingSummary(wns=-0.5, tns=-10.0, whs=0.045, ths=0.0)
    result = check_qor(manifest, timing=timing)
    assert not result.passed  # WNS < 0.0
    assert any("wns" in c["check"] and not c["passed"] for c in result.checks)


def test_qor_tns_warning():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    timing = TimingSummary(wns=0.5, tns=-5.0, whs=0.0, ths=0.0)
    result = check_qor(manifest, timing=timing)
    assert any("tns" in c["check"] for c in result.checks)


def test_qor_empty_timing():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    result = check_qor(manifest, timing=None)
    assert result.passed  # No timing == no violations


def test_qor_drc_check():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    result = check_qor(manifest, drc_clean=False)
    assert not result.passed
    assert any("drc" in c["check"] for c in result.checks)


def test_qor_high_utilization_warning():
    manifest = Manifest.load(EXAMPLE_DIR / "eda.yaml")
    util = UtilizationSummary(lut=150000, ff=250000)
    result = check_qor(manifest, utilization=util)
    assert not result.passed
    assert any("lut_util" in c["check"] for c in result.checks)
