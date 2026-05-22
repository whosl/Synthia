"""Tests for Vivado log parser."""

from pathlib import Path

from edagent_vivado.parsers.vivado_log_parser import (
    parse_vivado_log,
    load_and_parse,
    LogMessage,
)

EXAMPLE_DIR = Path(__file__).parent.parent / "examples" / "uart_demo"


def test_parse_error_count():
    text = (EXAMPLE_DIR / "logs" / "sample_vivado_error.log").read_text(errors="replace")
    summary = parse_vivado_log(text)
    assert summary.error_count == 2  # two [Synth 8-439]
    assert summary.critical_warning_count == 2  # two [Common 17-69]
    assert summary.warning_count >= 2  # warnings


def test_parse_finds_synth_8_439():
    text = (EXAMPLE_DIR / "logs" / "sample_vivado_error.log").read_text(errors="replace")
    summary = parse_vivado_log(text)
    found = any("Synth 8-439" in m.message_id for m in summary.messages if m.severity == "ERROR")
    assert found, "Should extract [Synth 8-439]"


def test_parse_finds_common_17_69():
    text = (EXAMPLE_DIR / "logs" / "sample_vivado_error.log").read_text(errors="replace")
    summary = parse_vivado_log(text)
    cw = [m for m in summary.messages if m.severity == "CRITICAL WARNING"]
    assert any("Common 17-69" in m.message_id for m in cw)


def test_parse_top_error_signatures():
    text = (EXAMPLE_DIR / "logs" / "sample_vivado_error.log").read_text(errors="replace")
    summary = parse_vivado_log(text)
    assert len(summary.top_error_signatures) > 0
    assert any("Synth 8-439" in s for s in summary.top_error_signatures)


def test_parse_empty_log():
    summary = parse_vivado_log("")
    assert summary.error_count == 0
    assert summary.warning_count == 0
    assert summary.messages == []


def test_parse_clean_log():
    log = """INFO: [Common 17-234] Starting synthesis
INFO: [Synth 8-256] Synthesis completed successfully
"""
    summary = parse_vivado_log(log)
    assert summary.error_count == 0
    assert summary.warning_count == 0


def test_load_and_parse():
    """Integration: load_and_parse should work from file path."""
    path = EXAMPLE_DIR / "logs" / "sample_vivado_error.log"
    summary = load_and_parse(path)
    assert summary.error_count == 2
