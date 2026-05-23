"""Tests for harness problem collector."""

import json

from edagent_vivado.harness.approval_outcomes import format_execution_failed
from edagent_vivado.harness.problem_collector import collect_from_tool_output


def test_collect_execution_failed():
    out = format_execution_failed("vivado_synth", "synth failed", extra={"return_code": 1})
    probs = collect_from_tool_output("run_vivado_synth_tool", out)
    assert len(probs) >= 1
    assert probs[0]["severity"] == "error"


def test_collect_log_errors():
    log = "ERROR: [Synth 8-439] module not found\nCRITICAL WARNING: timing failed"
    probs = collect_from_tool_output("parse_vivado_log_tool", log, source="parser")
    assert len(probs) >= 2
