"""Parse Vivado methodology report text."""

from __future__ import annotations

import re
from typing import Any

from edagent_vivado.connectors.base.types import ParsedReport

PAT_RULE = re.compile(
    r"^\s*(?P<sev>CRITICAL WARNING|WARNING|ERROR|INFO):\s*\[(?P<rule>[^\]]+)\]\s+(?P<msg>.+?)\s*$",
    re.MULTILINE,
)

SEVERITY_RANK: dict[str, int] = {
    "info": 0,
    "warning": 1,
    "critical warning": 2,
    "error": 3,
}


def _categorize_method(rule: str) -> str:
    rule_u = rule.upper()
    if rule_u.startswith(("TIMING", "TIM")):
        return "timing"
    if rule_u.startswith(("CDC", "ASYNC")):
        return "cdc"
    if rule_u.startswith(("SYN", "SYNTH")):
        return "synthesis"
    if rule_u.startswith(("PHYS", "PLACE", "ROUTE", "PHY")):
        return "physical"
    if rule_u.startswith(("XDC", "CONST")):
        return "constraints"
    if rule_u.startswith(("DRC",)):
        return "drc"
    return "other"


def _suggest_methodology(rule: str, severity: str) -> str:
    rule_u = rule.upper()
    if "TIMING" in rule_u or "TIM" in rule_u:
        return "Review timing assertions; consider set_max_delay or set_false_path"
    if "CDC" in rule_u or "ASYNC" in rule_u:
        return "Verify CDC synchronizer; review async clock domain crossings"
    if "SYN" in rule_u:
        return "Inspect synthesis constructs; consider attribute hints"
    return ""


def parse_methodology_report(text: str, *, stage: str = "impl") -> ParsedReport:
    findings: list[dict[str, Any]] = []
    counts: dict[str, int] = {k: 0 for k in SEVERITY_RANK}
    by_category: dict[str, int] = {}

    for m in PAT_RULE.finditer(text):
        sev = m.group("sev").lower()
        rule = m.group("rule")
        category = _categorize_method(rule)
        counts[sev] = counts.get(sev, 0) + 1
        by_category[category] = by_category.get(category, 0) + 1
        findings.append({
            "rule": rule,
            "severity": sev,
            "severity_rank": SEVERITY_RANK.get(sev, 0),
            "message": m.group("msg").strip(),
            "category": category,
            "suggested_action": _suggest_methodology(rule, sev),
        })
    findings.sort(key=lambda f: -f.get("severity_rank", 0))

    return ParsedReport(
        type="methodology",
        tool="vivado",
        stage=stage,
        data={
            "findings": findings,
            "count": len(findings),
            "by_severity": counts,
            "by_category": by_category,
            "top_critical": [f for f in findings if f.get("severity_rank", 0) >= 2][:5],
        },
    )
