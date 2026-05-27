"""Patch proposal pipeline — Phase 7."""

from edagent_vivado.patches.proposal import (
    InvalidPatchTransition,
    PatchAction,
    PatchChange,
    PatchProposal,
    PatchState,
    RiskLevel,
    assert_patch_transition,
    compute_sha256,
    is_patch_terminal,
)
from edagent_vivado.patches.risk_classifier import RiskAssessment, classify_file, classify_risk

__all__ = [
    "InvalidPatchTransition",
    "PatchAction",
    "PatchChange",
    "PatchProposal",
    "PatchState",
    "RiskLevel",
    "RiskAssessment",
    "assert_patch_transition",
    "classify_file",
    "classify_risk",
    "compute_sha256",
    "is_patch_terminal",
]
