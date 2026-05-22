"""Report analysis tools for the agent."""

from __future__ import annotations

import json
from pathlib import Path

from langchain_core.tools import tool

from edagent_vivado.kb.error_case_loader import load_cases, match_cases
from edagent_vivado.parsers.timing_parser import parse_timing_summary
from edagent_vivado.parsers.utilization_parser import parse_utilization
from edagent_vivado.parsers.vivado_log_parser import load_and_parse


@tool
def parse_vivado_log_tool(log_path: str) -> str:
    """Parse a Vivado log file and return a structured summary of errors, warnings, and message IDs.

    Args:
        log_path: Path to the Vivado log file (.log or .jou).
    """
    try:
        p = Path(log_path)
        if not p.exists():
            return f"ERROR: Log file not found: {log_path}"
        summary = load_and_parse(p)
        return json.dumps({
            "error_count": summary.error_count,
            "critical_warning_count": summary.critical_warning_count,
            "warning_count": summary.warning_count,
            "total_messages": len(summary.messages),
            "top_error_signatures": summary.top_error_signatures[:10],
        }, indent=2)
    except Exception as e:
        return f"ERROR parsing log: {e}"


@tool
def parse_timing_tool(report_path: str) -> str:
    """Parse a Vivado timing summary report and extract WNS/TNS/WHS/THS values.

    Args:
        report_path: Path to the timing summary report file.
    """
    try:
        p = Path(report_path)
        if not p.exists():
            return f"ERROR: Report not found: {report_path}"
        timing = parse_timing_summary(p.read_text(errors="replace"))
        if timing is None:
            return "Could not parse timing summary (report may be empty or malformed)"
        return json.dumps({
            "wns": timing.wns,
            "tns": timing.tns,
            "whs": timing.whs,
            "ths": timing.ths,
        }, indent=2)
    except Exception as e:
        return f"ERROR parsing timing report: {e}"


@tool
def parse_utilization_tool(report_path: str) -> str:
    """Parse a Vivado utilization report and extract LUT/FF/BRAM/DSP counts.

    Args:
        report_path: Path to the utilization report file.
    """
    try:
        p = Path(report_path)
        if not p.exists():
            return f"ERROR: Report not found: {report_path}"
        util = parse_utilization(p.read_text(errors="replace"))
        if util is None:
            return "Could not parse utilization report"
        return json.dumps({
            "lut": util.lut,
            "ff": util.ff,
            "bram": util.bram,
            "dsp": util.dsp,
        }, indent=2)
    except Exception as e:
        return f"ERROR parsing utilization report: {e}"


@tool
def match_error_cases_tool(error_signatures: str) -> str:
    """Match error signatures against the knowledge base of known Vivado error patterns.

    Args:
        error_signatures: A JSON list of error signature strings (e.g. from parse_vivado_log_tool).
    """
    try:
        import json as _json
        sigs = _json.loads(error_signatures) if isinstance(error_signatures, str) else error_signatures
        if not isinstance(sigs, list):
            sigs = [sigs]
        cases = load_cases()
        matches = match_cases(sigs, cases)
        if not matches:
            return "No matching error cases found in the knowledge base."

        results = []
        for case, sig in matches:
            results.append({
                "matched_signature": sig,
                "category": case.category,
                "likely_causes": case.likely_causes,
                "suggested_actions": case.suggested_actions,
            })
        return _json.dumps(results, indent=2, ensure_ascii=False)
    except Exception as e:
        return f"ERROR matching error cases: {e}"
