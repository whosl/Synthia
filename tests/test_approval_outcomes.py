"""Tests for structured approval / execution outcomes."""

import json

from edagent_vivado.harness.approval_apply import format_approval_tool_output
from edagent_vivado.harness.approval_outcomes import (
    OUTCOME_EXECUTION_FAILED,
    OUTCOME_USER_REJECTED,
    continuation_prompt,
    format_user_rejection,
    tool_ui_state_from_output,
    is_execution_failure,
    is_user_rejection,
    parse_tool_outcome,
    should_continue_after_approval,
    tag_execution_result,
)


def test_user_rejection_json():
    out = format_user_rejection("vivado_synth")
    data = json.loads(out)
    assert data["edagent_outcome"] == OUTCOME_USER_REJECTED
    assert data["ran"] is False
    assert is_user_rejection(out)
    assert not is_execution_failure(out)
    assert tool_ui_state_from_output(out) == "rejected"


def test_execution_failed_vs_rejection():
    fail = tag_execution_result({"step": "synth", "success": False, "return_code": 1})
    data = json.loads(fail)
    assert data["edagent_outcome"] == OUTCOME_EXECUTION_FAILED
    assert data["ran"] is True
    assert is_execution_failure(fail)
    assert not is_user_rejection(fail)


def test_file_rejection_outcome():
    out = format_approval_tool_output([], ["/b.v"])
    data = json.loads(out)
    assert data["edagent_outcome"] == OUTCOME_USER_REJECTED


def test_continuation_prompt_user_rejected():
    out = format_user_rejection("vivado_synth")
    prompt = continuation_prompt(out)
    assert "user_rejected" in prompt
    assert "NOT an execution error" in prompt


def test_should_continue_rejected():
    out = format_user_rejection("file_changes")
    assert should_continue_after_approval(out)
