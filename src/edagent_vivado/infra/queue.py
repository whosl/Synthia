"""Task queue — Redis streams or in-memory fallback — Phase 11."""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Any

logger = logging.getLogger(__name__)


def _use_memory() -> bool:
    return os.environ.get("SYNTHIA_QUEUE_BACKEND", "").lower() == "memory"


def enqueue(
    pool: str,
    payload: dict[str, Any],
    *,
    priority: int = 5,
    task_id: str = "",
) -> str:
    if _use_memory():
        from edagent_vivado.infra.memory_queue import enqueue as mem_enqueue

        return mem_enqueue(pool, payload, priority=priority, task_id=task_id)

    from edagent_vivado.infra.redis_client import get_redis

    r = get_redis()
    tid = task_id or str(uuid.uuid4())
    key = f"synthia:queue:{pool}"
    fields = {
        "task_id": tid,
        "payload": json.dumps(payload, ensure_ascii=False),
        "priority": str(priority),
        "enqueued_at": str(int(time.time() * 1000)),
    }
    entry_id = r.xadd(key, fields, maxlen=10000, approximate=True)
    logger.info("enqueued task %s on %s (entry=%s)", tid, pool, entry_id)
    return str(entry_id)


def dequeue(
    pool: str,
    *,
    consumer_name: str,
    group: str = "synthia-workers",
    block_ms: int = 5000,
    count: int = 1,
) -> list[tuple[str, dict[str, Any]]]:
    if _use_memory():
        from edagent_vivado.infra.memory_queue import dequeue as mem_dequeue

        return mem_dequeue(pool, consumer_name=consumer_name, group=group, block_ms=block_ms, count=count)

    import redis as redis_mod

    from edagent_vivado.infra.redis_client import get_redis

    r = get_redis()
    key = f"synthia:queue:{pool}"
    try:
        r.xgroup_create(key, group, id="0", mkstream=True)
    except redis_mod.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise

    results = r.xreadgroup(group, consumer_name, {key: ">"}, count=count, block=block_ms)
    out: list[tuple[str, dict[str, Any]]] = []
    if not results:
        return out
    for _stream_key, entries in results:
        for entry_id, fields in entries:
            try:
                payload = json.loads(fields.get("payload", "{}"))
            except json.JSONDecodeError:
                payload = {}
            payload["__entry_id"] = entry_id
            payload["__task_id"] = fields.get("task_id", "")
            out.append((str(entry_id), payload))
    return out


def ack(pool: str, entry_id: str, *, group: str = "synthia-workers") -> None:
    if _use_memory():
        from edagent_vivado.infra.memory_queue import ack as mem_ack

        mem_ack(pool, entry_id, group=group)
        return
    from edagent_vivado.infra.redis_client import get_redis

    get_redis().xack(f"synthia:queue:{pool}", group, entry_id)


def pending_count(pool: str, *, group: str = "synthia-workers") -> int:
    if _use_memory():
        from edagent_vivado.infra.memory_queue import pending_count as mem_pending

        return mem_pending(pool, group=group)
    from edagent_vivado.infra.redis_client import get_redis

    r = get_redis()
    try:
        info = r.xpending(f"synthia:queue:{pool}", group)
        return int(info.get("pending", 0)) if isinstance(info, dict) else 0
    except Exception:
        return 0


def queue_depth(pool: str) -> int:
    if _use_memory():
        from edagent_vivado.infra.memory_queue import queue_depth as mem_depth

        return mem_depth(pool)
    from edagent_vivado.infra.redis_client import get_redis

    try:
        return int(get_redis().xlen(f"synthia:queue:{pool}"))
    except Exception:
        return 0
