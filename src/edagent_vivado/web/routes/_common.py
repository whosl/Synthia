"""Shared helpers for split route modules."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger(__name__)


def not_found(detail: str = "resource not found") -> HTTPException:
    return HTTPException(status_code=404, detail=detail)


def bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def server_error(exc: Exception, scope: str = "") -> HTTPException:
    logger.exception("server_error in %s", scope)
    return HTTPException(status_code=500, detail=f"{scope}: {exc}")


def ok(data: Any) -> dict:
    """Wrap a payload in a stable response shape (optional convention)."""
    return {"data": data}
