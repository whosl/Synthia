"""Parse Vivado timing summary reports."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class TimingSummary:
    wns: Optional[float] = None  # Worst Negative Slack
    tns: Optional[float] = None  # Total Negative Slack
    whs: Optional[float] = None  # Worst Hold Slack
    ths: Optional[float] = None  # Total Hold Slack
    raw_lines: list[str] = field(default_factory=list)


# Format 1: Mock / simplified "WNS=value" or "WNS: value"
PAT_WNS = re.compile(r"(?:WNS|Worst\s+Negative\s+Slack)\s*[:=]\s*(-?[\d.]+)")
PAT_TNS = re.compile(r"(?:TNS|Total\s+Negative\s+Slack)\s*[:=]\s*(-?[\d.]+)")
PAT_WHS = re.compile(r"(?:WHS|Worst\s+Hold\s+Slack)\s*[:=]\s*(-?[\d.]+)")
PAT_THS = re.compile(r"(?:THS|Total\s+Hold\s+Slack)\s*[:=]\s*(-?[\d.]+)")

# Format 2: Real Vivado table header
PAT_TABLE_HEADER = re.compile(
    r"\s*WNS\(ns\)\s+TNS\(ns\)\s+.*WHS\(ns\)\s+THS\(ns\)"
)
# Format 2b: Intra Clock Table (single clock case)
PAT_INTRA_CLOCK = re.compile(
    r"^\S+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+\d+\s+\d+\s+(-?[\d.]+)\s+(-?[\d.]+)"
)


def parse_timing_summary(text: str) -> Optional[TimingSummary]:
    """Parse a Vivado timing summary report. Returns None if parsing fails."""
    try:
        summary = TimingSummary(raw_lines=text.splitlines())
        lines = text.splitlines()

        # Try Format 1: WNS=... etc
        for line in lines:
            m = PAT_WNS.search(line)
            if m:
                summary.wns = float(m.group(1))
            m = PAT_TNS.search(line)
            if m:
                summary.tns = float(m.group(1))
            m = PAT_WHS.search(line)
            if m:
                summary.whs = float(m.group(1))
            m = PAT_THS.search(line)
            if m:
                summary.ths = float(m.group(1))

        # Try Format 2: Real Vivado table
        # Structure: header line, separator dashes, data values
        if summary.wns is None:
            for i, line in enumerate(lines):
                if PAT_TABLE_HEADER.search(line) and i + 2 < len(lines):
                    # Skip separator line (dashes), read data line
                    data_line = lines[i + 2]
                    parts = data_line.strip().split()
                    if len(parts) >= 4:
                        try:
                            # Try reading as floats; if first part is a name
                            # (like clock name), the numeric data starts at index 1
                            offset = 0
                            try:
                                float(parts[0])
                            except ValueError:
                                offset = 1
                            summary.wns = float(parts[offset])
                            summary.tns = float(parts[offset + 1])
                            if len(parts) >= offset + 6:
                                summary.whs = float(parts[offset + 4])
                                summary.ths = float(parts[offset + 5])
                        except (ValueError, IndexError):
                            pass
                    # Only use the first matching table (Design Timing Summary)
                    break

        return summary
    except Exception:
        return None


def load_timing(path: str | Path) -> Optional[TimingSummary]:
    """Load and parse a timing report from file."""
    p = Path(path)
    if not p.exists():
        return None
    return parse_timing_summary(p.read_text(errors="replace"))
