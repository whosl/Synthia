"""Per-session Run scheduler — Phase 5.5.

Serial-per-session via threading.Lock. v1.0 keeps it process-local; Phase 11
will swap to a Redis-backed distributed lock + worker pool, while preserving
the helper surface (`run_in_session`, `is_session_busy`, `start_run_async`).
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Callable

logger = logging.getLogger(__name__)


_locks: dict[str, threading.Lock] = {}
_locks_mu = threading.Lock()


def _get_session_lock(session_id: str) -> threading.Lock:
    """Get-or-create the per-session lock (registry guarded by _locks_mu)."""
    with _locks_mu:
        lock = _locks.get(session_id)
        if lock is None:
            lock = threading.Lock()
            _locks[session_id] = lock
        return lock


class SessionBusy(RuntimeError):
    """Raised when a session lock cannot be acquired within *timeout*."""


def run_in_session(
    session_id: str,
    fn: Callable[[], Any],
    *,
    timeout: float | None = None,
) -> Any:
    """Acquire the session lock and execute *fn*.

    - Empty session_id => no serialization (CLI / scripts / tests w/o session).
    - timeout=None     => block indefinitely.
    - timeout<=0       => non-blocking; raises SessionBusy if held.
    """
    if not session_id:
        return fn()

    lock = _get_session_lock(session_id)
    if timeout is None:
        lock.acquire()
        acquired = True
    elif timeout <= 0:
        acquired = lock.acquire(blocking=False)
    else:
        acquired = lock.acquire(timeout=timeout)

    if not acquired:
        raise SessionBusy(f"session busy: {session_id}")

    try:
        return fn()
    finally:
        lock.release()


def is_session_busy(session_id: str) -> bool:
    """Best-effort check: is this session currently executing a run?"""
    if not session_id:
        return False
    lock = _locks.get(session_id)
    if lock is None:
        return False
    if lock.acquire(blocking=False):
        lock.release()
        return False
    return True


def start_run_async(
    session_id: str,
    fn: Callable[[], Any],
) -> threading.Thread:
    """Spawn a daemon thread that runs *fn* serialised by the session lock."""

    def _worker() -> None:
        try:
            run_in_session(session_id, fn)
        except SessionBusy:
            logger.warning("scheduler: dropped duplicate run for session=%s", session_id)
        except Exception:
            logger.exception("scheduler: background run failed for session=%s", session_id)

    suffix = (session_id[:8] if session_id else "anon")
    thread = threading.Thread(target=_worker, daemon=True, name=f"run-sess-{suffix}")
    thread.start()
    return thread


def _reset_locks_for_tests() -> None:
    """Test-only helper: forget all locks. Do not call from production code."""
    with _locks_mu:
        _locks.clear()
