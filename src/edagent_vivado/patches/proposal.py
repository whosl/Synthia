"""PatchProposal data model + state machine — Phase 7."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


class PatchState(str, Enum):
    DRAFT = "draft"
    PROPOSED = "proposed"
    APPROVED = "approved"
    REJECTED = "rejected"
    APPLIED = "applied"
    REVERTED = "reverted"
    SUPERSEDED = "superseded"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class PatchAction(str, Enum):
    CREATE = "create"
    MODIFY = "modify"
    DELETE = "delete"


_TRANSITIONS: dict[PatchState, set[PatchState]] = {
    PatchState.DRAFT: {PatchState.PROPOSED, PatchState.REJECTED, PatchState.SUPERSEDED},
    PatchState.PROPOSED: {PatchState.APPROVED, PatchState.REJECTED, PatchState.SUPERSEDED},
    PatchState.APPROVED: {PatchState.APPLIED, PatchState.REJECTED, PatchState.SUPERSEDED},
    PatchState.APPLIED: {PatchState.REVERTED},
    PatchState.REJECTED: set(),
    PatchState.REVERTED: set(),
    PatchState.SUPERSEDED: set(),
}


class InvalidPatchTransition(ValueError):
    pass


def assert_patch_transition(src: PatchState | str, dst: PatchState | str) -> None:
    s = PatchState(src) if isinstance(src, str) else src
    d = PatchState(dst) if isinstance(dst, str) else dst
    if d not in _TRANSITIONS.get(s, set()):
        raise InvalidPatchTransition(f"{s.value} → {d.value} not allowed")


def is_patch_terminal(state: PatchState | str) -> bool:
    s = PatchState(state) if isinstance(state, str) else state
    return s in (
        PatchState.APPLIED,
        PatchState.REJECTED,
        PatchState.REVERTED,
        PatchState.SUPERSEDED,
    )


@dataclass
class PatchChange:
    path: str
    action: str
    file_category: str
    before_sha256: str = ""
    after_sha256: str = ""
    before_text: str = ""
    after_text: str = ""
    diff_text: str = ""
    is_binary: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class PatchProposal:
    id: str
    session_id: str
    task_id: str
    run_id: str
    project_id: str
    title: str
    summary: str
    rationale: str
    risk_level: str
    state: str = PatchState.DRAFT.value
    created_by: str = "agent"
    changes: list[PatchChange] = field(default_factory=list)
    created_at: int = 0
    updated_at: int = 0
    applied_at: int | None = None
    reviewer_id: str = ""
    review_reason: str = ""
    superseded_by: str = ""
    spawned_run_id: str = ""
    approval_id: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["changes"] = [c.to_dict() for c in self.changes]
        return d

    @classmethod
    def new(
        cls,
        *,
        session_id: str,
        task_id: str = "",
        run_id: str = "",
        project_id: str = "",
        title: str,
        summary: str,
        rationale: str,
        risk_level: str,
        changes: list[PatchChange],
        created_by: str = "agent",
    ) -> PatchProposal:
        now = int(time.time() * 1000)
        return cls(
            id=str(uuid.uuid4()),
            session_id=session_id,
            task_id=task_id,
            run_id=run_id,
            project_id=project_id,
            title=title,
            summary=summary,
            rationale=rationale,
            risk_level=risk_level,
            changes=changes,
            created_by=created_by,
            created_at=now,
            updated_at=now,
        )


def compute_sha256(text: str | bytes) -> str:
    if isinstance(text, str):
        text = text.encode("utf-8")
    return hashlib.sha256(text).hexdigest()


def serialize(proposal: PatchProposal) -> str:
    return json.dumps(proposal.to_dict(), ensure_ascii=False, default=str)
