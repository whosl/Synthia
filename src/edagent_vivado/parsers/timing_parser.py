"""Parse Vivado timing summary reports."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


@dataclass
class TimingSummary:
    wns: Optional[float] = None  # Worst Negative Slack
    tns: Optional[float] = None  # Total Negative Slack
    whs: Optional[float] = None  # Worst Hold Slack
    ths: Optional[float] = None  # Total Hold Slack
    critical_paths: list[dict[str, Any]] = field(default_factory=list)
    violated_path_count: int = 0
    raw_lines: list[str] = field(default_factory=list)

    @property
    def met_setup(self) -> bool:
        return self.wns is None or self.wns >= 0

    @property
    def met_hold(self) -> bool:
        return self.whs is None or self.whs >= 0


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

# Critical path block: `Slack (VIOLATED|MET) :  -0.342ns` followed by Source/Destination/...
PATH_BLOCK_RE = re.compile(
    r"Slack\s*\((?P<status>VIOLATED|MET)\)\s*:\s*(?P<slack>-?\d+\.\d+)ns"
    r"(?P<body>(?:.|\n){0,1500}?)"
    r"(?=Slack\s*\(|\Z)",
    re.MULTILINE,
)
_FIELD_RES = {
    "source": re.compile(r"^\s*Source:\s*(.+?)\s*$", re.MULTILINE),
    "destination": re.compile(r"^\s*Destination:\s*(.+?)\s*$", re.MULTILINE),
    "path_group": re.compile(r"^\s*Path Group:\s*(.+?)\s*$", re.MULTILINE),
    "path_type": re.compile(r"^\s*Path Type:\s*(.+?)\s*$", re.MULTILINE),
    "requirement_ns": re.compile(r"^\s*Requirement:\s*(-?\d+\.\d+)ns", re.MULTILINE),
    "data_path_delay_ns": re.compile(r"^\s*Data Path Delay:\s*(-?\d+\.\d+)ns", re.MULTILINE),
    "logic_levels": re.compile(r"^\s*Logic Levels:\s*(\d+)", re.MULTILINE),
}


def parse_critical_paths(text: str, *, top_n: int = 10) -> list[dict[str, Any]]:
    """Extract structured per-path slack records, ordered worst-slack-first."""
    paths: list[dict[str, Any]] = []
    for match in PATH_BLOCK_RE.finditer(text):
        body = match.group("body")
        path: dict[str, Any] = {
            "slack_ns": float(match.group("slack")),
            "status": match.group("status").lower(),
        }
        for key, pat in _FIELD_RES.items():
            fm = pat.search(body)
            if not fm:
                continue
            raw = fm.group(1).strip()
            if key in ("requirement_ns", "data_path_delay_ns"):
                try:
                    path[key] = float(raw)
                except ValueError:
                    path[key] = None
            elif key == "logic_levels":
                try:
                    path[key] = int(raw)
                except ValueError:
                    path[key] = None
            else:
                path[key] = raw
        paths.append(path)
    paths.sort(key=lambda p: p.get("slack_ns", 0.0))
    return paths[:top_n]


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

        summary.critical_paths = parse_critical_paths(text, top_n=10)
        summary.violated_path_count = sum(
            1 for p in summary.critical_paths if p.get("status") == "violated"
        )
        return summary
    except Exception:
        return None


def load_timing(path: str | Path) -> Optional[TimingSummary]:
    """Load and parse a timing report from file."""
    p = Path(path)
    if not p.exists():
        return None
    return parse_timing_summary(p.read_text(errors="replace"))
