"""Harness ProblemCollector — force problem detection from tool/Vivado outputs."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Callable

from edagent_vivado.harness.approval_outcomes import (
    OUTCOME_EXECUTION_FAILED,
    parse_tool_outcome,
)
from edagent_vivado.repository.store import problem_create

EventSink = Callable[[str, dict], Any]

_ERROR_LINE = re.compile(r"^(ERROR|CRITICAL WARNING):\s*(.+)", re.MULTILINE | re.IGNORECASE)
_LOG_PATH = re.compile(r"([\w./\\:-]+\.log)\b", re.IGNORECASE)


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


def _problems_from_vivado_log_paths(text: str, source: str, tool_name: str = "") -> list[dict]:
    """If tool output references a Vivado log file, parse it for structured problems."""
    problems: list[dict] = []
    seen_paths: set[str] = set()
    for m in _LOG_PATH.finditer(text):
        raw = m.group(1).strip().strip("'\"")
        if raw in seen_paths:
            continue
        seen_paths.add(raw)
        path = Path(raw)
        if not path.is_file():
            continue
        try:
            from edagent_vivado.parsers.vivado_log_parser import load_and_parse

            summary = load_and_parse(path)
        except OSError:
            continue
        for entry in summary.messages:
            if entry.severity not in ("ERROR", "CRITICAL WARNING"):
                continue
            msg = f"[{entry.message_id}] {entry.text}"[:500]
            problems.append({
                "message": msg,
                "severity": "error" if entry.severity == "ERROR" else "critical",
                "category": "vivado",
                "signature": msg[:120],
                "source": source,
                "metadata": {"tool_name": tool_name, "log_path": str(path)},
            })
    return problems


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
    problems.extend(_problems_from_vivado_log_paths(text, source, tool_name))
    vivado_tools = {
        "run_vivado_synth_tool": "vivado_synth",
        "run_vivado_impl_tool": "vivado_impl",
        "run_vivado_tcl_tool": "vivado_tcl",
        "run_vivado_script_tool": "vivado_script",
        "run_vivado_flow_tool": "vivado_flow",
    }
    if tool_name in vivado_tools and problems:
        cat = vivado_tools[tool_name]
        for p in problems:
            if not p.get("category"):
                p["category"] = cat
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
