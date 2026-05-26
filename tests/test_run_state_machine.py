import pytest

from edagent_vivado.runs.state_machine import (
    InvalidTransition,
    assert_transition,
    can_transition,
    is_terminal,
)


def test_basic_happy_path():
    assert can_transition("created", "queued")
    assert can_transition("queued", "running")
    assert can_transition("running", "done")


def test_terminal_no_outgoing():
    for s in ("done", "failed", "cancelled", "policy_denied"):
        assert is_terminal(s)
        assert not can_transition(s, "running")


def test_invalid_transition_raises():
    with pytest.raises(InvalidTransition):
        assert_transition("created", "done")
    with pytest.raises(InvalidTransition):
        assert_transition("done", "running")


def test_approval_pause_and_resume():
    assert can_transition("running", "waiting_for_approval")
    assert can_transition("waiting_for_approval", "running")
    assert can_transition("waiting_for_approval", "cancelled")
