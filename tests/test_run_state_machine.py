"""Phase 5.5(c) — strict run state machine."""

from __future__ import annotations

import pytest

from edagent_vivado.runs.state_machine import (
    InvalidTransition,
    _TRANSITIONS,
    assert_transition,
    can_transition,
    is_terminal,
    safe_transition_or_log,
)


def test_basic_happy_path():
    assert can_transition("created", "queued")
    assert can_transition("queued", "running")
    assert can_transition("running", "succeeded")
    assert can_transition("running", "succeeded_with_warnings")


def test_terminal_no_outgoing():
    for state in (
        "succeeded",
        "succeeded_with_warnings",
        "failed",
        "cancelled",
        "policy_denied",
    ):
        assert is_terminal(state)
        assert not can_transition(state, "running")


def test_legacy_done_and_started_removed():
    """Phase 5.5: ``done`` and ``started`` are not legitimate Run states anymore."""
    assert "done" not in _TRANSITIONS
    assert "started" not in _TRANSITIONS
    assert not is_terminal("done")  # not in _TERMINAL either
    # Transitions referencing them are illegal
    assert not can_transition("created", "done")
    assert not can_transition("created", "started")
    assert not can_transition("started", "running")


def test_assert_transition_raises_on_illegal():
    with pytest.raises(InvalidTransition):
        assert_transition("succeeded", "running")
    with pytest.raises(InvalidTransition):
        assert_transition("running", "done")  # done no longer accepted


def test_assert_transition_strict_env_off(monkeypatch, caplog):
    """SYNTHIA_STATE_MACHINE_STRICT=0 demotes raise to a warning log."""
    monkeypatch.setenv("SYNTHIA_STATE_MACHINE_STRICT", "0")
    with caplog.at_level("WARNING"):
        assert_transition("succeeded", "running")  # no raise
    assert any("invalid run transition" in r.message for r in caplog.records)


def test_safe_transition_returns_bool():
    assert safe_transition_or_log("created", "queued")
    assert not safe_transition_or_log("succeeded", "running")


def test_approval_pause_and_resume():
    assert can_transition("running", "waiting_for_approval")
    assert can_transition("waiting_for_approval", "running")
    assert can_transition("waiting_for_approval", "cancelled")
