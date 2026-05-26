"""Pydantic schemas for session routes."""

from __future__ import annotations

from pydantic import BaseModel


class UpdateSessionReq(BaseModel):
    name: str | None = None
    status: str | None = None
    metadata: dict | None = None
