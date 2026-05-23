"""Tcl Policy — SPEC §9A.8: allowlist/denylist/approval for Vivado Tcl commands."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

VIVADO_ALLOWLIST = {
    "synth_design", "opt_design", "place_design", "route_design", "phys_opt_design",
    "write_checkpoint", "open_checkpoint", "read_checkpoint",
    "report_timing_summary", "report_timing", "report_utilization", "report_power",
    "report_drc", "report_methodology", "report_clock_utilization",
    "report_clock_networks", "report_clock_interaction", "report_route_status",
    "read_verilog", "read_vhdl", "read_xdc", "read_ip",
    "add_files", "set_property", "get_property",
    "create_project", "open_project", "close_project",
    "launch_runs", "wait_on_run", "open_run", "reset_run",
    "create_clock", "set_input_delay", "set_output_delay", "set_false_path",
    "set_multicycle_path", "set_max_delay", "set_min_delay",
    "generate_target", "create_ip", "upgrade_ip",
    "write_bitstream", "write_debug_probes",
    "xvlog", "xvhdl", "xelab", "xsim",
    "exit", "quit", "puts", "source",
}

DENY_PATTERNS = [
    re.compile(r"\bexec\b"),
    re.compile(r"\bfile\s+delete\b"),
    re.compile(r"\bfile\s+rename\b"),
    re.compile(r'open\s+"\|'),
    re.compile(r"open\s+\|"),
    re.compile(r"\brm\s+-rf\b"),
    re.compile(r"\bshutdown\b"),
    re.compile(r"\beval\b"),
    re.compile(r"\bnamespace\s+delete\b"),
    re.compile(r"\bpackage\s+require\s+Tcl"),
]

APPROVAL_REQUIRED_PATTERNS = [
    re.compile(r"\bexec\b"),
    re.compile(r"\bfile\s+delete\b"),
    re.compile(r"\bfile\s+rename\b"),
    re.compile(r"\bopen\b.*\|"),
]


@dataclass
class PolicyResult:
    allowed: bool
    requires_approval: bool = False
    reason: str = ""
    matched_rules: list[str] = field(default_factory=list)


def check_tcl_policy(
    command: str,
    require_approval_for_raw: bool = True,
    auto_approved: bool = False,
) -> PolicyResult:
    """Check a Tcl command or script against the security policy.

    Returns a PolicyResult indicating whether execution is allowed.
    """
    cmd_stripped = command.strip()
    if not cmd_stripped:
        return PolicyResult(allowed=False, reason="empty_command")

    for pattern in DENY_PATTERNS:
        if pattern.search(cmd_stripped):
            return PolicyResult(
                allowed=False,
                reason="denied_pattern",
                matched_rules=[pattern.pattern],
            )

    first_word = cmd_stripped.split()[0].lower() if cmd_stripped else ""

    if first_word == "source":
        if require_approval_for_raw and not auto_approved:
            return PolicyResult(
                allowed=True,
                requires_approval=True,
                reason="source_requires_approval",
                matched_rules=["source_script"],
            )
        return PolicyResult(allowed=True)

    if first_word in VIVADO_ALLOWLIST:
        return PolicyResult(allowed=True)

    for pattern in APPROVAL_REQUIRED_PATTERNS:
        if pattern.search(cmd_stripped):
            if auto_approved:
                return PolicyResult(allowed=True)
            return PolicyResult(
                allowed=True,
                requires_approval=True,
                reason="approval_required",
                matched_rules=[pattern.pattern],
            )

    if require_approval_for_raw and not auto_approved:
        return PolicyResult(
            allowed=True,
            requires_approval=True,
            reason="raw_tcl_not_in_allowlist",
            matched_rules=["raw_tcl"],
        )

    return PolicyResult(allowed=True)


def check_tcl_script(script: str, **kwargs) -> PolicyResult:
    """Check an entire Tcl script (multi-line) against the policy."""
    for line_num, line in enumerate(script.splitlines(), 1):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        result = check_tcl_policy(stripped, **kwargs)
        if not result.allowed or result.requires_approval:
            result.reason = f"line {line_num}: {result.reason}"
            return result
    return PolicyResult(allowed=True)
