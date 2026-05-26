"""Wrap vivado_log_parser for connector ParsedReport output."""

from __future__ import annotations

from edagent_vivado.connectors.base.types import ParsedReport
from edagent_vivado.parsers.vivado_log_parser import parse_vivado_log


def parse_log_summary(text: str, *, stage: str = "synth") -> ParsedReport:
    summary = parse_vivado_log(text)
    return ParsedReport(
        type="log_summary",
        tool="vivado",
        stage=stage,
        data={
            "error_count": summary.error_count,
            "critical_warning_count": summary.critical_warning_count,
            "warning_count": summary.warning_count,
            "top_error_signatures": summary.top_error_signatures[:10],
            "messages": [
                {
                    "message_id": m.message_id,
                    "severity": m.severity,
                    "text": m.text,
                    "line_number": m.line_number,
                }
                for m in summary.messages[:50]
            ],
        },
    )
