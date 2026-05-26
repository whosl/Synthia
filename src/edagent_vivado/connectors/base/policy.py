"""Connector policy types — aligned with harness/tcl_policy and SPEC §9B.7."""

from __future__ import annotations

from edagent_vivado.connectors.base.types import PolicyResult, PolicyVerdict, RiskLevel
from edagent_vivado.harness.tcl_policy import PolicyResult as TclPolicyResult


def policy_from_tcl(result: TclPolicyResult, *, risk_level: RiskLevel = "medium") -> PolicyResult:
    """Map legacy Tcl PolicyResult into connector PolicyResult."""
    if not result.allowed:
        verdict: PolicyVerdict = "denied"
    elif result.requires_approval:
        verdict = "needs_approval"
    else:
        verdict = "allowed"
    reasons = [result.reason] if result.reason else list(result.matched_rules)
    return PolicyResult(
        verdict=verdict,
        risk_level=risk_level,
        reasons=reasons,
        blocked_tokens=[],
    )
