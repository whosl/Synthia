"""Pydantic schemas for approval routes."""

from __future__ import annotations

from pydantic import BaseModel


class ApprovalDecisionReq(BaseModel):
    decided_by: str = "user"
    note: str = ""
