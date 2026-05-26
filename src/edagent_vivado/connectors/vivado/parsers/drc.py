"""Parse Vivado DRC report text into structured ParsedReport data."""

from __future__ import annotations

import re
from typing import Any

from edagent_vivado.connectors.base.types import ParsedReport

PAT_RULE = re.compile(
    r"^\s*(?P<sev>CRITICAL WARNING|WARNING|ERROR):\s*\[(?P<rule>[^\]]+)\]\s+(?P<msg>.+?)\s*$",
    re.MULTILINE,
)


CATEGORY_MAP: dict[str, str] = {
    "CLKC": "clocking",
    "TIMING": "timing",
    "TIM": "timing",
    "SYNTH": "synthesis",
    "LATCH": "latches",
    "IO": "io",
    "UCIO": "io",
    "BUFG": "clock_buffer",
    "DPOPT": "dsp",
    "RTSTAT": "routing",
    "PDRC": "physical",
    "REQP": "placement",
    "AVAL": "availability",
    "NSTD": "constraints",
    "CDC": "cdc",
    "ZPS7": "platform",
    "DCRP": "dcp",
}


def _categorize_rule(rule: str) -> str:
    if not rule:
        return "other"
    prefix = rule.split("-", 1)[0].upper() if "-" in rule else rule.upper()
    return CATEGORY_MAP.get(prefix, "other")


def _suggest_action(rule: str, category: str, severity: str) -> str:
    if category == "timing":
        return "Review timing constraints; check clock crossings and false paths"
    if category == "clocking" or category == "clock_buffer":
        return "Verify clock source / BUFG placement and clock topology"
    if category == "io":
        return "Review IO standards and pin assignments in XDC"
    if category == "cdc":
        return "Add synchronizer or set_false_path for the async crossing"
    if category == "synthesis" and "error" in severity:
        return "Check RTL syntax and unsupported constructs"
    if category == "placement":
        return "Inspect placement constraints and ROI region"
    if category == "constraints":
        return "Tighten XDC: missing default port standards or constraints"
    return ""


def parse_drc_report(text: str, *, stage: str = "impl") -> ParsedReport:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    by_category: dict[str, int] = {}

    for m in PAT_RULE.finditer(text):
        sev = m.group("sev").lower()
        rule = m.group("rule")
        category = _categorize_rule(rule)
        by_category[category] = by_category.get(category, 0) + 1
        item: dict[str, Any] = {
            "rule": rule,
            "category": category,
            "severity": sev,
            "message": m.group("msg").strip(),
            "objects": [],
            "suggested_action": _suggest_action(rule, category, sev),
        }
        if "error" in sev:
            errors.append(item)
        else:
            warnings.append(item)

    if not errors and not warnings and "no violation" in text.lower():
        return ParsedReport(
            type="drc",
            tool="vivado",
            stage=stage,
            data={
                "errors": [],
                "warnings": [],
                "by_category": {},
                "clean": True,
            },
        )
    return ParsedReport(
        type="drc",
        tool="vivado",
        stage=stage,
        data={
            "errors": errors,
            "warnings": warnings,
            "by_category": by_category,
            "clean": not errors and not warnings,
        },
    )
