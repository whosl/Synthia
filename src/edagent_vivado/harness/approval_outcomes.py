"""Structured tool outcomes so the agent can tell user rejection from execution failure."""

from __future__ import annotations

import json
from typing import Any

# Machine-readable outcome kinds (always in JSON field edagent_outcome)
OUTCOME_USER_REJECTED = "user_rejected"
OUTCOME_EXECUTION_FAILED = "execution_failed"
OUTCOME_EXECUTION_SUCCEEDED = "execution_succeeded"
OUTCOME_APPROVED = "approved"
OUTCOME_PARTIALLY_APPROVED = "partially_approved"
OUTCOME_TIMEOUT = "timeout"
OUTCOME_QUEUED = "queued"

# Scopes — what the user was asked to approve
SCOPE_VIVADO_SYNTH = "vivado_synth"
SCOPE_VIVADO_IMPL = "vivado_impl"
SCOPE_VIVADO_TCL = "vivado_tcl"
SCOPE_VIVADO_SCRIPT = "vivado_script"
SCOPE_VIVADO_FLOW = "vivado_flow"
SCOPE_FILE_CHANGES = "file_changes"
SCOPE_INPUT_REQUEST = "input_request"


def format_tool_outcome(
    outcome: str,
    summary: str,
    *,
    scope: str | None = None,
    ran: bool | None = None,
    success: bool | None = None,
    extra: dict[str, Any] | None = None,
) -> str:
    """Return JSON tool output with a stable edagent_outcome field."""
    payload: dict[str, Any] = {
        "edagent_outcome": outcome,
        "summary": summary,
    }
    if scope is not None:
        payload["scope"] = scope
    if ran is not None:
        payload["ran"] = ran
    if success is not None:
        payload["success"] = success
    if extra:
        payload.update(extra)
    return json.dumps(payload, indent=2, ensure_ascii=False, default=str)


def format_user_rejection(
    scope: str,
    *,
    detail: str = "",
    tool_name: str | None = None,
) -> str:
    """User clicked Reject — command did NOT run (or changes were NOT applied)."""
    summary = detail or {
        SCOPE_VIVADO_SYNTH: "User declined Vivado synthesis in the approval UI. Synthesis did not run.",
        SCOPE_VIVADO_IMPL: "User declined Vivado implementation in the approval UI. Place/route did not run.",
        SCOPE_VIVADO_TCL: "User declined running this Vivado Tcl command. The command did not execute.",
        SCOPE_VIVADO_SCRIPT: "User declined running this Vivado Tcl script. The script did not execute.",
        SCOPE_VIVADO_FLOW: "User declined the full Vivado flow (synth + implementation). It did not run.",
        SCOPE_FILE_CHANGES: "User rejected the proposed file changes. No files were applied.",
        SCOPE_INPUT_REQUEST: "User declined to provide the requested information.",
    }.get(scope, "User rejected the pending approval request.")
    if tool_name:
        summary = f"{summary} (tool: {tool_name})"
    return format_tool_outcome(
        OUTCOME_USER_REJECTED,
        summary,
        scope=scope,
        ran=False,
        success=False,
    )


def format_execution_failed(
    scope: str,
    error: str,
    *,
    extra: dict[str, Any] | None = None,
) -> str:
    """Vivado/command ran but failed — NOT a user rejection."""
    body = extra or {}
    return format_tool_outcome(
        OUTCOME_EXECUTION_FAILED,
        f"Command ran but failed: {error}",
        scope=scope,
        ran=True,
        success=False,
        extra={**body, "error": error},
    )


def tag_execution_result(result: dict[str, Any], scope: str = SCOPE_VIVADO_SYNTH) -> str:
    """Tag a Vivado runner result dict with edagent_outcome."""
    out = dict(result)
    ok = bool(out.get("success"))
    out["edagent_outcome"] = OUTCOME_EXECUTION_SUCCEEDED if ok else OUTCOME_EXECUTION_FAILED
    out["scope"] = scope
    out["ran"] = True
    labels = {
        SCOPE_VIVADO_SYNTH: ("Synthesis", "synthesis"),
        SCOPE_VIVADO_IMPL: ("Implementation", "implementation"),
        SCOPE_VIVADO_TCL: ("Tcl command", "command"),
        SCOPE_VIVADO_SCRIPT: ("Tcl script", "script"),
        SCOPE_VIVADO_FLOW: ("Synthesis + implementation", "flow"),
    }
    label, noun = labels.get(scope, ("Vivado step", "step"))
    if not ok:
        out.setdefault(
            "summary",
            f"{label} ran but failed (return_code={out.get('return_code', out.get('exit_code'))}). "
            f"This is an execution error, NOT a user rejection.",
        )
    else:
        out.setdefault("summary", f"{label} completed successfully.")
    return json.dumps(out, indent=2, ensure_ascii=False, default=str)


