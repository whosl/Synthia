"""Harness ProblemCollector — force problem detection from tool/Vivado outputs."""

from __future__ import annotations

import json
import re
from typing import Any, Callable

from edagent_vivado.harness.approval_outcomes import (
    OUTCOME_EXECUTION_FAILED,
    parse_tool_outcome,
)
from edagent_vivado.repository.store import problem_create

EventSink = Callable[[str, dict], Any]

_ERROR_LINE = re.compile(r"^(ERROR|CRITICAL WARNING):\s*(.+)", re.MULTILINE | re.IGNORECASE)


def _problems_from_text(text: str, source: str, tool_name: str = "") -> list[dict]:
    found: list[dict] = []
    for m in _ERROR_LINE.finditer(text):
        msg = m.group(2).strip()[:500]
        sev = "error" if m.group(1).upper().startswith("ERROR") else "critical"
        found.append({
            "message": msg,
            "severity": sev,
            "category": "vivado" if "vivado" in source or "synth" in tool_name else "tool",
            "signature": msg[:120],
            "source": source,
        })
    return found


def collect_from_tool_output(
    tool_name: str,
    output: str,
    *,
    source: str = "tool",
) -> list[dict]:
    """Parse tool output for execution failures and log error lines."""
    problems: list[dict] = []
    text = (output or "").strip()
    if not text:
        return problems

    parsed = parse_tool_outcome(text)
    outcome = parsed.get("edagent_outcome")
    if outcome == OUTCOME_EXECUTION_FAILED:
        problems.append({
            "message": str(parsed.get("summary") or parsed.get("error") or "Tool execution failed")[:500],
            "severity": "error",
            "category": parsed.get("scope") or "execution",
            "signature": f"{tool_name}:execution_failed",
            "source": source,
            "metadata": {"tool_name": tool_name, "outcome": outcome},
        })

    problems.extend(_problems_from_text(text, source, tool_name))
    return problems


def record_problems(
    session_id: str,
    problems: list[dict],
    *,
    task_id: str = "",
    run_id: str = "",
    event_sink: EventSink | None = None,
) -> list[dict]:
    """Persist problems and optionally emit problem.detected events."""
    saved: list[dict] = []
    for p in problems:
        row = problem_create(
            session_id,
            p.get("message", "Unknown problem"),
            source=p.get("source", "harness"),
            task_id=task_id,
            run_id=run_id,
            severity=p.get("severity", "warning"),
            category=p.get("category", ""),
            signature=p.get("signature", ""),
            metadata=p.get("metadata"),
        )
        saved.append(row)
        if event_sink:
            event_sink(
                "problem.detected",
                {
                    "problem_id": row["id"],
                    "message": row["message"],
                    "severity": row.get("severity"),
                    "source": row.get("source"),
                    "category": row.get("category"),
                },
            )
    return saved
