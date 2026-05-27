"""Phase 11 — task queue and license pool (memory backend)."""

from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def memory_backends(monkeypatch):
    monkeypatch.setenv("SYNTHIA_QUEUE_BACKEND", "memory")
    monkeypatch.setenv("SYNTHIA_LICENSE_BACKEND", "local")
    from edagent_vivado.infra.memory_queue import reset_queues

    reset_queues()
    yield
    reset_queues()


def test_enqueue_dequeue_ack():
    from edagent_vivado.infra.queue import ack, dequeue, enqueue

    eid = enqueue("test_pool", {"foo": "bar"})
    assert eid
    tasks = dequeue("test_pool", consumer_name="t1", block_ms=100)
    assert len(tasks) == 1
    entry_id, payload = tasks[0]
    assert payload["foo"] == "bar"
    ack("test_pool", entry_id)


def test_license_pool_local():
    from edagent_vivado.scheduler.license_pool import (
        acquire_license,
        init_pool,
        pool_status,
        release_license,
    )

    init_pool("test_lic", 2)
    h1 = acquire_license("test_lic")
    h2 = acquire_license("test_lic")
    h3 = acquire_license("test_lic", wait_s=0)
    assert h1 and h2
    assert h3 is None
    st = pool_status("test_lic")
    assert st["used"] == 2 and st["capacity"] == 2
    release_license("test_lic", h1)
    h4 = acquire_license("test_lic")
    assert h4
    release_license("test_lic", h2)
    release_license("test_lic", h4)


def test_worker_queue_enabled_memory(monkeypatch):
    monkeypatch.setenv("SYNTHIA_USE_WORKER_QUEUE", "1")
    from edagent_vivado.scheduler.scheduler import worker_queue_enabled

    assert worker_queue_enabled()
