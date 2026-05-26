"""Phase 5 impl_summary parser tests."""

from __future__ import annotations

from edagent_vivado.connectors.vivado.parsers.impl_summary import build_impl_summary


def test_clean_run_marks_ok():
    rep = build_impl_summary(
        timing_data={"wns": 0.1, "tns": 0.0, "whs": 0.05, "ths": 0.0, "violated_path_count": 0},
        util_data={"lut_pct": 50.0, "ff_pct": 30.0, "bram_pct": 20.0, "dsp_pct": 0.0},
        drc_data={"clean": True, "errors": [], "warnings": [], "by_category": {}},
        methodology_data={"count": 0, "by_severity": {}},
        log_data={"error_count": 0, "critical_warning_count": 0},
        bitstream_data={"found": True, "count": 1, "primary_bit": "/x/run.bit"},
    )
    assert rep.type == "impl_summary"
    assert rep.data["ok"] is True
    assert rep.data["timing"]["met_setup"] is True
    assert rep.data["bitstream"]["found"] is True
    assert rep.data["issues"] == []


def test_timing_violation_flags_failure():
    rep = build_impl_summary(
        timing_data={"wns": -0.2, "whs": -0.05, "violated_path_count": 3, "met_setup": False, "met_hold": False},
    )
    assert rep.data["ok"] is False
    issues = rep.data["issues"]
    assert any("Setup violated" in i["message"] for i in issues)
    assert any("Hold violated" in i["message"] for i in issues)


def test_high_utilization_issues():
    rep = build_impl_summary(util_data={"lut_pct": 96.5, "ff_pct": 88.0})
    cats = [i["severity"] for i in rep.data["issues"]]
    assert "high" in cats
    assert "medium" in cats


def test_drc_errors_propagate():
    rep = build_impl_summary(drc_data={
        "clean": False,
        "errors": [{"rule": "DRC-1"}, {"rule": "DRC-2"}],
        "warnings": [{"rule": "DRC-3"}],
        "by_category": {"io": 2, "timing": 1},
    })
    assert rep.data["ok"] is False
    assert rep.data["drc"]["error_count"] == 2
    assert rep.data["drc"]["warning_count"] == 1