def tag_vivado_adapter_result(result: Any, scope: str) -> str:
    """Tag VivadoResult from VivadoRuntimeAdapter as JSON tool output."""
    payload = {
        "success": result.success,
        "exit_code": result.exit_code,
        "stdout": (result.stdout or "")[:5000],
        "stderr": (result.stderr or "")[:2000],
        "elapsed_sec": result.elapsed_sec,
        "error": result.error,
        "command_type": result.command_type,
        "target_id": result.target_id,
    }
    return tag_execution_result(payload, scope=scope)


def tool_ui_state_from_output(output: str, payload_state: str | None = None) -> str:
    """UI state for tool.completed events: completed | rejected | error."""
    if payload_state in ("rejected", "error", "completed"):
        return payload_state
    parsed = parse_tool_outcome(output)
    outcome = parsed.get("edagent_outcome")
    if outcome == OUTCOME_USER_REJECTED:
        return "rejected"
    if outcome == OUTCOME_EXECUTION_FAILED:
        return "error"
    return "completed"


def parse_tool_outcome(output: str) -> dict[str, Any]:
    """Parse tool output; returns at least {edagent_outcome, summary} if recognizable."""
    text = (output or "").strip()
    if not text:
        return {"edagent_outcome": "unknown", "summary": ""}
    if text.startswith("{"):
        try:
            data = json.loads(text)
            if isinstance(data, dict) and "edagent_outcome" in data:
                return data
        except json.JSONDecodeError:
            pass
    upper = text.upper()
    if upper.startswith("QUEUED_FOR_APPROVAL"):
        return {"edagent_outcome": OUTCOME_QUEUED, "summary": text}
    if upper.startswith("TIMEOUT"):
        return {"edagent_outcome": OUTCOME_TIMEOUT, "summary": text}
    if "USER DECLINED" in upper or upper.startswith("REJECTED"):
        return {
            "edagent_outcome": OUTCOME_USER_REJECTED,
            "summary": text,
            "ran": False,
            "legacy_text": True,
        }
    if upper.startswith("APPROVED") or "PARTIALLY APPROVED" in upper:
        outcome = OUTCOME_PARTIALLY_APPROVED if "PARTIALLY" in upper else OUTCOME_APPROVED
        return {"edagent_outcome": outcome, "summary": text, "legacy_text": True}
    return {"edagent_outcome": "unknown", "summary": text}


def is_user_rejection(output: str) -> bool:
    return parse_tool_outcome(output).get("edagent_outcome") == OUTCOME_USER_REJECTED


def is_execution_failure(output: str) -> bool:
    return parse_tool_outcome(output).get("edagent_outcome") == OUTCOME_EXECUTION_FAILED


def should_continue_after_approval(output: str) -> bool:
    parsed = parse_tool_outcome(output)
    outcome = parsed.get("edagent_outcome")
    if outcome in (OUTCOME_TIMEOUT, OUTCOME_QUEUED, "unknown"):
        return False
    return outcome in (
        OUTCOME_APPROVED,
        OUTCOME_PARTIALLY_APPROVED,
        OUTCOME_USER_REJECTED,
    )


def continuation_prompt(approval_output: str) -> str:
    parsed = parse_tool_outcome(approval_output)
    outcome = parsed.get("edagent_outcome")
    summary = parsed.get("summary", approval_output)

    if outcome == OUTCOME_USER_REJECTED:
        scope = parsed.get("scope", "unknown")
        ran = parsed.get("ran", False)
        return (
            "[System — user rejected approval (NOT an execution error)]\n"
            f"edagent_outcome: user_rejected\n"
            f"scope: {scope}\n"
            f"ran: {ran}\n"
            f"summary: {summary}\n\n"
            "Important: The user explicitly rejected this step in the UI. "
            "Do NOT describe Vivado log errors, synthesis failure, or timing issues for this step — "
            "the command did not run (or file changes were not applied).\n"
            "Ask the user what they want to do next, or offer a different approach."
        )

    if outcome == OUTCOME_PARTIALLY_APPROVED:
        return (
            "[System — user partially approved file changes]\n"
            f"summary: {summary}\n"
            "Applied files are on disk. Continue with the next step; "
            "do not re-request approval for files already approved."
        )

    return (
        "[System — user completed approval]\n"
        f"edagent_outcome: {outcome}\n"
        f"summary: {summary}\n"
        "Continue with your planned next step (e.g. re-run synthesis). "
        "Do not ask the user to approve the same changes again."
    )
