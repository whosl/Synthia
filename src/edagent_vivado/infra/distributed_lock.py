"""Distributed lock — Redis or in-process fallback — Phase 11."""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from contextlib import contextmanager

logger = logging.getLogger(__name__)

_RELEASE_LUA = """
if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
else
    return 0
end
"""

_local_locks: dict[str, threading.Lock] = {}
_local_guard = threading.Lock()


class LockNotAcquired(Exception):
    pass


def _use_local() -> bool:
    if os.environ.get("SYNTHIA_LOCK_BACKEND", "").lower() == "local":
        return True
    from edagent_vivado.infra.redis_client import redis_available

    return not redis_available()


@contextmanager
def acquire_lock(key: str, *, timeout_ms: int = 30000, wait_ms: int = 5000):
    if _use_local():
        with _local_guard:
            lock = _local_locks.setdefault(key, threading.Lock())
        acquired = lock.acquire(timeout=wait_ms / 1000 if wait_ms > 0 else -1)
        if not acquired:
            raise LockNotAcquired(f"could not acquire lock '{key}'")
        try:
            yield
        finally:
            lock.release()
        return

    from edagent_vivado.infra.redis_client import get_redis

    r = get_redis()
    token = str(uuid.uuid4())
    deadline = time.time() + wait_ms / 1000
    full_key = f"synthia:lock:{key}"

    while time.time() < deadline:
        ok = r.set(full_key, token, nx=True, px=timeout_ms)
        if ok:
            try:
                yield
            finally:
                try:
                    r.eval(_RELEASE_LUA, 1, full_key, token)
                except Exception:
                    logger.exception("lock release failed for %s", key)
            return
        time.sleep(0.05)

    raise LockNotAcquired(f"could not acquire lock '{key}' within {wait_ms}ms")
