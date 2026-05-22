"""Batch runner — execute Vivado flows across multiple manifests in parallel or series."""

from __future__ import annotations

import concurrent.futures
import json
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from edagent_vivado.harness.manifest import Manifest
from edagent_vivado.harness.vivado_runner import VivadoRunner
from edagent_vivado.harness.workspace import Workspace

logger = logging.getLogger(__name__)


@dataclass
class BatchJob:
    manifest_path: Path
    task: str  # "synth", "impl", "sim"
    status: str = "pending"
    result: dict[str, Any] | None = None
    error: str | None = None
    elapsed_sec: float = 0.0


@dataclass
class BatchResult:
    jobs: list[BatchJob] = field(default_factory=list)
    total: int = 0
    succeeded: int = 0
    failed: int = 0
    elapsed_sec: float = 0.0


class BatchRunner:
    """Run Vivado flows across multiple project manifests.

    Supports sequential and parallel (ThreadPoolExecutor) execution modes.

    Usage::

        runner = BatchRunner(max_workers=4)
        result = runner.run_all([
            ("proj_a/eda.yaml", "synth"),
            ("proj_b/eda.yaml", "synth"),
            ("proj_c/eda.yaml", "impl"),
        ])
    """

    def __init__(
        self,
        max_workers: int = 1,
        force_mock: bool = False,
        vivado_path: str | None = None,
        progress_callback: Callable[[BatchJob], None] | None = None,
    ) -> None:
        self._max_workers = max_workers
        self._force_mock = force_mock
        self._vivado_path = vivado_path
        self._on_progress = progress_callback

    def run_all(self, jobs_spec: list[tuple[str, str]]) -> BatchResult:
        """Execute a list of (manifest_path, task) jobs.

        Args:
            jobs_spec: List of (manifest_path, task) tuples.
                       task must be one of "synth", "impl", "sim".

        Returns:
            BatchResult with per-job status and aggregate statistics.
        """
        batch = BatchResult()
        t0 = time.time()

        jobs = [
            BatchJob(manifest_path=Path(p), task=task)
            for p, task in jobs_spec
        ]

        if self._max_workers <= 1:
            for job in jobs:
                self._run_one(job)
                self._collect(batch, job)
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=self._max_workers) as pool:
                futures = {pool.submit(self._run_one, job): job for job in jobs}
                for future in concurrent.futures.as_completed(futures):
                    job = futures[future]
                    try:
                        future.result()
                    except Exception as e:
                        job.status = "error"
                        job.error = str(e)
                    self._collect(batch, job)

        batch.elapsed_sec = round(time.time() - t0, 2)
        batch.total = len(jobs)
        return batch

    def _run_one(self, job: BatchJob) -> None:
        t0 = time.time()
        try:
            manifest = Manifest.load(job.manifest_path)
            ws = Workspace(
                base_dir=job.manifest_path.parent,
                task_name=f"batch_{job.task}",
            )
            ws.copy_sources(manifest)
            ws.write_manifest(manifest)

            runner = VivadoRunner(
                workspace=ws,
                manifest=manifest,
                vivado_path=self._vivado_path,
                force_mock=self._force_mock,
            )

            if job.task == "synth":
                job.result = runner.run_synth()
            elif job.task == "impl":
                job.result = runner.run_impl()
            elif job.task == "sim":
                job.result = runner.run_simulation()
            else:
                job.status = "error"
                job.error = f"Unknown task: {job.task}"
                return

            job.result["workspace"] = str(ws.root)
            job.status = "succeeded" if job.result.get("success") else "failed"
        except Exception as e:
            job.status = "error"
            job.error = str(e)
        job.elapsed_sec = round(time.time() - t0, 2)

        if self._on_progress:
            self._on_progress(job)

    def _collect(self, batch: BatchResult, job: BatchJob) -> None:
        batch.jobs.append(job)
        if job.status == "succeeded":
            batch.succeeded += 1
        else:
            batch.failed += 1

    @staticmethod
    def save_report(batch: BatchResult, path: str | Path) -> Path:
        """Save a batch result as JSON."""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        data = {
            "total": batch.total,
            "succeeded": batch.succeeded,
            "failed": batch.failed,
            "elapsed_sec": batch.elapsed_sec,
            "jobs": [
                {
                    "manifest": str(j.manifest_path),
                    "task": j.task,
                    "status": j.status,
                    "elapsed_sec": j.elapsed_sec,
                    "error": j.error,
                }
                for j in batch.jobs
            ],
        }
        with open(p, "w") as f:
            json.dump(data, f, indent=2, default=str)
        return p
