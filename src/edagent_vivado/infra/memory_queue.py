"""In-process queue for tests / dev without Redis — Phase 11."""

from __future__ import annotations

import json
import threading
import time
import uuid
from collections import deque
from typing import Any

_lock = threading.Lock()
_queues: dict[str, deque[tuple[str, dict[str, str]]]] = {}


def enqueue(pool: str, payload: dict[str, Any], *, priority: int = 5, task_id: str = "") -> str:
    tid = task_id or str(uuid.uuid4())
    entry_id = f"{int(time.time() * 1000)}-0"
    fields = {
        "task_id": tid,
        "payload": json.dumps(payload, ensure_ascii=False),
        "priority": str(priority),
        "enqueued_at": str(int(time.time() * 1000)),
    }
    with _lock:
        _queues.setdefault(pool, deque()).append((entry_id, fields))
    return entry_id


def dequeue(
    pool: str,
    *,
    consumer_name: str,
    group: str = "synthia-workers",
    block_ms: int = 5000,
    count: int = 1,
) -> list[tuple[str, dict[str, Any]]]:
    del consumer_name, group, block_ms
    out: list[tuple[str, dict[str, Any]]] = []
    with _lock:
        q = _queues.get(pool)
        if not q:
            return out
        while q and len(out) < count:
            entry_id, fields = q.popleft()
            try:
                payload = json.loads(fields.get("payload", "{}"))
            except json.JSONDecodeError:
                payload = {}
            payload["__entry_id"] = entry_id
            payload["__task_id"] = fields.get("task_id", "")
            out.append((entry_id, payload))
    return out


def ack(pool: str, entry_id: str, *, group: str = "synthia-workers") -> None:
    del pool, entry_id, group


def queue_depth(pool: str) -> int:
    with _lock:
        return len(_queues.get(pool, deque()))


def pending_count(pool: str, *, group: str = "synthia-workers") -> int:
    del group
    return queue_depth(pool)


def reset_queues() -> None:
    with _lock:
        _queues.clear()
