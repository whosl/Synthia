"""Pydantic schemas for evolution routes."""

from __future__ import annotations

from pydantic import BaseModel


class CandidateApproveReq(BaseModel):
    reviewed_by: str = "user"
    payload: dict | None = None
    force_active: bool = False
    confirm_source_reviewed: bool = False


class ToolValidateReq(BaseModel):
    source: str
    name: str | None = None


class CandidateRejectReq(BaseModel):
    reviewed_by: str = "user"
    suppress_days: int = 0
    reason: str | None = None


class CandidateMergeReq(BaseModel):
    reviewed_by: str = "user"


class CandidateRollbackReq(BaseModel):
    reviewed_by: str = "user"
    reason: str | None = None


class TrialConfigSetReq(BaseModel):
    project_id: str
    surface: str
    enabled: bool


class TrialDecideReq(BaseModel):
    decision: str
    reviewed_by: str = "user"


class TrialAbortReq(BaseModel):
    reason: str = "manual_abort"


class EvalRunReq(BaseModel):
    eval_set: str
    project_id: str | None = None
    overlay_id: str | None = None
    note: str = ""


class GeneratorRunReq(BaseModel):
    project_id: str | None = None
    session_id: str = ""
    task_id: str = ""
    only: list[str] | None = None
