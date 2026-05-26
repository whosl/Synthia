"""Pydantic schemas for admin / migration routes."""

from __future__ import annotations

from pydantic import BaseModel


class ResolveMigrationReq(BaseModel):
    project_id: str
