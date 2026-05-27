"""Singleton Redis client — Phase 11."""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    import redis

logger = logging.getLogger(__name__)

_client: Optional["redis.Redis"] = None


def get_redis() -> "redis.Redis":
    global _client
    if _client is None:
        import redis

        url = os.environ.get("SYNTHIA_REDIS_URL", "redis://localhost:6379/0")
        _client = redis.Redis.from_url(url, decode_responses=True, socket_timeout=5.0)
        _client.ping()
    return _client


def redis_available() -> bool:
    if os.environ.get("SYNTHIA_REDIS_URL", "").strip() == "":
        return False
    try:
        get_redis()
        return True
    except Exception:
        return False
