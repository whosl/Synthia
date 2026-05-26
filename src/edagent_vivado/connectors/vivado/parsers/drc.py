"""Parse Vivado DRC report text into structured ParsedReport data."""

from __future__ import annotations

import re
from typing import Any

from edagent_vivado.connectors.base.types import ParsedReport

PAT_RULE = re.compile(
    r"^\s*(?P<sev>CRITICAL WARNING|WARNING|ERROR):\s*\[(?P<rule>[^\]]+)\]\s+(?P<msg>.+?)\s*$",
    re.MULTILINE,
)


def parse_drc_report(text: str, *, stage: str = "impl") -> ParsedReport:
    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    for m in PAT_RULE.finditer(text):
        sev = m.group("sev").lower()
        item = {
            "rule": m.group("rule"),
            "severity": sev,
            "message": m.group("msg").strip(),
            "objects": [],
            "suggested_action": "",
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
            data={"errors": [], "warnings": [], "clean": True},
        )
    return ParsedReport(
        type="drc",
        tool="vivado",
        stage=stage,
        data={"errors": errors, "warnings": warnings, "clean": not errors},
    )
