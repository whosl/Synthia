"""Tests for timing and utilization parsers."""

from edagent_vivado.parsers.timing_parser import parse_timing_summary
from edagent_vivado.parsers.utilization_parser import parse_utilization


def test_parse_timing_wns_tns():
    text = "WNS=0.123\nTNS=0.000\nWHS=0.045\nTHS=0.000"
    ts = parse_timing_summary(text)
    assert ts is not None
    assert ts.wns == 0.123
    assert ts.tns == 0.0
    assert ts.whs == 0.045
    assert ts.ths == 0.0


def test_parse_timing_negative():
    text = "Worst Negative Slack: -2.350\nTotal Negative Slack: -48.2"
    ts = parse_timing_summary(text)
    assert ts is not None
    assert ts.wns == -2.35
    assert ts.tns == -48.2


def test_parse_timing_with_colon_format():
    text = "WNS: 0.500\nTNS: 0.000\nWHS: 0.100\nTHS: 0.000"
    ts = parse_timing_summary(text)
    assert ts is not None
    assert ts.wns == 0.5


def test_parse_timing_empty():
    ts = parse_timing_summary("")
    assert ts is not None  # returns TimingSummary not None


def test_parse_timing_bad_format():
    ts = parse_timing_summary("No timing data available")
    assert ts is not None  # graceful: returns object with None values


def test_parse_utilization():
    text = "Slice LUTs: 1234\nSlice Registers: 567\nBlock RAM Tile: 2\nDSPs: 0"
    us = parse_utilization(text)
    assert us is not None
    assert us.lut == 1234
    assert us.ff == 567
    assert us.bram == 2
    assert us.dsp == 0


def test_parse_utilization_short_form():
    text = "LUT: 1300\nFF: 600\nBRAM: 2\nDSP48E1: 0"
    us = parse_utilization(text)
    assert us is not None
    assert us.lut == 1300
    assert us.ff == 600


def test_parse_utilization_empty():
    us = parse_utilization("")
    assert us is not None


def test_parse_utilization_bad_format():
    us = parse_utilization("Some random text")
    assert us is not None
