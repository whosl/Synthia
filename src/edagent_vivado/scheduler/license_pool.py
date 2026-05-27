"""License pool — Redis semaphore or in-process counters — Phase 11."""

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from typing import Any

logger = logging.getLogger(__name__)

_local_caps: dict[str, int] = {}
_local_used: dict[str, int] = {}
_local_holders: dict[str, dict[str, float]] = {}
_local_mu = threading.Lock()


def configured_pools() -> dict[str, int]:
    raw = os.environ.get("SYNTHIA_LICENSE_POOLS", "vivado:1")
    out: dict[str, int] = {}
    for chunk in raw.split(","):
        if ":" not in chunk:
            continue
        name, n = chunk.split(":", 1)
        out[name.strip()] = int(n.strip())
    return out


def _use_local() -> bool:
    if os.environ.get("SYNTHIA_LICENSE_BACKEND", "").lower() == "local":
        return True
    from edagent_vivado.infra.redis_client import redis_available

    return not redis_available()


def init_pool(name: str, capacity: int) -> None:
    if _use_local():
        with _local_mu:
            prev = _local_caps.get(name, 0)
            _local_caps[name] = max(prev, capacity)
            _local_used.setdefault(name, 0)
            _local_holders.setdefault(name, {})
        return
    from edagent_vivado.infra.redis_client import get_redis

    get_redis().set(f"synthia:license:cap:{name}", capacity)


def acquire_license(name: str, *, holder: str = "", wait_s: int = 0) -> str | None:
    holder = holder or str(uuid.uuid4())
    default_cap = configured_pools().get(name, 1)
    init_pool(name, default_cap)
    if _use_local():
        with _local_mu:
            cap = _local_caps.get(name, default_cap)
    else:
        cap = default_cap

    if _use_local():
        deadline = time.time() + max(0, wait_s)
        while True:
            with _local_mu:
                used = _local_used.get(name, 0)
                if used < cap:
                    _local_used[name] = used + 1
                    _local_holders.setdefault(name, {})[holder] = time.time()
                    return holder
            if time.time() >= deadline:
                return None
            time.sleep(0.2)

    from edagent_vivado.infra.redis_client import get_redis

    r = get_redis()
    deadline = time.time() + max(0, wait_s)
    while True:
        used_key = f"synthia:license:used:{name}"
        try:
            with r.pipeline() as pipe:
                pipe.watch(used_key)
                current = int(pipe.get(used_key) or 0)
                if current >= cap:
                    pipe.unwatch()
                    if time.time() >= deadline:
                        return None
                    time.sleep(1.0)
                    continue
                pipe.multi()
                pipe.incr(used_key, 1)
                pipe.zadd(f"synthia:license:holders:{name}", {holder: int(time.time() * 1000)})
                pipe.execute()
                return holder
        except Exception:
            if time.time() >= deadline:
                return None
            time.sleep(0.2)


def release_license(name: str, holder: str) -> None:
    if _use_local():
        with _local_mu:
            holders = _local_holders.get(name, {})
            if holder not in holders:
                return
            del holders[holder]
            _local_used[name] = max(0, _local_used.get(name, 1) - 1)
        return

    from edagent_vivado.infra.redis_client import get_redis

    r = get_redis()
    if r.zscore(f"synthia:license:holders:{name}", holder) is None:
        return
    with r.pipeline() as pipe:
        pipe.decr(f"synthia:license:used:{name}")
        pipe.zrem(f"synthia:license:holders:{name}", holder)
        pipe.execute()


def cleanup_stale(name: str, *, max_age_s: int = 7200) -> int:
    if _use_local():
        cutoff = time.time() - max_age_s
        released = 0
        with _local_mu:
            for h, ts in list(_local_holders.get(name, {}).items()):
                if ts < cutoff:
                    release_license(name, h)
                    released += 1
        return released

    from edagent_vivado.infra.redis_client import get_redis

    r = get_redis()
    cutoff = int((time.time() - max_age_s) * 1000)
    holders = r.zrangebyscore(f"synthia:license:holders:{name}", 0, cutoff)
    for h in holders:
        release_license(name, str(h))
    return len(holders)


def pool_status(name: str) -> dict[str, Any]:
    cap = configured_pools().get(name, 1)
    if _use_local():
        with _local_mu:
            cap = _local_caps.get(name, cap)
            used = _local_used.get(name, 0)
        return {"name": name, "capacity": cap, "used": used, "available": max(0, cap - used)}

    from edagent_vivado.infra.redis_client import get_redis

    r = get_redis()
    cap = int(r.get(f"synthia:license:cap:{name}") or cap)
    used = int(r.get(f"synthia:license:used:{name}") or 0)
    return {"name": name, "capacity": cap, "used": used, "available": max(0, cap - used)}
