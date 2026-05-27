"""Classify PatchProposal risk based on file paths + actions — Phase 7."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from edagent_vivado.patches.proposal import PatchChange


@dataclass
class RiskAssessment:
    overall: str
    auto_apply: bool
    requires_strong_approval: bool
    denied: bool
    reasons: list[str]

    def to_dict(self) -> dict:
        return {
            "overall": self.overall,
            "auto_apply": self.auto_apply,
            "requires_strong_approval": self.requires_strong_approval,
            "denied": self.denied,
            "reasons": self.reasons,
        }


_RISK_RANK = {"low": 0, "medium": 1, "high": 2}


def classify_file(path: str) -> str:
    p = path.lower().replace("\\", "/")
    if p.endswith((".v", ".sv", ".svh", ".vh", ".vhd", ".vhdl")):
        return "rtl"
    if p.endswith((".xdc", ".sdc")):
        return "xdc"
    if p.endswith(".tcl"):
        return "tcl"
    if p.endswith((".yaml", ".yml")) and ".synthia" in p:
        return "manifest"
    if p.endswith(".xpr"):
        return "xpr"
    return "other"


def classify_risk(changes: Iterable[PatchChange]) -> RiskAssessment:
    reasons: list[str] = []
    overall = "low"
    auto_apply = True
    requires_strong = False
    denied = False

    for c in changes:
        cat = c.file_category or classify_file(c.path)
        action = c.action

        if cat == "xpr":
            overall = _max_level(overall, "high")
            auto_apply = False
            reasons.append(f"xpr overwrite: {c.path}")
            continue

        if action == "delete" and cat != "tcl":
            denied = True
            overall = "high"
            auto_apply = False
            reasons.append(f"delete denied for {cat}: {c.path}")
            continue

        if cat == "rtl":
            if _is_testbench_path(c.path):
                overall = _max_level(overall, "medium")
                reasons.append(f"RTL testbench change (medium): {c.path}")
            else:
                requires_strong = True
                overall = _max_level(overall, "high")
                auto_apply = False
                reasons.append(f"RTL change (strong approval): {c.path}")
            continue

        if cat == "xdc":
            overall = _max_level(overall, "medium")
            auto_apply = False
            reasons.append(f"XDC change requires approval: {c.path}")
            continue

        if cat == "manifest":
            overall = _max_level(overall, "low")
            reasons.append(f"manifest auto-apply (diff recorded): {c.path}")
            continue

        if cat == "tcl":
            reasons.append(f"tcl auto-apply: {c.path}")
            continue

        overall = _max_level(overall, "medium")
        auto_apply = False
        reasons.append(f"unknown category, requires approval: {c.path}")

    return RiskAssessment(
        overall=overall,
        auto_apply=auto_apply and not denied and not requires_strong,
        requires_strong_approval=requires_strong,
        denied=denied,
        reasons=reasons,
    )


def _max_level(a: str, b: str) -> str:
    return a if _RISK_RANK.get(a, 0) >= _RISK_RANK.get(b, 0) else b


def _is_testbench_path(path: str) -> bool:
    p = path.lower().replace("\\", "/")
    return "/tb/" in p or p.endswith("_tb.v") or p.endswith("_tb.sv")
