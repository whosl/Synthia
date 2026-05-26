"""Pydantic schemas for monitor routes."""

from __future__ import annotations

from pydantic import BaseModel


class MonitorCleanupBody(BaseModel):
    retention_days: int = 90
    dry_run: bool = True
