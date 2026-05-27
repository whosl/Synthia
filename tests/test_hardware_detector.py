"""Phase 12 — hardware detector parsing."""

from __future__ import annotations

from edagent_vivado.hardware.detector import _parse_detect_output


def test_parse_detect_output():
    sample = """
some preamble
TARGETS_BEGIN
TARGET: Xilinx/210299A5D2A4/0
  DEVICE: xc7a50t_0 part=xc7a50tfgg484-2
  DEVICE: xc2c64a_0 part=xc2c64a-vq44-2
TARGET: Digilent/210299/0
  DEVICE: xc7z020_0 part=xc7z020clg400-1
TARGETS_END
"""
    devs = _parse_detect_output(sample)
    assert len(devs) == 3
    assert devs[0].part == "xc7a50tfgg484-2"
    assert devs[2].target == "Digilent/210299/0"


def test_parse_no_targets():
    devs = _parse_detect_output("CONNECT_ERROR: connection refused")
    assert devs == []
