"""Phase 6C — Vivado report parsers."""

from __future__ import annotations

from edagent_vivado.connectors.vivado.parsers.drc import parse_drc_report
from edagent_vivado.connectors.vivado.parsers.log_summary import parse_log_summary
from edagent_vivado.connectors.vivado.parsers.methodology import parse_methodology_report
from edagent_vivado.parsers.timing_parser import parse_timing_summary


def test_parse_drc_clean():
    r = parse_drc_report("No violations.\n", stage="synth")
    assert r.type == "drc"
    assert r.data.get("clean") is True


def test_parse_drc_rule():
    text = "ERROR: [DRC NSTD-1] Port CLK has no IO standard\n"
    r = parse_drc_report(text, stage="impl")
    assert len(r.data["errors"]) == 1
    assert "NSTD" in r.data["errors"][0]["rule"]


def test_parse_timing_mock():
    t = parse_timing_summary("WNS=0.120\nTNS=0.000\nWHS=0.045\nTHS=0.000\n")
    assert t is not None
    assert t.wns == 0.12


def test_parse_log_summary():
    text = "ERROR: [Synth 8-439] module 'foo' not found\nWARNING: [Synth 8-333] something\n"
    r = parse_log_summary(text, stage="synth")
    assert r.data["error_count"] >= 1


def test_parse_methodology():
    text = "WARNING: [TIMING-18] Missing input delay\n"
    r = parse_methodology_report(text)
    assert r.data["count"] == 1
