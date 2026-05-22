"""Parse Vivado utilization reports."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class UtilizationSummary:
    lut: Optional[int] = None
    ff: Optional[int] = None
    bram: Optional[int] = None
    dsp: Optional[int] = None
    raw_lines: list[str] = field(default_factory=list)


# Format 1: Simplified mock "Slice LUTs: 1234" or "LUT: 1300"
PAT_LUT = re.compile(r"(?:Slice\s+LUTs?\*?|^LUT\b)\s*[:=]?\s*(\d+)", re.IGNORECASE | re.MULTILINE)
PAT_FF = re.compile(r"(?:Slice\s+Registers?|^FF\b|^Register\b)\s*[:=]?\s*(\d+)", re.IGNORECASE | re.MULTILINE)
PAT_BRAM = re.compile(r"(?:Block\s+RAM\s+Tile|^BRAM\b)\s*[:=]?\s*(\d+)", re.IGNORECASE | re.MULTILINE)
PAT_DSP = re.compile(r"(?:^DSPs?\b|DSP48E1)\s*[:=]?\s*(\d+)", re.IGNORECASE | re.MULTILINE)

# Format 2: Real Vivado table rows "| Slice LUTs*             |   59 |"
PAT_TABLE_LUT = re.compile(
    r"\|\s*Slice\s+LUTs?\*?\s*\|\s*(\d+)\s*\|", re.IGNORECASE
)
PAT_TABLE_FF = re.compile(
    r"\|\s*Slice\s+Registers?\s*\|\s*(\d+)\s*\|", re.IGNORECASE
)
PAT_TABLE_BRAM = re.compile(
    r"\|\s*Block\s+RAM\s+Tile\s*\|\s*(\d+)\s*\|", re.IGNORECASE
)
PAT_TABLE_DSP = re.compile(
    r"\|\s*DSPs?\s*\|\s*(\d+)\s*\|", re.IGNORECASE
)


def parse_utilization(text: str) -> Optional[UtilizationSummary]:
    """Parse a Vivado utilization report. Returns None if parsing fails."""
    try:
        summary = UtilizationSummary(raw_lines=text.splitlines())

        for line in text.splitlines():
            # Try Format 1
            m = PAT_LUT.search(line)
            if m:
                summary.lut = int(m.group(1))
            m = PAT_FF.search(line)
            if m:
                summary.ff = int(m.group(1))
            m = PAT_BRAM.search(line)
            if m:
                summary.bram = int(m.group(1))
            m = PAT_DSP.search(line)
            if m:
                summary.dsp = int(m.group(1))

        # Try Format 2: Real Vivado table
        for line in text.splitlines():
            m = PAT_TABLE_LUT.search(line)
            if m and summary.lut is None:
                summary.lut = int(m.group(1))
            m = PAT_TABLE_FF.search(line)
            if m and summary.ff is None:
                summary.ff = int(m.group(1))
            m = PAT_TABLE_BRAM.search(line)
            if m and summary.bram is None:
                summary.bram = int(m.group(1))
            m = PAT_TABLE_DSP.search(line)
            if m and summary.dsp is None:
                summary.dsp = int(m.group(1))

        return summary
    except Exception:
        return None


def load_utilization(path: str | Path) -> Optional[UtilizationSummary]:
    """Load and parse a utilization report from file."""
    p = Path(path)
    if not p.exists():
        return None
    return parse_utilization(p.read_text(errors="replace"))
