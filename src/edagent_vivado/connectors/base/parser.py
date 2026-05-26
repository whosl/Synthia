"""Report parser protocol — SPEC §9B.10."""

from __future__ import annotations

from typing import Protocol

from edagent_vivado.connectors.base.types import ParsedReport


class ReportParser(Protocol):
    report_type: str

    def parse(self, text: str, *, stage: str = "") -> ParsedReport | None: ...
