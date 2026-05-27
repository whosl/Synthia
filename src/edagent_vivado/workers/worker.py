"""Synthia worker process — Phase 11."""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
import threading
import time

from edagent_vivado.infra.queue import ack, dequeue, enqueue
from edagent_vivado.repository.db import init_db
from edagent_vivado.repository.store import run_update
from edagent_vivado.runs.orchestrator import start_run
from edagent_vivado.scheduler.license_pool import acquire_license, cleanup_stale, configured_pools, release_license

logger = logging.getLogger("synthia.worker")
_shutdown = threading.Event()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="synthia-worker")
    parser.add_argument("--pool", default=os.environ.get("SYNTHIA_WORKER_POOL", "vivado"))
    parser.add_argument(
        "--name",
        default=os.environ.get("SYNTHIA_WORKER_NAME", f"{socket.gethostname()}-{os.getpid()}"),
    )
    parser.add_argument("--license-wait-s", type=int, default=3600)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    init_db()
    logger.info("worker starting pool=%s name=%s", args.pool, args.name)

    signal.signal(signal.SIGTERM, _signal_shutdown)
    signal.signal(signal.SIGINT, _signal_shutdown)
    _start_janitor()

    while not _shutdown.is_set():
        try:
            tasks = dequeue(args.pool, consumer_name=args.name, block_ms=5000, count=1)
        except Exception:
            logger.exception("dequeue failed; sleeping 5s")
            time.sleep(5)
            continue

        for entry_id, payload in tasks:
            if _shutdown.is_set():
                break
            try:
                _execute_task(payload, args)
            except Exception:
                logger.exception("task %s failed", payload.get("__task_id"))
                run_id = payload.get("run_id", "")
                if run_id:
                    try:
                        run_update(run_id, state="failed", error="worker exception (see logs)")
                    except Exception:
                        pass
            finally:
                ack(args.pool, entry_id)

    logger.info("worker shutting down")
    return 0


def _execute_task(payload: dict, args) -> None:
    if payload.get("kind") != "run":
        logger.warning("unknown task kind=%s", payload.get("kind"))
        return

    run_id = payload["run_id"]
    flow_name = payload["flow_name"]
    inputs = payload.get("inputs", {})
    session_id = payload.get("session_id", "")
    task_id = payload.get("task_id", "")
    license_pool = payload.get("license_pool", "")

    holder = None
    if license_pool:
        run_update(run_id, state="queued", error=f"waiting for {license_pool} license")
        holder = acquire_license(license_pool, holder=run_id, wait_s=args.license_wait_s)
        if holder is None:
            logger.warning("run %s could not acquire %s license; requeueing", run_id, license_pool)
            enqueue(args.pool, payload, task_id=run_id)
            return

    try:
        logger.info("worker running %s (flow=%s)", run_id, flow_name)
        start_run(
            run_id,
            flow_name=flow_name,
            inputs=inputs,
            session_id=session_id,
            task_id=task_id,
        )
    finally:
        if license_pool and holder:
            release_license(license_pool, holder)


def _signal_shutdown(signum, frame) -> None:
    del frame
    logger.info("received signal %s; finishing current task", signum)
    _shutdown.set()


def _start_janitor() -> None:
    def _loop() -> None:
        while not _shutdown.is_set():
            try:
                for pname in configured_pools():
                    n = cleanup_stale(pname, max_age_s=7200)
                    if n:
                        logger.warning("janitor released %d stale licenses on %s", n, pname)
            except Exception:
                logger.exception("janitor failed (non-fatal)")
            _shutdown.wait(300)

    threading.Thread(target=_loop, daemon=True, name="license-janitor").start()


if __name__ == "__main__":
    sys.exit(main())
