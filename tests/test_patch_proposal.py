"""Phase 7 — PatchProposal state machine."""

from __future__ import annotations

import pytest

from edagent_vivado.patches.proposal import (
    InvalidPatchTransition,
    PatchState,
    assert_patch_transition,
    is_patch_terminal,
)


def test_proposed_to_approved():
    assert_patch_transition(PatchState.PROPOSED, PatchState.APPROVED)


def test_proposed_to_rejected():
    assert_patch_transition(PatchState.PROPOSED, PatchState.REJECTED)


def test_applied_to_reverted():
    assert_patch_transition(PatchState.APPLIED, PatchState.REVERTED)


def test_illegal_applied_to_proposed():
    with pytest.raises(InvalidPatchTransition):
        assert_patch_transition(PatchState.APPLIED, PatchState.PROPOSED)


def test_terminal_states():
    assert is_patch_terminal(PatchState.APPLIED)
    assert is_patch_terminal(PatchState.REJECTED)
    assert not is_patch_terminal(PatchState.PROPOSED)
