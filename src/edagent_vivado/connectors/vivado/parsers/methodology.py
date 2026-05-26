"""Parse Vivado methodology report text."""

from __future__ import annotations

import re
from typing import Any

from edagent_vivado.connectors.base.types import ParsedReport

PAT_RULE = re.compile(
    r"^\s*(?P<sev>CRITICAL WARNING|WARNING|ERROR|INFO):\s*\[(?P<rule>[^\]]+)\]\s+(?P<msg>.+?)\s*$",
    re.MULTILINE,
)


def parse_methodology_report(text: str, *, stage: str = "impl") -> ParsedReport:
    findings: list[dict[str, Any]] = []
    for m in PAT_RULE.finditer(text):
        findings.append({
            "rule": m.group("rule"),
            "severity": m.group("sev").lower(),
            "message": m.group("msg").strip(),
        })
    return ParsedReport(
        type="methodology",
        tool="vivado",
        stage=stage,
        data={"findings": findings, "count": len(findings)},
    )
