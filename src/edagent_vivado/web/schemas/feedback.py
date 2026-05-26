"""Pydantic schemas for feedback routes."""

from __future__ import annotations

from pydantic import BaseModel


class FeedbackReq(BaseModel):
    session_id: str
    task_id: str | None = None
    message_id: str | None = None
    user_thumb: int | None = None
    comment: str | None = None
    tags: list[str] | None = None
    metadata: dict | None = None
