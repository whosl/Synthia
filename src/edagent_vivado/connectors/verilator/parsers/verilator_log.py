"""Parse Verilator %Error / %Warning lines."""

from __future__ import annotations

import re

from edagent_vivado.connectors.base.types import ParsedReport

PAT = re.compile(
    r"%(?P<sev>Error|Warning):\s*(?P<msg>.+?)(?:\s*$)",
    re.MULTILINE,
)


def parse_verilator_log(text: str, *, stage: str = "lint") -> ParsedReport:
    errors, warnings = [], []
    for m in PAT.finditer(text):
        item = {"severity": m.group("sev").lower(), "message": m.group("msg").strip()}
        if item["severity"] == "error":
            errors.append(item)
        else:
            warnings.append(item)
    return ParsedReport(
        type="log_summary",
        tool="verilator",
        stage=stage,
        data={"errors": errors, "warnings": warnings, "error_count": len(errors)},
    )
