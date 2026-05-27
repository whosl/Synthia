"""Run state machine — strict transition validation (Phase 5.5 hardened).

Phase 5.5 changes:
- Drop legacy ``started`` (never used in practice) and ``done`` (redundant with
  ``succeeded``) states from the legal set.
- ``assert_transition`` now ALWAYS raises ``InvalidTransition`` on illegal
  moves; callers that legitimately need a "warn-and-continue" path must use
  :func:`safe_transition_or_log` instead.
- Add ``SYNTHIA_STATE_MACHINE_STRICT`` env override (default strict) for
  emergency opt-out in production.
"""

from __future__ import annotations

import logging
import os
from typing import Literal, Set

logger = logging.getLogger(__name__)

RunState = Literal[
    "created",
    "queued",
    "running",
    "waiting_for_approval",
    "succeeded",
    "succeeded_with_warnings",
    "failed",
    "cancelled",
    "policy_denied",
]


_TRANSITIONS: dict[str, Set[str]] = {
    "created": {"queued", "running", "cancelled", "policy_denied", "failed"},
    "queued": {"running", "cancelled", "policy_denied", "failed"},
    "running": {
        "waiting_for_approval",
        "succeeded",
        "succeeded_with_warnings",
        "failed",
        "cancelled",
        "policy_denied",
    },
    "waiting_for_approval": {"running", "cancelled", "policy_denied", "failed"},
    "succeeded": set(),
    "succeeded_with_warnings": set(),
    "failed": set(),
    "cancelled": set(),
    "policy_denied": set(),
}


_TERMINAL: Set[str] = {
    "succeeded",
    "succeeded_with_warnings",
    "failed",
    "cancelled",
    "policy_denied",
}


def is_terminal(state: str) -> bool:
    return state in _TERMINAL


def can_transition(from_state: str, to_state: str) -> bool:
    return to_state in _TRANSITIONS.get(from_state, set())


class InvalidTransition(ValueError):
    """Raised when an illegal Run state transition is attempted."""


def _strict_mode() -> bool:
    """Whether ``assert_transition`` should raise on illegal moves.

    Default: strict (True). To opt out in production for an emergency rollback,
    set ``SYNTHIA_STATE_MACHINE_STRICT=0``.
    """
    flag = os.environ.get("SYNTHIA_STATE_MACHINE_STRICT", "").strip().lower()
    if flag in ("0", "false", "no", "off"):
        return False
    return True


def assert_transition(from_state: str, to_state: str) -> None:
    """Validate a transition; raise :class:`InvalidTransition` if illegal.

    Honours :func:`_strict_mode` — when strict is off, the transition is only
    logged at WARNING level (mirrors legacy P4 behaviour for rollback).
    """
    if can_transition(from_state, to_state):
        return
    if _strict_mode():
        raise InvalidTransition(f"{from_state} → {to_state} not allowed")
    logger.warning(
        "invalid run transition %s → %s ignored (strict mode disabled)",
        from_state,
        to_state,
    )


def safe_transition_or_log(from_state: str, to_state: str, *, log=None) -> bool:
    """Non-raising variant. Returns True if legal, False otherwise.

    Use this from call sites that genuinely have a recovery path (e.g. cancel
    racing with succeeded). Do **not** use it as a global swallow.
    """
    if can_transition(from_state, to_state):
        return True
    (log or logger).warning(
        "invalid run transition %s → %s ignored at call site",
        from_state,
        to_state,
    )
    return False
