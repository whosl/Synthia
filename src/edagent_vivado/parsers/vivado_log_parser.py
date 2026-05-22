"""Vivado log parser — extract errors, warnings, message IDs."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path


# ── message patterns ─────────────────────────────────────────

PAT_ERROR = re.compile(
    r"^(?:\s*)?(?:ERROR|CRITICAL WARNING)\s*:\s*\[?(?P<msg_id>[^\]]+)\]?\s*(?P<msg>.*)",
    re.MULTILINE,
)
PAT_WARNING = re.compile(
    r"^(?:\s*)?WARNING\s*:\s*\[?(?P<msg_id>[^\]]+)\]?\s*(?P<msg>.*)",
    re.MULTILINE,
)
PAT_MSG_ID = re.compile(r"\[(\w+\s*\d+-\d+)\]")
PAT_SYNTH_ERROR = re.compile(r"\[Synth\s+8-439\]")


@dataclass
class LogMessage:
    message_id: str
    severity: str  # ERROR | CRITICAL WARNING | WARNING
    text: str
    line_number: int = 0


@dataclass
class VivadoLogSummary:
    error_count: int = 0
    critical_warning_count: int = 0
    warning_count: int = 0
    messages: list[LogMessage] = field(default_factory=list)
    top_error_signatures: list[str] = field(default_factory=list)


def parse_vivado_log(text: str) -> VivadoLogSummary:
    """Parse a Vivado log (or transcript) string into a structured summary."""
    summary = VivadoLogSummary()
    seen_ids: set[str] = set()

    lines = text.splitlines()

    for lineno, line in enumerate(lines, 1):
        # Check ERROR
        m = PAT_ERROR.match(line)
        if m:
            msg_id = _normalize_msg_id(m.group("msg_id"))
            msg_text = m.group("msg").strip()
            severity = "CRITICAL WARNING" if "CRITICAL WARNING" in line else "ERROR"
            entry = LogMessage(
                message_id=msg_id,
                severity=severity,
                text=msg_text or line.strip(),
                line_number=lineno,
            )
            if severity == "ERROR":
                summary.error_count += 1
            else:
                summary.critical_warning_count += 1
            summary.messages.append(entry)

            # track unique signatures
            sig = f"[{msg_id}] {msg_text[:100]}"
            if sig not in seen_ids:
                seen_ids.add(sig)
                summary.top_error_signatures.append(sig)
            continue

        # Check WARNING
        m2 = PAT_WARNING.match(line)
        if m2:
            msg_id = _normalize_msg_id(m2.group("msg_id"))
            msg_text = m2.group("msg").strip()
            entry = LogMessage(
                message_id=msg_id,
                severity="WARNING",
                text=msg_text or line.strip(),
                line_number=lineno,
            )
            summary.warning_count += 1
            summary.messages.append(entry)
            continue

    return summary


def _normalize_msg_id(raw: str) -> str:
    """Clean up a message ID like 'Synth 8-439' or 'Common 17-69'."""
    raw = raw.strip().rstrip("]")
    if " " not in raw and "-" in raw:
        # e.g. "Synth8-439" -> "Synth 8-439"
        m = re.match(r"([A-Za-z]+)(\d+-\d+)", raw)
        if m:
            return f"{m.group(1)} {m.group(2)}"
    return raw


def load_and_parse(path: str | Path) -> VivadoLogSummary:
    """Convenience: load a log file and parse it."""
    return parse_vivado_log(Path(path).read_text(errors="replace"))
