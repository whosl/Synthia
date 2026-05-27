"""Phase 7 — patch risk classification."""

from __future__ import annotations

from edagent_vivado.patches.proposal import PatchChange
from edagent_vivado.patches.risk_classifier import classify_file, classify_risk


def test_classify_rtl_high_strong():
    ch = PatchChange(path="rtl/top.v", action="modify", file_category="rtl")
    r = classify_risk([ch])
    assert r.overall == "high"
    assert r.requires_strong_approval
    assert not r.auto_apply


def test_classify_xdc_medium_no_auto():
    ch = PatchChange(path="constraints/top.xdc", action="modify", file_category="xdc")
    r = classify_risk([ch])
    assert r.overall == "medium"
    assert not r.auto_apply


def test_classify_tcl_auto():
    ch = PatchChange(path="scripts/run.tcl", action="modify", file_category="tcl")
    r = classify_risk([ch])
    assert r.auto_apply
    assert not r.denied


def test_delete_rtl_denied():
    ch = PatchChange(path="rtl/top.v", action="delete", file_category="rtl")
    r = classify_risk([ch])
    assert r.denied


def test_classify_file_helper():
    assert classify_file("foo/bar.xdc") == "xdc"
    assert classify_file("rtl/uart.v") == "rtl"


def test_classify_tb_rtl_no_auto_apply():
    ch = PatchChange(path="tb/uart_tb.v", action="modify", file_category="rtl")
    r = classify_risk([ch])
    assert r.overall == "medium"
    assert not r.auto_apply
