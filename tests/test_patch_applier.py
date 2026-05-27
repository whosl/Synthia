"""Phase 7 — apply / revert PatchProposal."""

from __future__ import annotations

from edagent_vivado.patches.applier import apply_proposal, revert_proposal
from edagent_vivado.patches.proposal import PatchChange, PatchProposal, PatchState, compute_sha256


def _proposal(tmp_path, before: str, after: str) -> PatchProposal:
    rel = "rtl/top.v"
    fp = tmp_path / rel
    fp.parent.mkdir(parents=True, exist_ok=True)
    fp.write_text(before, encoding="utf-8")
    ch = PatchChange(
        path=rel,
        action="modify",
        file_category="rtl",
        before_text=before,
        after_text=after,
        before_sha256=compute_sha256(before),
        after_sha256=compute_sha256(after),
    )
    p = PatchProposal.new(
        session_id="s1",
        title="fix",
        summary="",
        rationale="test",
        risk_level="high",
        changes=[ch],
    )
    p.state = PatchState.APPROVED.value
    return p


def test_apply_and_revert(tmp_path):
    proposal = _proposal(tmp_path, "wire a;", "wire b;")
    res = apply_proposal(proposal, tmp_path)
    assert res.success
    assert (tmp_path / "rtl" / "top.v").read_text(encoding="utf-8") == "wire b;"

    proposal.state = PatchState.APPLIED.value
    rev = revert_proposal(proposal, tmp_path)
    assert rev.success
    assert (tmp_path / "rtl" / "top.v").read_text(encoding="utf-8") == "wire a;"
