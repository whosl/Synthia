"""Parse Vivado utilization reports."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


@dataclass
class UtilizationSummary:
    lut: Optional[int] = None
    ff: Optional[int] = None
    bram: Optional[int] = None
    dsp: Optional[int] = None
    uram: Optional[int] = None
    lut_pct: Optional[float] = None
    ff_pct: Optional[float] = None
    bram_pct: Optional[float] = None
    dsp_pct: Optional[float] = None
    uram_pct: Optional[float] = None
    sites: dict[str, dict[str, Any]] = field(default_factory=dict)
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

# Full site-type rows: `| <name> | used | fixed | available | util% |`
PAT_SITE_ROW = re.compile(
    r"^\|\s*(?P<name>[A-Za-z][\w\s\-./()*]*?)\s*\|"
    r"\s*(?P<used>\d+)\s*\|"
    r"\s*\d+\s*\|"
    r"\s*(?P<available>\d+)\s*\|"
    r"\s*(?P<pct>-?\d+(?:\.\d+)?)\s*\|",
    re.MULTILINE,
)

_SITE_ALIASES = {
    "lut": ("Slice LUTs", "CLB LUTs"),
    "ff": ("Slice Registers", "CLB Registers"),
    "bram": ("Block RAM Tile", "BRAM"),
    "dsp": ("DSPs",),
    "uram": ("URAM",),
}


def _first_site(sites: dict[str, dict[str, Any]], names: tuple[str, ...]) -> dict[str, Any] | None:
    for name in names:
        if name in sites:
            return sites[name]
    # fallback case-insensitive
    lower = {k.lower(): v for k, v in sites.items()}
    for name in names:
        if name.lower() in lower:
            return lower[name.lower()]
    return None


def parse_site_table(text: str) -> dict[str, dict[str, Any]]:
    """Extract per-site-type rows from the utilization tables."""
    rows: dict[str, dict[str, Any]] = {}
    for match in PAT_SITE_ROW.finditer(text):
        name = match.group("name").strip().strip("*")
        if not name or name.lower() in {"site type", "used", "fixed"}:
            continue
        try:
            used = int(match.group("used"))
            available = int(match.group("available"))
            pct = float(match.group("pct"))
        except ValueError:
            continue
        # Skip the trivial 0/0/0.00 separator rows but keep all legitimate data
        rows[name] = {
            "used": used,
            "available": available,
            "util_pct": pct,
        }
    return rows


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

        summary.sites = parse_site_table(text)
        for short, names in _SITE_ALIASES.items():
            site = _first_site(summary.sites, names)
            if not site:
                continue
            if getattr(summary, short) is None:
                setattr(summary, short, site.get("used"))
            pct_attr = f"{short}_pct"
            if getattr(summary, pct_attr) is None:
                setattr(summary, pct_attr, site.get("util_pct"))

        return summary
    except Exception:
        return None


def load_utilization(path: str | Path) -> Optional[UtilizationSummary]:
    """Load and parse a utilization report from file."""
    p = Path(path)
    if not p.exists():
        return None
    return parse_utilization(p.read_text(errors="replace"))
