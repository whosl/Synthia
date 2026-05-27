"""Run scheduler — enqueue runs for workers — Phase 11."""

from __future__ import annotations

import json
import logging
from typing import Any

from edagent_vivado.infra.queue import enqueue, queue_depth
from edagent_vivado.repository.store import run_update

logger = logging.getLogger(__name__)

_FLOW_ROUTING = {
    "vivado_synth_only": {"worker_pool": "vivado", "license_pool": "vivado"},
    "vivado_synth_impl": {"worker_pool": "vivado", "license_pool": "vivado"},
    "vivado_full_flow": {"worker_pool": "vivado", "license_pool": "vivado"},
}


def worker_queue_enabled() -> bool:
    import os

    from edagent_vivado.infra.redis_client import redis_available

    flag = os.environ.get("SYNTHIA_USE_WORKER_QUEUE", "").lower() in ("1", "true", "yes")
    if os.environ.get("SYNTHIA_QUEUE_BACKEND", "").lower() == "memory":
        return flag
    return flag and redis_available()


def submit_run(
    run_id: str,
    flow_name: str,
    inputs: dict[str, Any],
    *,
    session_id: str = "",
    task_id: str = "",
    priority: int = 5,
) -> str:
    routing = _FLOW_ROUTING.get(flow_name, {"worker_pool": "default", "license_pool": ""})
    payload = {
        "kind": "run",
        "run_id": run_id,
        "flow_name": flow_name,
        "inputs": inputs,
        "session_id": session_id,
        "task_id": task_id,
        "license_pool": routing.get("license_pool", ""),
    }
    run_update(
        run_id,
        state="queued",
        metadata_json=json.dumps(
            {
                "flow_name": flow_name,
                "inputs": inputs,
                "worker_pool": routing["worker_pool"],
                "license_pool": routing.get("license_pool", ""),
            },
            ensure_ascii=False,
        ),
    )
    entry_id = enqueue(routing["worker_pool"], payload, priority=priority, task_id=run_id)
    logger.info("submitted run %s to pool=%s (entry=%s)", run_id, routing["worker_pool"], entry_id)
    return entry_id


def get_pool_status() -> dict[str, Any]:
    from edagent_vivado.scheduler.license_pool import configured_pools, pool_status

    pools = configured_pools()
    return {
        "license_pools": {name: pool_status(name) for name in pools},
        "queue_depth": {
            "vivado": queue_depth("vivado"),
            "default": queue_depth("default"),
        },
        "worker_queue_enabled": worker_queue_enabled(),
    }
