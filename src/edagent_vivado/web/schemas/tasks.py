"""Pydantic schemas for task routes."""

from __future__ import annotations

from pydantic import BaseModel


class StartTaskReq(BaseModel):
    question: str
    manifest_path: str = ""
    agent_mode: str = "single"
    metadata: dict | None = None
