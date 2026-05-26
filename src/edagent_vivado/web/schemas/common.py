"""Common Pydantic types shared across routes."""

from __future__ import annotations

from typing import TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class TimestampMixin(BaseModel):
    created_at: int | None = None
    updated_at: int | None = None


class PaginationMeta(BaseModel):
    total: int = 0
    limit: int = 100
    offset: int = 0


class ErrorResponse(BaseModel):
    error: str
    detail: str | None = None
    scope: str | None = None


class IdResponse(BaseModel):
    id: str
