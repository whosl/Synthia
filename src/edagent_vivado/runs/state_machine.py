"""Run state machine — validate transitions."""

from __future__ import annotations

from typing import Literal, Set

RunState = Literal[
    "created",
    "started",
    "queued",
    "running",
    "waiting_for_approval",
    "succeeded",
    "succeeded_with_warnings",
    "done",
    "failed",
    "cancelled",
    "policy_denied",
]

_TRANSITIONS: dict[str, Set[str]] = {
    "created": {"queued", "running", "cancelled", "policy_denied", "failed"},
    "started": {"queued", "running", "cancelled", "policy_denied", "failed", "done", "failed"},
    "queued": {"running", "cancelled"},
    "running": {
        "waiting_for_approval",
        "succeeded",
        "succeeded_with_warnings",
        "done",
        "failed",
        "cancelled",
        "policy_denied",
    },
    "waiting_for_approval": {"running", "cancelled", "policy_denied", "failed"},
    "succeeded": set(),
    "succeeded_with_warnings": set(),
    "done": set(),
    "failed": set(),
    "cancelled": set(),
    "policy_denied": set(),
}

_TERMINAL: Set[str] = {
    "succeeded",
    "succeeded_with_warnings",
    "done",
    "failed",
    "cancelled",
    "policy_denied",
}


def is_terminal(state: str) -> bool:
    return state in _TERMINAL


def can_transition(from_state: str, to_state: str) -> bool:
    return to_state in _TRANSITIONS.get(from_state, set())


class InvalidTransition(ValueError):
    pass


def assert_transition(from_state: str, to_state: str) -> None:
    if not can_transition(from_state, to_state):
        raise InvalidTransition(f"{from_state} → {to_state} not allowed")
