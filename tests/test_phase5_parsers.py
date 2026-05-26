"""Phase 5 parser extensions: timing critical paths, utilization sites, DRC/methodology categorisation."""

from __future__ import annotations

from edagent_vivado.connectors.vivado.parsers.drc import parse_drc_report
from edagent_vivado.connectors.vivado.parsers.methodology import parse_methodology_report
from edagent_vivado.parsers.timing_parser import parse_critical_paths, parse_timing_summary
from edagent_vivado.parsers.utilization_parser import parse_site_table, parse_utilization


TIMING_REPORT = """
Design Timing Summary
---------------------
    WNS(ns)      TNS(ns)  TNS Failing Endpoints  TNS Total Endpoints      WHS(ns)      THS(ns)
    -------      -------  ---------------------  -------------------      -------      -------
     -0.342       -1.250                      4                  200        0.050        0.000

Slack (VIOLATED) :        -0.342ns
  Source:                 reg_a/clk
  Destination:            reg_b/D
  Path Group:             clk_main
  Path Type:              Setup (Max at Slow Process Corner)
  Requirement:            5.000ns
  Data Path Delay:        5.234ns
  Logic Levels:           7

Slack (MET) :        0.123ns
  Source:                 reg_c/clk
  Destination:            reg_d/D
  Path Group:             clk_main
  Path Type:              Setup
  Requirement:            5.000ns
  Data Path Delay:        4.800ns
  Logic Levels:           4
"""


def test_critical_paths_ordered_worst_first():
    paths = parse_critical_paths(TIMING_REPORT, top_n=5)
    assert len(paths) == 2
    assert paths[0]["slack_ns"] == -0.342
    assert paths[0]["status"] == "violated"
    assert paths[0]["source"] == "reg_a/clk"
    assert paths[0]["destination"] == "reg_b/D"
    assert paths[0]["path_group"] == "clk_main"
    assert paths[0]["logic_levels"] == 7
    assert paths[1]["status"] == "met"


def test_timing_summary_exposes_critical_paths_and_flags():
    summary = parse_timing_summary(TIMING_REPORT)
    assert summary is not None
    assert summary.wns == -0.342
    assert summary.violated_path_count == 1
    assert summary.met_setup is False
    assert summary.met_hold is True
    assert len(summary.critical_paths) == 2


UTIL_REPORT = """
+-------------------------+------+-------+-----------+-------+
|        Site Type        | Used | Fixed | Available | Util% |
+-------------------------+------+-------+-----------+-------+
| Slice LUTs              |  423 |     0 |     53200 |  0.80 |
|   LUT as Logic          |  398 |     0 |     53200 |  0.75 |
| Slice Registers         |  600 |     0 |    106400 |  0.56 |
| Block RAM Tile          |    5 |     0 |       140 |  3.57 |
| DSPs                    |   10 |     0 |       220 |  4.55 |
+-------------------------+------+-------+-----------+-------+
"""


def test_utilization_sites_and_percentages():
    sites = parse_site_table(UTIL_REPORT)
    assert "Slice LUTs" in sites
    assert sites["Slice LUTs"]["used"] == 423
    assert sites["Slice LUTs"]["util_pct"] == 0.80

    summary = parse_utilization(UTIL_REPORT)
    assert summary is not None
    assert summary.lut == 423
    assert summary.lut_pct == 0.80
    assert summary.bram_pct == 3.57
    assert summary.dsp == 10
    assert summary.dsp_pct == 4.55
    assert "Slice LUTs" in summary.sites


def test_drc_categorises_rules():
    sample = """
WARNING: [TIMING-100] Timing constraint missing on path foo
CRITICAL WARNING: [CLKC-25] Clock buffer issue on net bar
ERROR: [IO-3] IO standard mismatch on port baz
"""
    report = parse_drc_report(sample)
    by_cat = report.data["by_category"]
    assert by_cat.get("timing") == 1
    assert by_cat.get("clocking") == 1
    assert by_cat.get("io") == 1
    rules = [w["rule"] for w in report.data["warnings"]] + [e["rule"] for e in report.data["errors"]]
    assert "TIMING-100" in rules
    assert any(item.get("category") == "io" and item.get("suggested_action")
               for item in report.data["errors"])


def test_methodology_severity_rank_sort_and_category():
    sample = """
WARNING: [TIMING-9] minor timing finding
ERROR: [SYN-7] synthesis error
CRITICAL WARNING: [CDC-12] CDC concern
INFO: [PHYS-3] place advice
"""
    report = parse_methodology_report(sample)
    findings = report.data["findings"]
    assert findings[0]["severity"] == "error"
    assert findings[1]["severity"] == "critical warning"
    assert report.data["by_severity"]["error"] == 1
    assert report.data["by_severity"]["critical warning"] == 1
    cats = {f["category"] for f in findings}
    assert "timing" in cats and "cdc" in cats and "synthesis" in cats and "physical" in cats
